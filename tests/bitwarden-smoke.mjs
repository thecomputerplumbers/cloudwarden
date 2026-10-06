import assert from "node:assert/strict"
import { createHmac } from "node:crypto"

const origin = process.argv[2]
assert.ok(origin?.startsWith("http://localhost:"))

async function call(path, options = {}) {
  const response = await fetch(`${origin}${path}`, options)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

function post(path, body, token) {
  return call(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

const config = await call("/api/config")
assert.equal(config.status, 200)
assert.equal(config.body.environment.identity, `${origin}/identity`)
assert.equal(config.body.settings.disableUserRegistration, false)

const email = `vault-${crypto.randomUUID()}@example.test`
const registration = await post("/identity/accounts/register", {
  email,
  name: "Vault Test",
  masterPasswordHash: "client-derived-secret",
  key: "2.encrypted-user-key",
  keys: {
    encryptedPrivateKey: "2.encrypted-private-key",
    publicKey: "public-key",
  },
  kdf: 0,
  kdfIterations: 600_000,
})
assert.equal(registration.status, 200)

const prelogin = await post("/identity/accounts/prelogin", { email })
assert.equal(prelogin.status, 200)
assert.equal(prelogin.body.kdfIterations, 600_000)

const tokenRequest = (username, password, secondFactor = {}) =>
  fetch(`${origin}/identity/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "web",
      scope: "api offline_access",
      username,
      password,
      deviceIdentifier: crypto.randomUUID(),
      deviceName: "Smoke test",
      deviceType: "14",
      ...secondFactor,
    }),
  })

assert.equal((await tokenRequest(email, "wrong")).status, 400)
const login = await tokenRequest(email, "client-derived-secret")
assert.equal(login.status, 200)
const tokens = await login.json()
assert.ok(tokens.access_token)
assert.ok(tokens.refresh_token)
assert.equal(
  tokens.AccountKeys.publicKeyEncryptionKeyPair.wrappedPrivateKey,
  "2.encrypted-private-key"
)
assert.equal(tokens.access_token.split(".").length, 3)

assert.equal((await call("/api/sync")).status, 401)
const authorized = (path, method = "GET", body) =>
  call(path, {
    method,
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

const createdFolder = await authorized("/api/folders", "POST", {
  name: "2.encrypted-folder-name",
})
assert.equal(createdFolder.status, 200)

const createdCipher = await authorized("/api/ciphers", "POST", {
  type: 1,
  name: "2.encrypted-cipher-name",
  folderId: createdFolder.body.id,
  login: { username: "2.encrypted-login" },
})
assert.equal(createdCipher.status, 200)
const cipherId = createdCipher.body.id

const sync = await authorized("/api/sync")
assert.equal(sync.status, 200)
assert.equal(sync.body.profile.email, email)
assert.equal(sync.body.folders[0].id, createdFolder.body.id)
assert.equal(sync.body.ciphers[0].id, cipherId)
assert.equal(sync.body.ciphers[0].login.username, "2.encrypted-login")

const attachmentInit = await authorized(
  `/api/ciphers/${cipherId}/attachment/v2`,
  "POST",
  { fileName: "2.encrypted-file-name", fileSize: 4, key: "2.encrypted-key" }
)
assert.equal(attachmentInit.status, 200)
const attachmentId = attachmentInit.body.attachmentId
const upload = new FormData()
upload.append("data", new File([new Uint8Array([1, 2, 3, 4])], "encrypted.bin"))
const uploaded = await fetch(`${origin}/api${attachmentInit.body.url}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${tokens.access_token}` },
  body: upload,
})
assert.equal(uploaded.status, 204)
const attachedCipher = await authorized(`/api/ciphers/${cipherId}`)
assert.equal(attachedCipher.body.attachments[0].id, attachmentId)
const download = await fetch(attachedCipher.body.attachments[0].url)
assert.equal(download.status, 200)
assert.deepEqual(
  new Uint8Array(await download.arrayBuffer()),
  new Uint8Array([1, 2, 3, 4])
)
assert.equal(
  (
    await fetch(
      `${origin}/attachments/${cipherId}/${attachmentId}?token=invalid`
    )
  ).status,
  404
)

const updatedCipher = await authorized(`/api/ciphers/${cipherId}`, "PUT", {
  type: 1,
  name: "2.updated-name",
  folderId: createdFolder.body.id,
  lastKnownRevisionDate: createdCipher.body.revisionDate,
})
assert.equal(updatedCipher.status, 200)
assert.equal(
  (
    await authorized(`/api/ciphers/${cipherId}`, "PUT", {
      type: 1,
      name: "2.stale-name",
      lastKnownRevisionDate: "2020-01-01T00:00:00.000Z",
    })
  ).status,
  409
)
assert.equal(
  (await authorized(`/api/folders/${createdFolder.body.id}`, "DELETE")).status,
  204
)
assert.equal((await authorized(`/api/ciphers/${cipherId}`)).body.folderId, null)
assert.equal(
  (await authorized(`/api/ciphers/${cipherId}`, "DELETE")).status,
  204
)
assert.ok((await authorized(`/api/ciphers/${cipherId}`)).body.deletedDate)
assert.equal(
  (await authorized(`/api/ciphers/${cipherId}/restore`, "PUT")).status,
  200
)
assert.equal(
  (await authorized(`/api/ciphers/${cipherId}`)).body.deletedDate,
  null
)
assert.equal(
  (
    await authorized(
      `/api/ciphers/${cipherId}/attachment/${attachmentId}`,
      "DELETE"
    )
  ).status,
  200
)
assert.equal((await fetch(attachedCipher.body.attachments[0].url)).status, 404)
assert.match((await authorized("/api/accounts/revision-date")).body, /^20/)

const refreshed = await fetch(`${origin}/identity/connect/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  }),
})
assert.equal(refreshed.status, 200)
assert.equal(
  (
    await fetch(`${origin}/identity/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      }),
    })
  ).status,
  400
)

const otherEmail = `vault-${crypto.randomUUID()}@example.test`
assert.equal(
  (
    await post("/identity/accounts/register", {
      email: otherEmail,
      masterPasswordHash: "second-secret",
      key: "2.other-key",
      kdf: 0,
      kdfIterations: 600_000,
    })
  ).status,
  200
)
const otherLogin = await tokenRequest(otherEmail, "second-secret")
const otherTokens = await otherLogin.json()
const otherSync = await call("/api/sync", {
  headers: { Authorization: `Bearer ${otherTokens.access_token}` },
})
assert.deepEqual(otherSync.body.ciphers, [])
assert.deepEqual(otherSync.body.folders, [])

const otherAuthorized = (path, body, method = "POST") =>
  call(path, {
    method,
    headers: {
      Authorization: `Bearer ${otherTokens.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

function totp(secret, step) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = 0
  let value = 0
  const bytes = []
  for (const letter of secret) {
    value = (value << 5) | alphabet.indexOf(letter)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest()
  const offset = digest.at(-1) & 15
  const truncated = digest.readUInt32BE(offset) & 0x7fffffff
  return String(truncated % 1_000_000).padStart(6, "0")
}

assert.equal(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1), "287082")
assert.equal(
  (
    await otherAuthorized("/api/two-factor/get-authenticator", {
      masterPasswordHash: "wrong",
    })
  ).status,
  403
)
const secondSession = await tokenRequest(otherEmail, "second-secret")
assert.equal(secondSession.status, 200)
const secondTokens = await secondSession.json()
const enrollment = await otherAuthorized("/api/two-factor/get-authenticator", {
  masterPasswordHash: "second-secret",
})
assert.equal(enrollment.status, 200)
assert.match(enrollment.body.key, /^[A-Z2-7]{32}$/)
const step = Math.floor(Date.now() / 30_000)
const activated = await otherAuthorized("/api/two-factor/authenticator", {
  masterPasswordHash: "second-secret",
  key: enrollment.body.key,
  token: totp(enrollment.body.key, step - 1),
})
assert.equal(activated.status, 200)
assert.equal(
  (
    await call("/api/sync", {
      headers: { Authorization: `Bearer ${secondTokens.access_token}` },
    })
  ).status,
  401
)
assert.equal(
  (await otherAuthorized("/api/two-factor", undefined, "GET")).body.data[0]
    .type,
  0
)
const recovery = await otherAuthorized("/api/two-factor/get-recover", {
  masterPasswordHash: "second-secret",
})
assert.match(recovery.body.code, /^[A-Z2-7]{32}$/)
const challenge = await tokenRequest(otherEmail, "second-secret")
assert.equal(challenge.status, 400)
assert.deepEqual((await challenge.json()).TwoFactorProviders, ["0"])
assert.equal(
  (
    await tokenRequest(otherEmail, "second-secret", {
      two_factor_provider: "0",
      two_factor_token: "000000",
    })
  ).status,
  400
)
const otpLogin = await tokenRequest(otherEmail, "second-secret", {
  two_factor_provider: "0",
  two_factor_token: totp(enrollment.body.key, step),
})
assert.equal(otpLogin.status, 200)
assert.ok((await otpLogin.json()).access_token)
assert.equal(
  (
    await tokenRequest(otherEmail, "second-secret", {
      two_factor_provider: "0",
      two_factor_token: totp(enrollment.body.key, step),
    })
  ).status,
  400
)
const recovered = await tokenRequest(otherEmail, "second-secret", {
  two_factor_provider: "8",
  two_factor_token: recovery.body.code,
})
assert.equal(recovered.status, 200)
const recoveredTokens = await recovered.json()
const beforeChange = await tokenRequest(otherEmail, "second-secret")
assert.equal(beforeChange.status, 200)
const beforeChangeTokens = await beforeChange.json()

const passwordChange = (authenticationSalt) =>
  call("/api/accounts/password", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${recoveredTokens.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      masterPasswordHash: "second-secret",
      authenticationData: {
        salt: authenticationSalt,
        kdf: { kdfType: 0, iterations: 650_000 },
        masterPasswordAuthenticationHash: "third-secret",
      },
      unlockData: {
        salt: otherEmail,
        kdf: { kdfType: 0, iterations: 650_000 },
        masterKeyWrappedUserKey: "2.new-user-key",
      },
    }),
  })
assert.equal((await passwordChange("wrong@example.test")).status, 400)
assert.equal((await passwordChange(otherEmail)).status, 200)
assert.equal(
  (
    await call("/api/sync", {
      headers: { Authorization: `Bearer ${beforeChangeTokens.access_token}` },
    })
  ).status,
  401
)
assert.equal((await tokenRequest(otherEmail, "second-secret")).status, 400)
assert.equal((await tokenRequest(otherEmail, "third-secret")).status, 200)
const newPrelogin = await post("/identity/accounts/prelogin", {
  email: otherEmail,
})
assert.equal(newPrelogin.body.kdfIterations, 650_000)
const changedProfile = await call("/api/accounts/profile", {
  headers: { Authorization: `Bearer ${recoveredTokens.access_token}` },
})
assert.equal(changedProfile.body.key, "2.new-user-key")

console.log(
  "Bitwarden auth, vault lifecycle, password change, two-factor, and isolation passed"
)
