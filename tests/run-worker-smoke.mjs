import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, openSync, closeSync, rmSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"

// No remote binding or real mail: each run has a fresh, disposable local D1.
const storage = mkdtempSync("/tmp/starter-review.")
const reservation = createServer()
reservation.listen(0, "127.0.0.1")
await once(reservation, "listening")
const port = reservation.address().port
await new Promise((resolve) => reservation.close(resolve))
const origin = `http://localhost:${port}`
const product = JSON.parse(readFileSync("apps/web/config/product.json", "utf8"))
const log = openSync(`${storage}/worker.log`, "w")
let worker
let passed = false
try {
  const migration = spawnSync(
    "pnpm",
    [
      "--filter",
      "web",
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--persist-to",
      storage,
    ],
    { stdio: ["ignore", log, log] }
  )
  if (migration.status !== 0) throw new Error("Local migrations failed")
  const workerArgs = [
    "--filter",
    "web",
    "exec",
    "wrangler",
    "dev",
    "--config",
    "dist/server/wrangler.json",
    "--port",
    String(port),
    "--var",
    `APP_URL:${origin}`,
    "--var",
    "SIGNUPS_ALLOWED:true",
    "--var",
    "SIGNUPS_VERIFY:true",
    "--var",
    "ORG_INVITATION_EMAILS_ENABLED:true",
    "--var",
    "EMAIL_2FA_ENABLED:true",
    "--var",
    `EMAIL_FROM:${product.supportEmail}`,
    "--var",
    "SSO_AUTHORITY:https://auth.example.test/api/auth",
    "--var",
    "SSO_CLIENT_ID:tcp-vaultwarden",
    "--var",
    "SSO_CLIENT_SECRET:local-provider-secret",
    "--var",
    "SSO_IDENTIFIER:thecomputerplumbers",
    "--var",
    "SSO_CALLBACK_URL:https://vault.example.test/identity/connect/oidc-signin",
    "--var",
    "BETTER_AUTH_SECRET:local-smoke-only-signing-secret-2026",
    "--persist-to",
    storage,
  ]
  worker = spawn("pnpm", workerArgs, {
    stdio: ["ignore", log, log],
    detached: true,
  })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null)
      throw new Error("Worker exited before startup")
    try {
      if ((await fetch(`${origin}/api/health`)).ok) {
        ready = true
        break
      }
    } catch {
      /* Starting. */
    }
    await delay(100)
  }
  if (!ready) throw new Error("Local Worker did not become healthy")
  if (
    product.features.billing &&
    product.features.mcp &&
    product.features.projects
  ) {
    const test = spawn(
      process.execPath,
      ["tests/worker-smoke.mjs", origin, storage],
      { stdio: "inherit" }
    )
    const [code] = await once(test, "exit")
    if (code !== 0) throw new Error("Worker smoke test failed")
  }
  const vaultTest = spawn(
    process.execPath,
    ["tests/bitwarden-smoke.mjs", origin, storage],
    { stdio: "inherit" }
  )
  const [vaultCode] = await once(vaultTest, "exit")
  if (vaultCode !== 0) throw new Error("Bitwarden API smoke test failed")
  const stopped = once(worker, "exit")
  process.kill(-worker.pid, "SIGTERM")
  await stopped
  const recoveryToken = "local-recovery-test-token-only-2026"
  // Wrangler routes requests through the configured custom hostname even in
  // local dev. Match that origin only for the maintenance Worker test.
  const built = JSON.parse(
    readFileSync("apps/web/dist/server/wrangler.json", "utf8")
  )
  const maintenanceOrigin = `http://${new URL(built.vars.APP_URL).hostname}`
  worker = spawn(
    "pnpm",
    [
      ...workerArgs.map((argument) =>
        argument === `APP_URL:${origin}`
          ? `APP_URL:${maintenanceOrigin}`
          : argument
      ),
      "--var",
      "MAINTENANCE_MODE:true",
      "--var",
      `RECOVERY_TOKEN:${recoveryToken}`,
    ],
    { stdio: ["ignore", log, log], detached: true }
  )
  let maintenance = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null)
      throw new Error("Maintenance Worker exited before startup")
    try {
      const response = await fetch(`${origin}/api/config`)
      if (response.status === 503) {
        const body = await response.json()
        maintenance = body.maintenance === true
        if (maintenance) break
      }
    } catch {
      /* Starting. */
    }
    await delay(100)
  }
  if (!maintenance) throw new Error("Maintenance mode did not block requests")
  const blockedWrite = await fetch(`${origin}/api/accounts/register`, {
    method: "POST",
    body: "{}",
    headers: { "Content-Type": "application/json" },
  })
  if (blockedWrite.status !== 503)
    throw new Error("Maintenance mode did not block vault writes")
  const recoveryUrl = `${origin}/__ops/recovery/inspect`
  const recoveryTarget = JSON.stringify({
    kind: "account",
    id: "11111111-1111-1111-1111-111111111111",
    at: new Date(Date.now() - 60_000).toISOString(),
  })
  const unauthenticated = await fetch(recoveryUrl, {
    method: "POST",
    body: recoveryTarget,
  })
  const wrongToken = await fetch(recoveryUrl, {
    method: "POST",
    headers: { Authorization: "Bearer wrong-token" },
    body: recoveryTarget,
  })
  const invalidTarget = await fetch(recoveryUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${recoveryToken}` },
    body: JSON.stringify({ kind: "wrong", id: "wrong", at: "wrong" }),
  })
  const missingTarget = await fetch(recoveryUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${recoveryToken}` },
    body: recoveryTarget,
  })
  if (
    unauthenticated.status !== 404 ||
    wrongToken.status !== 404 ||
    invalidTarget.status !== 400 ||
    missingTarget.status !== 404
  )
    throw new Error(
      `Recovery operator gate failed: ${unauthenticated.status}, ${wrongToken.status}, ${invalidTarget.status}, ${missingTarget.status}`
    )
  console.log("Maintenance mode blocked vault reads and writes")
  console.log("Recovery operator endpoint rejected unauthenticated requests")
  passed = true
} finally {
  if (worker?.pid) {
    try {
      process.kill(-worker.pid, "SIGTERM")
    } catch {
      /* Already exited. */
    }
    if (worker.exitCode === null) await once(worker, "exit")
  }
  closeSync(log)
  if (passed) rmSync(storage, { recursive: true, force: true })
  else console.error(`Local diagnostics retained at ${storage}`)
}
