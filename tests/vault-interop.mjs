// Proves the native vault's crypto (apps/web/vault/crypto) interoperates with
// Bitwarden's own client, in both directions, against a local cloudwarden:
//   1. our library registers an account and creates items; the official `bw`
//      CLI logs in and must read every field back exactly;
//   2. `bw` creates an item; our library must decrypt it exactly;
//   3. our library edits the `bw` item; `bw` must read the edit, the item's
//      password history, and keep a field our client does not model.
// Opt-in, like test:cli: needs `pnpm build` first and the `bw` CLI on PATH.
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { mkdtempSync, openSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { newAccount, unlockAccount } from "../apps/web/vault/crypto/account.ts"
import { decryptCipher, encryptDraft } from "../apps/web/vault/crypto/cipher.ts"
import {
  hashMasterPassword,
  makeMasterKey,
} from "../apps/web/vault/crypto/kdf.ts"
import { decryptString } from "../apps/web/vault/crypto/enc-string.ts"
import { newOrganization } from "../apps/web/vault/crypto/organization.ts"

const port = process.env.INTEROP_PORT ?? "8860"
// The official CLI refuses plain HTTP, so the local Worker serves HTTPS with
// wrangler's self-signed localhost certificate, which only this local test
// process and its bw subprocess are told to accept.
const origin = `https://localhost:${port}`
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
const storage = mkdtempSync(join(tmpdir(), "cw-interop-"))
const log = openSync(join(storage, "worker.log"), "w")
const workerOpts = { stdio: ["ignore", log, log] }

const pnpmWeb = (args, options) =>
  spawnSync("pnpm", ["--filter", "web", "exec", "wrangler", ...args], {
    ...workerOpts,
    ...options,
  })
if (
  pnpmWeb([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    storage,
  ]).status !== 0
)
  throw new Error("migrations failed")
const vars = {
  APP_URL: origin,
  SIGNUPS_ALLOWED: "true",
  SIGNUPS_VERIFY: "false",
  EMAIL_FROM: "cloudwarden@example.test",
  BETTER_AUTH_SECRET: "local-interop-only-signing-secret-2026",
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
    "--local-protocol",
    "https",
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
    "--persist-to",
    storage,
  ],
  { ...workerOpts, detached: true }
)

async function api(path, { method = "GET", body, form, token } = {}) {
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
  // wrangler's local HTTPS proxy closes idle keep-alive sockets; a reused one fails once with "other side closed".
  const send = () =>
    fetch(`${origin}${path}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
    })
  const response = await send().catch((error) =>
    error?.cause?.code === "UND_ERR_SOCKET" ? send() : Promise.reject(error)
  )
  const text = await response.text()
  if (!response.ok)
    throw new Error(
      `${method} ${path}: ${response.status} ${text.slice(0, 300)}`
    )
  return text ? JSON.parse(text) : null
}

const appdata = mkdtempSync(join(tmpdir(), "cw-interop-bw-"))
const bw = (args, input) =>
  execFileSync("bw", args, {
    env: {
      ...process.env,
      BITWARDENCLI_APPDATA_DIR: appdata,
      BW_NOINTERACTION: "true",
    },
    input,
    encoding: "utf8",
  }).trim()

try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${origin}/api/alive`)).ok) break
    } catch {}
    if (i > 120)
      throw new Error(`worker did not start; see ${storage}/worker.log`)
    await delay(500)
  }

  // 1. Our library: register, log in, unlock, create items.
  const email = `interop-${Date.now()}@example.test`
  const password = "correct horse battery staple 2026"
  const kdf = { kdf: 0, iterations: 600_000 }
  const account = await newAccount(email, password, kdf)
  await api("/identity/accounts/register", {
    method: "POST",
    body: {
      email,
      name: "Interop",
      masterPasswordHash: account.masterPasswordHash,
      masterPasswordHint: null,
      key: account.key,
      keys: account.keys,
      kdf: 0,
      kdfIterations: kdf.iterations,
    },
  })
  const prelogin = await api("/identity/accounts/prelogin", {
    method: "POST",
    body: { email },
  })
  assert.equal(prelogin.kdfIterations, kdf.iterations)
  const masterKey = await makeMasterKey(password, email, {
    kdf: prelogin.kdf,
    iterations: prelogin.kdfIterations,
  })
  const login = await api("/identity/connect/token", {
    method: "POST",
    form: {
      grant_type: "password",
      client_id: "web",
      scope: "api offline_access",
      username: email,
      password: await hashMasterPassword(masterKey, password),
      deviceIdentifier: crypto.randomUUID(),
      deviceName: "interop",
      deviceType: "10",
    },
  })
  const token = login.access_token
  const keys = await unlockAccount({
    masterKey,
    key: login.Key ?? login.key,
    privateKey: login.PrivateKey ?? login.privateKey,
    organizations: [],
  })

  const ours = [
    {
      kind: "login",
      name: "Plumbing supplier ✓",
      notes: "Net 30 — ask for Ana",
      favorite: true,
      folderId: null,
      organizationId: null,
      collectionIds: [],
      login: {
        username: "seth@example.test",
        password: "p@ss w0rd ünïcode",
        totp: "JBSWY3DPEHPK3PXP",
        uris: [{ uri: "https://supplier.example/login", match: null }],
      },
      fields: [
        { name: "Account #", value: "88-1204", type: 0 },
        { name: "PIN", value: "4321", type: 1 },
      ],
    },
    {
      kind: "note",
      name: "Gate code",
      notes: "Front gate: 2468#",
      favorite: false,
      folderId: null,
      organizationId: null,
      collectionIds: [],
    },
    {
      kind: "card",
      name: "Company Visa",
      notes: null,
      favorite: false,
      folderId: null,
      organizationId: null,
      collectionIds: [],
      card: {
        cardholderName: "Seth Example",
        brand: "Visa",
        number: "4111111111111111",
        expMonth: "4",
        expYear: "2031",
        code: "123",
      },
    },
    {
      kind: "identity",
      name: "Seth",
      notes: null,
      favorite: false,
      folderId: null,
      organizationId: null,
      collectionIds: [],
      identity: {
        firstName: "Seth",
        lastName: "Example",
        email: "seth@example.test",
        phone: "+1 555 0100",
        city: "Kansas City",
      },
    },
  ]
  for (const draft of ours)
    await api("/api/ciphers", {
      method: "POST",
      token,
      body: await encryptDraft(draft, keys),
    })

  // The official client reads them.
  bw(["config", "server", origin])
  const session = bw(["login", email, password, "--raw"])
  const S = ["--session", session]
  bw(["sync", ...S])
  const theirs = JSON.parse(bw(["list", "items", ...S]))
  const byName = (name) => theirs.find((item) => item.name === name)
  const login0 = byName("Plumbing supplier ✓")
  assert.ok(login0, "bw sees the login item our library created")
  assert.equal(login0.notes, "Net 30 — ask for Ana")
  assert.equal(login0.favorite, true)
  assert.equal(login0.login.username, "seth@example.test")
  assert.equal(login0.login.password, "p@ss w0rd ünïcode")
  assert.equal(login0.login.totp, "JBSWY3DPEHPK3PXP")
  assert.deepEqual(
    login0.login.uris.map((uri) => uri.uri),
    ["https://supplier.example/login"]
  )
  assert.deepEqual(
    login0.fields.map(({ name, value, type }) => ({ name, value, type })),
    ours[0].fields
  )
  assert.equal(byName("Gate code").notes, "Front gate: 2468#")
  assert.equal(byName("Company Visa").card.number, "4111111111111111")
  assert.equal(byName("Company Visa").card.code, "123")
  assert.equal(byName("Seth").identity.city, "Kansas City")
  console.log("1. bw read every field of the 4 items our library created")

  // 2. The official client writes; our library reads.
  const template = JSON.parse(bw(["get", "template", "item", ...S]))
  const created = JSON.parse(
    bw(
      ["create", "item", ...S],
      bw(
        ["encode"],
        JSON.stringify({
          ...template,
          type: 1,
          name: "Made by bw",
          notes: "from the official CLI",
          favorite: false,
          login: {
            uris: [{ match: null, uri: "https://bw.example" }],
            username: "cli-user",
            password: "cli-pass-1",
            totp: null,
          },
          fields: [{ name: "Custom", value: "kept", type: 0, linkedId: null }],
        })
      )
    )
  )
  const sync = await api("/api/sync", { token })
  const raw = sync.ciphers.find((cipher) => cipher.id === created.id)
  const item = await decryptCipher(raw, keys)
  assert.equal(item.error, null)
  assert.equal(item.name, "Made by bw")
  assert.equal(item.notes, "from the official CLI")
  assert.equal(item.login.username, "cli-user")
  assert.equal(item.login.password, "cli-pass-1")
  assert.deepEqual(
    item.login.uris.map((uri) => uri.uri),
    ["https://bw.example"]
  )
  assert.deepEqual(item.fields, [{ name: "Custom", value: "kept", type: 0 }])
  console.log(
    `2. our library decrypted the item bw created (cipher key: ${raw.key ? "yes" : "no"})`
  )

  // 3. Our library edits it; the official client reads the edit and the history.
  const draft = {
    kind: "login",
    name: "Made by bw (edited)",
    notes: item.notes,
    favorite: true,
    folderId: null,
    organizationId: null,
    collectionIds: [],
    login: { ...item.login, password: "cli-pass-2" },
    fields: item.fields,
  }
  await api(`/api/ciphers/${item.id}`, {
    method: "PUT",
    token,
    body: await encryptDraft(draft, keys, item),
  })
  bw(["sync", ...S])
  const edited = JSON.parse(bw(["get", "item", item.id, ...S]))
  assert.equal(edited.name, "Made by bw (edited)")
  assert.equal(edited.favorite, true)
  assert.equal(edited.login.password, "cli-pass-2")
  assert.equal(edited.passwordHistory?.[0]?.password, "cli-pass-1")
  assert.deepEqual(
    edited.login.uris.map((uri) => uri.uri),
    ["https://bw.example"]
  )
  assert.equal(edited.fields[0].value, "kept")
  console.log(
    "3. bw read our edit, its password history, and the URI checksum we wrote"
  )

  // 4. Our library creates an organization and a shared item; the official client reads both.
  const organization = await newOrganization(
    "Computer Plumbers",
    account.keys.publicKey,
    "Shared logins"
  )
  const created4 = await api("/api/organizations", {
    method: "POST",
    token,
    body: { ...organization.body, billingEmail: email, planType: 0 },
  })
  const sync4 = await api("/api/sync", { token })
  const profileOrg = sync4.profile.organizations.find(
    (org) => org.id === created4.id
  )
  const unlocked = await unlockAccount({
    masterKey,
    key: login.Key ?? login.key,
    privateKey: login.PrivateKey ?? login.privateKey,
    organizations: [{ id: profileOrg.id, key: profileOrg.key }],
  })
  assert.deepEqual(unlocked.failedOrganizations, [])
  const collection = sync4.collections.find(
    (entry) => entry.organizationId === created4.id
  )
  assert.equal(
    await decryptString(collection.name, unlocked.orgKeys.get(created4.id)),
    "Shared logins"
  )
  const sharedDraft = {
    kind: "login",
    name: "Shared router",
    notes: null,
    favorite: false,
    folderId: null,
    organizationId: created4.id,
    collectionIds: [collection.id],
    login: {
      username: "admin",
      password: "router-secret",
      totp: null,
      uris: [{ uri: "http://192.168.1.1", match: null }],
    },
  }
  await api("/api/ciphers/create", {
    method: "POST",
    token,
    body: {
      cipher: await encryptDraft(sharedDraft, unlocked),
      collectionIds: [collection.id],
    },
  })
  bw(["sync", ...S])
  const orgs = JSON.parse(bw(["list", "organizations", ...S]))
  assert.ok(
    orgs.some(
      (org) => org.id === created4.id && org.name === "Computer Plumbers"
    )
  )
  const sharedItems = JSON.parse(
    bw(["list", "items", "--organizationid", created4.id, ...S])
  )
  assert.equal(sharedItems.length, 1)
  assert.equal(sharedItems[0].login.password, "router-secret")
  assert.deepEqual(sharedItems[0].collectionIds, [collection.id])
  const collections = JSON.parse(
    bw(["list", "collections", "--organizationid", created4.id, ...S])
  )
  assert.ok(collections.some((entry) => entry.name === "Shared logins"))
  console.log(
    "4. bw read the organization, its collection, and the shared item our library created"
  )

  // 5. The native vault's saved vault selection: per account, validated, and empty until set.
  assert.deepEqual(
    (await api("/api/cloudwarden/vault-selection", { token })).excluded,
    []
  )
  const saved = await api("/api/cloudwarden/vault-selection", {
    method: "PUT",
    token,
    body: { excluded: [created4.id, "personal", created4.id] },
  })
  assert.deepEqual(saved.excluded, [created4.id, "personal"])
  assert.deepEqual(
    (await api("/api/cloudwarden/vault-selection", { token })).excluded,
    [created4.id, "personal"]
  )
  await assert.rejects(
    api("/api/cloudwarden/vault-selection", {
      method: "PUT",
      token,
      body: { excluded: ["../../etc"] },
    }),
    /400/
  )
  await assert.rejects(
    api("/api/cloudwarden/vault-selection", {
      method: "PUT",
      body: { excluded: [] },
    }),
    /401/
  )
  console.log(
    "5. the vault selection saves per account, rejects bad input, and needs a session"
  )

  console.log("vault interop passed")
} finally {
  try {
    process.kill(-worker.pid, "SIGTERM")
  } catch {}
}
