// End-to-end test of Secrets Manager (docs/secrets-manager.md) against a local
// cloudwarden: the browser crypto creates everything, a machine token reads it
// back, and access control holds. When SECRETS_READER_BIN is set (or the Go
// reader builds), it also runs the real in-cluster reader against the same
// server. Opt-in like test:cli: needs `pnpm build` first.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, openSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { newAccount, unlockAccount } from "../apps/web/vault/crypto/account.ts"
import {
  decryptString,
  encryptString,
} from "../apps/web/vault/crypto/enc-string.ts"
import {
  hashMasterPassword,
  makeMasterKey,
} from "../apps/web/vault/crypto/kdf.ts"
import { newOrganization } from "../apps/web/vault/crypto/organization.ts"
import {
  createAccessToken,
  openPayload,
  parseAccessToken,
} from "../apps/web/vault/crypto/secrets.ts"

const port = process.env.SM_PORT ?? "8880"
const origin = `http://localhost:${port}`
const storage = mkdtempSync(join(tmpdir(), "cw-sm-"))
const log = openSync(join(storage, "worker.log"), "w")
const workerOpts = { stdio: ["ignore", log, log] }
if (
  spawnSync(
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
    workerOpts
  ).status !== 0
)
  throw new Error("migrations failed")
const vars = {
  APP_URL: origin,
  SIGNUPS_ALLOWED: "true",
  SIGNUPS_VERIFY: "false",
  EMAIL_FROM: "cloudwarden@example.test",
  BETTER_AUTH_SECRET: "local-sm-only-signing-secret-2026-0000",
}
const worker = spawn(
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
    port,
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
    "--persist-to",
    storage,
  ],
  { ...workerOpts, detached: true }
)
const children = [worker]

async function call(
  path,
  { method = "GET", body, form, token, raw = false } = {}
) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  let payload
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded"
    payload = new URLSearchParams(form)
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json"
    payload = JSON.stringify(body)
  }
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  })
  const text = await response.text()
  const json = text ? JSON.parse(text) : null
  if (raw) return { status: response.status, body: json }
  if (!response.ok)
    throw new Error(
      `${method} ${path}: ${response.status} ${text.slice(0, 300)}`
    )
  return json
}

async function signUp(email, password) {
  const kdf = { kdf: 0, iterations: 600_000 }
  const account = await newAccount(email, password, kdf)
  await call("/identity/accounts/register", {
    method: "POST",
    body: {
      email,
      name: email.split("@")[0],
      masterPasswordHash: account.masterPasswordHash,
      masterPasswordHint: null,
      key: account.key,
      keys: account.keys,
      kdf: 0,
      kdfIterations: kdf.iterations,
    },
  })
  const masterKey = await makeMasterKey(password, email, kdf)
  const login = await call("/identity/connect/token", {
    method: "POST",
    form: {
      grant_type: "password",
      client_id: "web",
      scope: "api offline_access",
      username: email,
      password: await hashMasterPassword(masterKey, password),
      deviceIdentifier: crypto.randomUUID(),
      deviceName: "sm-test",
      deviceType: "10",
    },
  })
  return { account, masterKey, login, token: login.access_token }
}

try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${origin}/api/alive`)).ok) break
    } catch {}
    if (i > 120)
      throw new Error(`worker did not start; see ${storage}/worker.log`)
    await delay(500)
  }

  // An owner with an organization.
  const owner = await signUp(
    `sm-owner-${Date.now()}@example.test`,
    "owner master password 2026"
  )
  const org = await newOrganization(
    "Computer Plumbers",
    owner.account.keys.publicKey,
    "Default"
  )
  const orgId = (
    await call("/api/organizations", {
      method: "POST",
      token: owner.token,
      body: { ...org.body, billingEmail: "ops@example.test", planType: 0 },
    })
  ).id
  const sync = await call("/api/sync", { token: owner.token })
  const keys = await unlockAccount({
    masterKey: owner.masterKey,
    key: owner.login.Key,
    privateKey: owner.login.PrivateKey,
    organizations: sync.profile.organizations.map((o) => ({
      id: o.id,
      key: o.key,
    })),
  })
  const orgKey = keys.orgKeys.get(orgId)
  const enc = (text) => encryptString(text, orgKey)
  const base = `/api/cloudwarden/sm/orgs/${orgId}`
  const admin = (path, options = {}) =>
    call(`${base}${path}`, { token: owner.token, ...options })

  // Two projects, secrets in each.
  const production = crypto.randomUUID()
  const staging = crypto.randomUUID()
  await admin("/projects", {
    method: "POST",
    body: { id: production, name: await enc("production") },
  })
  await admin("/projects", {
    method: "POST",
    body: { id: staging, name: await enc("staging") },
  })
  const plain = {
    [production]: {
      DATABASE_URL: "postgres://prod:s3cr3t@postgres-01:5432/app",
      STRIPE_KEY: "sk_live_ünïcode_✓",
    },
    [staging]: { DATABASE_URL: "postgres://staging@postgres-01/app" },
  }
  const ids = {}
  for (const [projectId, secrets] of Object.entries(plain))
    for (const [key, value] of Object.entries(secrets)) {
      const id = crypto.randomUUID()
      ids[`${projectId}:${key}`] = id
      await admin("/secrets", {
        method: "POST",
        body: {
          id,
          projectId,
          key: await enc(key),
          value: await enc(value),
          note: key === "STRIPE_KEY" ? await enc("rotate quarterly") : null,
        },
      })
    }
  // A retried create is the same object, not a second one.
  const retryId = ids[`${production}:DATABASE_URL`]
  await admin("/secrets", {
    method: "POST",
    body: {
      id: retryId,
      projectId: production,
      key: await enc("DATABASE_URL"),
      value: await enc("x"),
      note: null,
    },
  })
  const overview = await admin("")
  assert.equal(overview.projects.length, 2)
  assert.equal(overview.secrets.length, 3)
  assert.equal(
    await decryptString(
      overview.projects.find((p) => p.id === production).name,
      orgKey
    ),
    "production"
  )
  console.log(
    "1. projects and secrets created, encrypted with the organization key; a retried create is idempotent"
  )

  // A machine account that may read production only, and a token for it.
  const machineId = crypto.randomUUID()
  await admin("/machine-accounts", {
    method: "POST",
    body: { id: machineId, name: await enc("k8s momoney-prod") },
  })
  await admin(`/machine-accounts/${machineId}/access`, {
    method: "PUT",
    body: { grants: [{ projectId: production, write: false }] },
  })
  const created = await createAccessToken(orgId, orgKey)
  const tokenRow = await admin(`/machine-accounts/${machineId}/tokens`, {
    method: "POST",
    body: {
      ...created.request,
      name: await enc("external-secrets"),
      expiresAt: null,
    },
  })
  assert.equal(tokenRow.id, created.request.id)
  assert.ok(
    !JSON.stringify(tokenRow).includes(
      parseAccessToken(created.token).clientSecret
    ),
    "the server never returns the client secret"
  )
  console.log(
    `2. machine account granted production only; token ${created.token.slice(0, 12)}… created in the browser`
  )

  // The reader's view: authenticate, open the payload, decrypt what is readable.
  const parsed = parseAccessToken(created.token)
  const auth = await call("/api/cloudwarden/sm/auth", {
    method: "POST",
    body: { tokenId: parsed.tokenId, clientSecret: parsed.clientSecret },
  })
  const opened = await openPayload(auth.encryptedPayload, parsed.keyMaterial)
  assert.equal(opened.organizationId, orgId)
  const readable = (
    await call("/api/cloudwarden/sm/machine/secrets", {
      token: auth.accessToken,
    })
  ).data
  const decrypted = Object.fromEntries(
    await Promise.all(
      readable.map(async (s) => [
        await decryptString(s.key, opened.organizationKey),
        await decryptString(s.value, opened.organizationKey),
      ])
    )
  )
  assert.deepEqual(decrypted, plain[production])
  const projects = (
    await call("/api/cloudwarden/sm/machine/projects", {
      token: auth.accessToken,
    })
  ).data
  assert.deepEqual(
    projects.map((p) => p.id),
    [production]
  )
  const stagingSecret = ids[`${staging}:DATABASE_URL`]
  assert.equal(
    (
      await call(`/api/cloudwarden/sm/machine/secrets/${stagingSecret}`, {
        token: auth.accessToken,
        raw: true,
      })
    ).status,
    404
  )
  console.log(
    "3. the token decrypts exactly the production secrets; staging is invisible to it"
  )

  // Go reader, against the same server and token.
  const reader = process.env.SECRETS_READER_BIN
  if (reader) {
    const readerPort = String(Number(port) + 1)
    const readerToken = "reader-test-token"
    const child = spawn(reader, [], {
      env: {
        ...process.env,
        CLOUDWARDEN_URL: origin,
        CLOUDWARDEN_ACCESS_TOKEN: created.token,
        READER_TOKEN: readerToken,
        LISTEN_ADDR: `127.0.0.1:${readerPort}`,
        CACHE_TTL: "2s",
      },
      stdio: ["ignore", "inherit", "inherit"],
    })
    children.push(child)
    const read = async (path, auth = readerToken) => {
      const response = await fetch(`http://127.0.0.1:${readerPort}${path}`, {
        headers: auth ? { Authorization: `Bearer ${auth}` } : {},
      })
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      }
    }
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${readerPort}/healthz`)).ok) break
      } catch {}
      if (i > 60) throw new Error("the Go reader did not become healthy")
      await delay(250)
    }
    assert.deepEqual((await read("/v1/secrets/DATABASE_URL")).body, {
      value: plain[production].DATABASE_URL,
    })
    assert.deepEqual(
      (await read(`/v1/secrets/by-id/${ids[`${production}:STRIPE_KEY`]}`)).body,
      { value: plain[production].STRIPE_KEY }
    )
    assert.deepEqual(
      (await read(`/v1/projects/${production}`)).body,
      plain[production]
    )
    assert.equal((await read(`/v1/secrets/by-id/${stagingSecret}`)).status, 404)
    assert.equal(
      (await read("/v1/secrets/DATABASE_URL", "wrong-token")).status,
      401
    )
    assert.equal((await read("/v1/secrets/DATABASE_URL", null)).status, 401)
    console.log(
      "4. the Go reader serves the decrypted production secrets to an authorized caller, and nothing else"
    )
  } else console.log("4. skipped: set SECRETS_READER_BIN to test the Go reader")

  // Access control.
  const wrong = await call("/api/cloudwarden/sm/auth", {
    method: "POST",
    raw: true,
    body: { tokenId: parsed.tokenId, clientSecret: "not-the-secret" },
  })
  assert.equal(wrong.status, 401)
  const forged = auth.accessToken.replace(/\.[^.]+$/, ".AAAA")
  assert.equal(
    (
      await call("/api/cloudwarden/sm/machine/secrets", {
        token: forged,
        raw: true,
      })
    ).status,
    401
  )
  const stranger = await signUp(
    `sm-stranger-${Date.now()}@example.test`,
    "stranger master password 2026"
  )
  assert.equal(
    (await call(base, { token: stranger.token, raw: true })).status,
    404,
    "a non-member cannot see that the organization exists"
  )
  assert.equal((await call(base, { raw: true })).status, 401)
  await admin(`/machine-accounts/${machineId}/tokens/${parsed.tokenId}`, {
    method: "DELETE",
  })
  assert.equal(
    (
      await call("/api/cloudwarden/sm/auth", {
        method: "POST",
        raw: true,
        body: { tokenId: parsed.tokenId, clientSecret: parsed.clientSecret },
      })
    ).status,
    401
  )
  assert.equal(
    (
      await call("/api/cloudwarden/sm/machine/secrets", {
        token: auth.accessToken,
        raw: true,
      })
    ).status,
    401,
    "revocation stops an access token already issued"
  )
  assert.equal(
    (await admin(`/projects/${production}`, { method: "DELETE", raw: true }))
      .status,
    409,
    "a project with secrets is not deleted"
  )
  console.log(
    "5. wrong secrets, forged and revoked tokens, strangers, and unauthenticated callers are refused"
  )

  console.log("secrets manager e2e passed")
} finally {
  for (const child of children) {
    try {
      process.kill(child === worker ? -child.pid : child.pid, "SIGTERM")
    } catch {}
  }
}
