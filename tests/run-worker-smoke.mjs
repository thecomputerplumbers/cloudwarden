import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, openSync, closeSync, rmSync } from "node:fs"
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
  worker = spawn(
    "pnpm",
    [
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
      "--persist-to",
      storage,
    ],
    { stdio: ["ignore", log, log], detached: true }
  )
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
  const test = spawn(
    process.execPath,
    ["tests/worker-smoke.mjs", origin, storage],
    { stdio: "inherit" }
  )
  const [code] = await once(test, "exit")
  if (code !== 0) throw new Error("Worker smoke test failed")
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
