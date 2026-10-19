import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import {
  generateKeyPairSync,
  randomBytes,
  pbkdf2Sync,
  createHmac,
  createCipheriv,
} from "node:crypto"
import { mkdtempSync, openSync, closeSync, rmSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { readFileSync } from "node:fs"
import { createServer as createTcpServer } from "node:net"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import { join } from "node:path"

const repo = process.cwd()
const storage = mkdtempSync("/tmp/cw-current-cli-")
const log = openSync(join(storage, "worker.log"), "w")
let worker,
  proxy,
  passed = false
const binary = process.env.BW_CLI_PATH
if (!binary)
  throw new Error("Set BW_CLI_PATH to the Bitwarden CLI JavaScript executable")
const expectedVersion = process.env.BW_CLI_VERSION ?? "2026.10.0"
const actualVersion = spawnSync(process.execPath, [binary, "--version"], {
  encoding: "utf8",
})
assert.equal(
  actualVersion.status,
  0,
  "Could not determine Bitwarden CLI version"
)
assert.equal(
  actualVersion.stdout.trim(),
  expectedVersion,
  "Unexpected Bitwarden CLI version"
)
const cert = join(storage, "cert.pem"),
  key = join(storage, "key.pem")
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    timeout: 120_000,
    cwd: repo,
    stdio: ["ignore", log, log],
    ...options,
  })
  assert.equal(result.status, 0, `${command} failed; see local diagnostics`)
  return result
}
function encrypt(bytes, symmetricKey) {
  const iv = randomBytes(16)
  const cipher = createCipheriv("aes-256-cbc", symmetricKey.subarray(0, 32), iv)
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()])
  const mac = createHmac("sha256", symmetricKey.subarray(32))
    .update(Buffer.concat([iv, encrypted]))
    .digest()
  return `2.${iv.toString("base64")}|${encrypted.toString("base64")}|${mac.toString("base64")}`
}
try {
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ])
  const reservation = createTcpServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const workerPort = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  proxy = createHttpsServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (request, response) => {
      const { host: _host, ...headers } = request.headers
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: workerPort,
          path: request.url,
          method: request.method,
          headers,
        },
        (received) => {
          response.writeHead(received.statusCode, received.headers)
          received.pipe(response)
        }
      )
      upstream.on("error", () => {
        response.writeHead(502)
        response.end()
      })
      request.pipe(upstream)
    }
  )
  proxy.listen(0, "127.0.0.1")
  await once(proxy, "listening")
  const origin = `https://127.0.0.1:${proxy.address().port}`
  run("pnpm", [
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
  ])
  const vars = {
    APP_URL: origin,
    SIGNUPS_ALLOWED: "true",
    SIGNUPS_VERIFY: "false",
    EMAIL_FROM: "cloudwarden@example.test",
    BETTER_AUTH_SECRET: "local-current-cli-only-signing-secret-2026",
    ACCESS_TOKEN_LIFETIME_SECONDS: "900",
  }
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
      String(workerPort),
      ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
      "--persist-to",
      storage,
    ],
    { cwd: repo, detached: true, stdio: ["ignore", log, log] }
  )
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${workerPort}/api/alive`)).ok) break
    } catch {}
    if (i > 120) throw new Error("Local CLI Worker failed to start")
    await delay(250)
  }
  const email = `current-cli-${crypto.randomUUID()}@example.test`
  const password = randomBytes(24).toString("base64url")
  const masterKey = pbkdf2Sync(password, email, 600000, 32, "sha256")
  const stretched = Buffer.concat([
    createHmac("sha256", masterKey).update("enc\x01").digest(),
    createHmac("sha256", masterKey).update("mac\x01").digest(),
  ])
  const userKey = randomBytes(64)
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  })
  const registered = await fetch(
    `http://127.0.0.1:${workerPort}/identity/accounts/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name: "Current CLI test",
        masterPasswordHash: pbkdf2Sync(
          masterKey,
          password,
          1,
          32,
          "sha256"
        ).toString("base64"),
        key: encrypt(userKey, stretched),
        keys: {
          publicKey: keys.publicKey.toString("base64"),
          encryptedPrivateKey: encrypt(keys.privateKey, userKey),
        },
        kdf: 0,
        kdfIterations: 600000,
      }),
    }
  )
  assert.equal(registered.status, 200, "Disposable account registration failed")
  const tested = spawn(process.execPath, ["tests/bitwarden-cli-smoke.mjs"], {
    cwd: repo,
    stdio: "inherit",
    env: {
      ...process.env,
      BW_TEST_SERVER: origin,
      BW_TEST_EMAIL: email,
      BW_TEST_PASSWORD: password,
      BW_CLI_PATH: binary,
      NODE_EXTRA_CA_CERTS: cert,
    },
  })
  const [code] = await once(tested, "exit")
  assert.equal(code, 0, "Current Bitwarden CLI compatibility test failed")
  passed = true
} finally {
  if (worker) {
    const stopped = once(worker, "exit")
    try {
      process.kill(-worker.pid, "SIGTERM")
      await stopped
    } catch {}
  }
  if (proxy) await new Promise((resolve) => proxy.close(resolve))
  closeSync(log)
  if (passed) rmSync(storage, { recursive: true, force: true })
  else console.error(`Local CLI diagnostics retained at ${storage}`)
}
