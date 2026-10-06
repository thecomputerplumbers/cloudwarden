import assert from "node:assert/strict"
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { setTimeout as delay } from "node:timers/promises"

const requireWeb = createRequire(
  new URL("../apps/web/package.json", import.meta.url)
)
const { encodeCBOR } = requireWeb("@levischuck/tiny-cbor")

const origin = process.argv[2]
const storage = process.argv[3]
assert.ok(origin?.startsWith("http://localhost:"))
assert.ok(storage?.startsWith("/tmp/starter-review."))

async function nextSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Notification socket timed out")),
      5_000
    )
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout)
        resolve(new Uint8Array(event.data))
      },
      { once: true }
    )
  })
}

async function notificationSocket(path) {
  const socket = new WebSocket(origin.replace(/^http/, "ws") + path)
  socket.binaryType = "arraybuffer"
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Notification connection timed out")),
      5_000
    )
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true }
    )
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout)
        reject(new Error("Notification connection failed"))
      },
      { once: true }
    )
  })
  const handshake = nextSocketMessage(socket)
  socket.send('{"protocol":"messagepack","version":1}\x1e')
  assert.deepEqual([...(await handshake)], [0x7b, 0x7d, 0x1e])
  return socket
}

function socketClosed(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Notification socket remained open")),
      5_000
    )
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timeout)
        resolve(event.code)
      },
      { once: true }
    )
  })
}

async function noSocketMessage(socket, durationMs = 300) {
  return new Promise((resolve) => {
    const received = () => {
      clearTimeout(timeout)
      resolve(false)
    }
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", received)
      resolve(true)
    }, durationMs)
    socket.addEventListener("message", received, { once: true })
  })
}

function decodeNotificationFrame(bytes) {
  let cursor = 0
  let length = 0
  let shift = 0
  while (true) {
    const part = bytes[cursor++]
    assert.notEqual(part, undefined)
    length |= (part & 0x7f) << shift
    if (!(part & 0x80)) break
    shift += 7
  }
  const end = cursor + length
  const decoder = new TextDecoder()
  const read = () => {
    const marker = bytes[cursor++]
    if (marker === 0xc0) return null
    if (marker === 0xcc) return bytes[cursor++]
    if (marker === 0xd7) {
      assert.equal(bytes[cursor++], 0xff)
      const timestamp = new DataView(
        bytes.buffer,
        bytes.byteOffset + cursor,
        8
      ).getBigUint64(0)
      cursor += 8
      return new Date(
        Number(timestamp & ((1n << 34n) - 1n)) * 1000 +
          Number(timestamp >> 34n) / 1_000_000
      )
    }
    if (marker <= 0x7f) return marker
    if ((marker & 0xf0) === 0x90)
      return Array.from({ length: marker & 0x0f }, read)
    if ((marker & 0xf0) === 0x80) {
      const result = {}
      for (let index = 0; index < (marker & 0x0f); index++)
        result[read()] = read()
      return result
    }
    let size
    if ((marker & 0xe0) === 0xa0) size = marker & 0x1f
    else if (marker === 0xd9) size = bytes[cursor++]
    else if (marker === 0xda) size = (bytes[cursor++] << 8) | bytes[cursor++]
    else throw new Error(`Unsupported MessagePack marker: ${marker}`)
    const value = decoder.decode(bytes.subarray(cursor, cursor + size))
    cursor += size
    return value
  }
  const value = read()
  assert.equal(cursor, end)
  return value
}

async function invitationMail(email, subject) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const messages = readFileSync(`${storage}/worker.log`, "utf8")
      .split("send_email binding called with MessageBuilder:")
      .slice(1)
    const match = messages
      .reverse()
      .find(
        (message) =>
          message.includes(`To: ${email}\n`) &&
          message.includes(`Subject: ${subject}\n`)
      )
    const path = match?.match(/Text: (.+)\n/)?.[1]
    if (path) return readFileSync(path, "utf8")
    await delay(100)
  }
  throw new Error(`Missing local invitation for ${email}`)
}

async function registrationTokenFor(email, name) {
  const started = await post(
    "/identity/accounts/register/send-verification-email",
    {
      email,
      name,
    }
  )
  assert.equal(started.status, 204)
  const message = await invitationMail(email, "Verify your Cloudwarden email")
  const link = message.match(/https?:\/\/\S+/)?.[0]
  assert.ok(link)
  const params = new URLSearchParams(new URL(link).hash.split("?")[1])
  assert.equal(params.get("email"), email)
  const token = params.get("token")
  assert.ok(token)
  return token
}

async function registerWithEmail(input) {
  return post("/identity/accounts/register/finish", {
    ...input,
    emailVerificationToken: await registrationTokenFor(input.email, input.name),
  })
}

const webVault = await fetch(origin)
assert.equal(webVault.status, 200)
const webVaultHtml = await webVault.text()
assert.match(webVaultHtml, /<title page-title>Vaultwarden Web<\/title>/)
const webVaultScript = /src="(app\/main\.[^"]+\.js)"/.exec(webVaultHtml)?.[1]
assert.ok(webVaultScript)
assert.equal((await fetch(`${origin}/${webVaultScript}`)).status, 200)

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
const ssoPrevalidate = await call(
  "/identity/sso/prevalidate?domainHint=thecomputerplumbers"
)
assert.equal(ssoPrevalidate.status, 200)
assert.equal(typeof ssoPrevalidate.body.token, "string")
assert.equal(
  (await call("/identity/sso/prevalidate?domainHint=unknown")).status,
  404
)
assert.equal(
  (
    await fetch(
      `${origin}/identity/connect/authorize?client_id=web&domain_hint=thecomputerplumbers`
    )
  ).status,
  400
)
assert.equal(
  (
    await post("/api/organizations/domain/sso/verified", {
      email: "member@example.test",
    })
  ).body.data[0].organizationIdentifier,
  "thecomputerplumbers"
)

const email = `vault-${crypto.randomUUID()}@example.test`
assert.equal(
  (
    await post("/identity/accounts/register", {
      email,
      masterPasswordHash: "client-derived-secret",
      key: "2.encrypted-user-key",
      kdf: 0,
      kdfIterations: 600_000,
    })
  ).status,
  403
)
const registration = await registerWithEmail({
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

const webEmail = `web-${crypto.randomUUID()}@example.test`
const registrationToken = await registrationTokenFor(webEmail, "Web Test")
const finishBody = {
  email: webEmail,
  emailVerificationToken: registrationToken,
  masterPasswordAuthentication: {
    masterPasswordAuthenticationHash: "web-client-derived-secret",
    salt: webEmail,
    kdf: { kdfType: 0, iterations: 600_000 },
  },
  masterPasswordUnlock: {
    masterKeyWrappedUserKey: "2.web-encrypted-key",
    salt: webEmail,
    kdf: { kdfType: 0, iterations: 600_000 },
  },
  userAsymmetricKeys: {
    encryptedPrivateKey: "2.web-private-key",
    publicKey: "web-public-key",
  },
}
assert.equal(
  (
    await post("/identity/accounts/register/finish", {
      ...finishBody,
      emailVerificationToken: `${registrationToken}tampered`,
    })
  ).status,
  403
)
assert.equal(
  (await post("/identity/accounts/register/finish", finishBody)).status,
  200
)
assert.equal(
  (await post("/identity/accounts/register/finish", finishBody)).status,
  409
)

const prelogin = await post("/identity/accounts/prelogin", { email })
assert.equal(prelogin.status, 200)
assert.equal(prelogin.body.kdfIterations, 600_000)

const tokenRequest = (username, password, secondFactor = {}, clientIp) =>
  fetch(`${origin}/identity/connect/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(clientIp ? { "CF-Connecting-IP": clientIp } : {}),
    },
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

const argonEmail = `argon-${crypto.randomUUID()}@example.test`
const argonRegistrationToken = await registrationTokenFor(
  argonEmail,
  "Argon Test"
)
const argonSettings = {
  kdfType: 1,
  iterations: 6,
  memory: 32,
  parallelism: 4,
}
const argonRegistration = {
  email: argonEmail,
  emailVerificationToken: argonRegistrationToken,
  masterPasswordAuthentication: {
    salt: argonEmail,
    kdf: argonSettings,
    masterPasswordAuthenticationHash: "argon-client-derived-secret",
  },
  masterPasswordUnlock: {
    salt: argonEmail,
    kdf: argonSettings,
    masterKeyWrappedUserKey: "2.argon-encrypted-key",
  },
  userAsymmetricKeys: {
    encryptedPrivateKey: "2.argon-private-key",
    publicKey: "argon-public-key",
  },
}
assert.equal(
  (
    await post("/identity/accounts/register/finish", {
      ...argonRegistration,
      masterPasswordUnlock: {
        ...argonRegistration.masterPasswordUnlock,
        kdf: { ...argonSettings, memory: 16 },
      },
    })
  ).status,
  400
)
assert.equal(
  (await post("/identity/accounts/register/finish", argonRegistration)).status,
  200
)
const argonPrelogin = await post("/identity/accounts/prelogin", {
  email: argonEmail,
})
assert.equal(argonPrelogin.body.kdf, 1)
assert.equal(argonPrelogin.body.kdfIterations, 6)
assert.equal(argonPrelogin.body.kdfMemory, 32)
assert.equal(argonPrelogin.body.kdfParallelism, 4)
const argonLogin = await tokenRequest(
  argonEmail,
  "argon-client-derived-secret",
  {},
  "203.0.113.220"
)
assert.equal(argonLogin.status, 200)
const argonTokens = await argonLogin.json()
const argonKdfChange = (unlockKdf) =>
  post(
    "/api/accounts/kdf",
    {
      masterPasswordHash: "argon-client-derived-secret",
      authenticationData: {
        salt: argonEmail,
        kdf: { kdfType: 0, iterations: 600_000 },
        masterPasswordAuthenticationHash: "argon-new-secret",
      },
      unlockData: {
        salt: argonEmail,
        kdf: unlockKdf,
        masterKeyWrappedUserKey: "2.argon-new-key",
      },
    },
    argonTokens.access_token
  )
assert.equal((await argonKdfChange(argonSettings)).status, 400)
assert.equal(
  (await argonKdfChange({ kdfType: 0, iterations: 600_000 })).status,
  200
)
const argonAfterChange = await post("/identity/accounts/prelogin", {
  email: argonEmail,
})
assert.equal(argonAfterChange.body.kdf, 0)
assert.equal(argonAfterChange.body.kdfMemory, null)
assert.equal(argonAfterChange.body.kdfParallelism, null)
assert.equal(
  (await tokenRequest(argonEmail, "argon-new-secret", {}, "203.0.113.220"))
    .status,
  200
)
assert.equal(
  (
    await post(
      "/api/accounts/kdf",
      {
        masterPasswordHash: "argon-new-secret",
        authenticationData: {
          salt: argonEmail,
          kdf: argonSettings,
          masterPasswordAuthenticationHash: "argon-final-secret",
        },
        unlockData: {
          salt: argonEmail,
          kdf: argonSettings,
          masterKeyWrappedUserKey: "2.argon-final-key",
        },
      },
      argonTokens.access_token
    )
  ).status,
  200
)
const argonFinalPrelogin = await post("/identity/accounts/prelogin", {
  email: argonEmail,
})
assert.equal(argonFinalPrelogin.body.kdf, 1)
assert.equal(argonFinalPrelogin.body.kdfMemory, 32)
assert.equal(argonFinalPrelogin.body.kdfParallelism, 4)
const changedArgonEmail = `argon-renamed-${crypto.randomUUID()}@example.test`
assert.equal(
  (
    await post(
      "/api/accounts/email-token",
      { masterPasswordHash: "argon-final-secret", newEmail: email },
      argonTokens.access_token
    )
  ).status,
  409
)
assert.equal(
  (
    await post(
      "/api/accounts/email-token",
      { masterPasswordHash: "wrong", newEmail: changedArgonEmail },
      argonTokens.access_token
    )
  ).status,
  403
)
assert.equal(
  (
    await post(
      "/api/accounts/email-token",
      {
        masterPasswordHash: "argon-final-secret",
        newEmail: changedArgonEmail,
      },
      argonTokens.access_token
    )
  ).status,
  200
)
const emailChangeMail = await invitationMail(
  changedArgonEmail,
  "Confirm your Cloudwarden email change"
)
const emailChangeCode = /email change code is (\d{6})/.exec(
  emailChangeMail
)?.[1]
assert.ok(emailChangeCode)
const emailChangeBody = {
  masterPasswordHash: "argon-final-secret",
  newEmail: changedArgonEmail,
  newMasterPasswordHash: "argon-renamed-secret",
  key: "2.argon-renamed-key",
  token: emailChangeCode,
}
assert.equal(
  (
    await post(
      "/api/accounts/email",
      {
        ...emailChangeBody,
        token: "000000" === emailChangeCode ? "111111" : "000000",
      },
      argonTokens.access_token
    )
  ).status,
  400
)
assert.equal(
  (await post("/api/accounts/email", emailChangeBody, argonTokens.access_token))
    .status,
  200
)
assert.equal(
  (
    await call("/api/accounts/profile", {
      headers: { Authorization: `Bearer ${argonTokens.access_token}` },
    })
  ).status,
  401
)
assert.equal(
  (await tokenRequest(argonEmail, "argon-final-secret", {}, "203.0.113.220"))
    .status,
  400
)
const renamedPrelogin = await post("/identity/accounts/prelogin", {
  email: changedArgonEmail,
})
assert.equal(renamedPrelogin.body.kdf, 1)
assert.equal(renamedPrelogin.body.kdfMemory, 32)
const renamedLogin = await tokenRequest(
  changedArgonEmail,
  "argon-renamed-secret",
  {},
  "203.0.113.220"
)
assert.equal(renamedLogin.status, 200)
assert.equal((await renamedLogin.json()).Key, "2.argon-renamed-key")

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
assert.equal(
  JSON.parse(
    Buffer.from(tokens.access_token.split(".")[1], "base64url").toString()
  ).email_verified,
  true
)

assert.equal((await call("/api/sync")).status, 401)
let currentAccessToken = tokens.access_token
const authorized = (path, method = "GET", body) =>
  call(path, {
    method,
    headers: {
      Authorization: `Bearer ${currentAccessToken}`,
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
assert.equal(createdCipher.body.archivedDate, null)
const archivedCipher = await authorized(
  `/api/ciphers/${cipherId}/archive`,
  "PUT"
)
assert.equal(archivedCipher.status, 200)
assert.ok(Date.parse(archivedCipher.body.archivedDate))
assert.equal(
  (await authorized("/api/sync")).body.ciphers.find(
    (item) => item.id === cipherId
  ).archivedDate,
  archivedCipher.body.archivedDate
)
const unarchivedCipher = await authorized(
  `/api/ciphers/${cipherId}/unarchive`,
  "PUT"
)
assert.equal(unarchivedCipher.status, 200)
assert.equal(unarchivedCipher.body.archivedDate, null)
const bulkArchived = await authorized("/api/ciphers/archive", "PUT", {
  ids: [cipherId],
})
assert.equal(bulkArchived.status, 200)
assert.equal(bulkArchived.body.object, "list")
assert.ok(Date.parse(bulkArchived.body.data[0].archivedDate))
const bulkUnarchived = await authorized("/api/ciphers/unarchive", "PUT", {
  ids: [cipherId],
})
assert.equal(bulkUnarchived.status, 200)
assert.equal(bulkUnarchived.body.data[0].archivedDate, null)

const sync = await authorized("/api/sync")
assert.equal(sync.status, 200)
assert.equal(sync.body.profile.email, email)
assert.equal(sync.body.folders[0].id, createdFolder.body.id)
assert.equal(sync.body.ciphers[0].id, cipherId)
const loginDeviceId = JSON.parse(
  Buffer.from(tokens.access_token.split(".")[1], "base64url").toString()
).device
const devices = await authorized("/api/devices")
assert.equal(devices.status, 200)
assert.equal(devices.body.data.length, 1)
assert.equal(devices.body.data[0].identifier, loginDeviceId)
assert.equal(devices.body.data[0].name, "Smoke test")
assert.equal(devices.body.data[0].type, 14)
assert.equal(
  (await authorized(`/api/devices/identifier/${loginDeviceId}`)).body.id,
  loginDeviceId
)
assert.equal(
  (
    await call("/api/devices/knowndevice", {
      headers: {
        "X-Request-Email": Buffer.from(email).toString("base64url"),
        "X-Device-Identifier": loginDeviceId,
      },
    })
  ).body,
  true
)
assert.equal(
  (
    await call("/api/devices/knowndevice", {
      headers: {
        "X-Request-Email": Buffer.from(email).toString("base64url"),
        "X-Device-Identifier": crypto.randomUUID(),
      },
    })
  ).body,
  false
)

const requestingDeviceId = loginDeviceId
const authAccessCode = "123456789012"
await assert.rejects(
  notificationSocket("/notifications/hub?access_token=invalid"),
  /Notification connection failed/
)
await assert.rejects(
  notificationSocket(
    `/notifications/anonymous-hub?token=${crypto.randomUUID()}`
  ),
  /Notification connection failed/
)
const userNotification = await notificationSocket(
  `/notifications/hub?access_token=${encodeURIComponent(currentAccessToken)}`
)
const requestedNotification = nextSocketMessage(userNotification)
assert.equal(
  (
    await call("/api/auth-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Device-Type": "14" },
      body: JSON.stringify({
        email,
        deviceIdentifier: crypto.randomUUID(),
        accessCode: authAccessCode,
        publicKey: "device-public-key",
      }),
    })
  ).status,
  404
)
const authRequest = await call("/api/auth-requests", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Device-Type": "14" },
  body: JSON.stringify({
    email,
    deviceIdentifier: requestingDeviceId,
    accessCode: authAccessCode,
    publicKey: "device-public-key",
  }),
})
assert.equal(authRequest.status, 200)
assert.equal(authRequest.body.requestApproved, false)
const authRequestId = authRequest.body.id
const requestedFrame = await requestedNotification
assert.deepEqual(decodeNotificationFrame(requestedFrame), [
  1,
  {},
  null,
  "ReceiveMessage",
  [
    {
      ContextId: requestingDeviceId,
      Type: 15,
      Payload: { Id: authRequestId, UserId: sync.body.profile.id },
    },
  ],
])
const anonymousNotification = await notificationSocket(
  `/notifications/anonymous-hub?token=${authRequestId}`
)
const approvedNotification = nextSocketMessage(anonymousNotification)
assert.equal(
  (await authorized("/api/auth-requests/pending")).body.data[0].id,
  authRequestId
)
assert.equal(
  (
    await call(`/api/auth-requests/${authRequestId}/response?code=wrong`, {
      headers: { "Device-Type": "14" },
    })
  ).status,
  404
)
assert.equal(
  (
    await authorized(`/api/auth-requests/${authRequestId}`, "PUT", {
      deviceIdentifier: crypto.randomUUID(),
      requestApproved: true,
      key: "2.encrypted-auth-key",
    })
  ).status,
  400
)
const approval = await authorized(
  `/api/auth-requests/${authRequestId}`,
  "PUT",
  {
    deviceIdentifier: loginDeviceId,
    requestApproved: true,
    key: "2.encrypted-auth-key",
    masterPasswordHash: "2.encrypted-master-hash",
  }
)
assert.equal(approval.status, 200)
assert.equal(approval.body.requestApproved, true)
const approvedFrame = await approvedNotification
assert.deepEqual(decodeNotificationFrame(approvedFrame), [
  1,
  {},
  null,
  "AuthRequestResponseRecieved",
  [
    {
      Type: 16,
      Payload: { Id: authRequestId, UserId: sync.body.profile.id },
      UserId: sync.body.profile.id,
    },
  ],
])
anonymousNotification.close()
userNotification.close()
const syncNotificationSocket = await notificationSocket(
  `/notifications/hub?access_token=${encodeURIComponent(currentAccessToken)}`
)
const syncNotification = nextSocketMessage(syncNotificationSocket)
assert.equal(
  (
    await authorized(`/api/folders/${createdFolder.body.id}`, "PUT", {
      name: "2.updated-folder-name",
    })
  ).status,
  200
)
const syncFrame = await syncNotification
const syncEvent = decodeNotificationFrame(syncFrame)
assert.equal(syncEvent[3], "ReceiveMessage")
assert.equal(syncEvent[4][0].Type, 5)
assert.equal(syncEvent[4][0].Payload.UserId, sync.body.profile.id)
assert.ok(syncEvent[4][0].Payload.Date instanceof Date)
syncNotificationSocket.close()
const authResponse = await call(
  `/api/auth-requests/${authRequestId}/response?code=${authAccessCode}`,
  { headers: { "Device-Type": "14" } }
)
assert.equal(authResponse.status, 200)
assert.equal(authResponse.body.key, "2.encrypted-auth-key")
assert.equal(authResponse.body.masterPasswordHash, "2.encrypted-master-hash")
assert.equal(
  (
    await call(
      `/api/auth-requests/${authRequestId}/response?code=${authAccessCode}`,
      { headers: { "Device-Type": "13" } }
    )
  ).status,
  404
)
const authRequestLogin = () =>
  fetch(`${origin}/identity/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "web",
      scope: "api offline_access",
      username: email,
      password: authAccessCode,
      authrequest: authRequestId,
      device_identifier: requestingDeviceId,
      device_type: "14",
    }),
  })
const approvedLogin = await authRequestLogin()
assert.equal(approvedLogin.status, 200)
const approvedTokens = await approvedLogin.json()
assert.ok(approvedTokens.access_token)
assert.equal(
  (
    await call("/api/sync", {
      headers: { Authorization: `Bearer ${approvedTokens.access_token}` },
    })
  ).status,
  200
)
assert.equal((await authRequestLogin()).status, 400)
assert.equal(
  (await authorized("/api/auth-requests/pending")).body.data.length,
  0
)
const rejectedRequest = await call("/api/auth-requests", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Device-Type": "14" },
  body: JSON.stringify({
    email,
    deviceIdentifier: loginDeviceId,
    accessCode: "another-secret",
    publicKey: "another-public-key",
  }),
})
assert.equal(rejectedRequest.status, 200)
assert.equal(
  (
    await authorized(`/api/auth-requests/${rejectedRequest.body.id}`, "PUT", {
      deviceIdentifier: loginDeviceId,
      requestApproved: false,
      key: "",
    })
  ).status,
  200
)
assert.equal(
  (await authorized(`/api/auth-requests/${rejectedRequest.body.id}`)).status,
  404
)

assert.equal(
  (
    await authorized("/api/accounts/api-key", "POST", {
      masterPasswordHash: "wrong",
    })
  ).status,
  403
)
const apiKey = await authorized("/api/accounts/api-key", "POST", {
  masterPasswordHash: "client-derived-secret",
})
assert.equal(apiKey.status, 200)
assert.match(apiKey.body.apiKey, /^[A-Za-z0-9]{30}$/)
assert.equal(
  (
    await authorized("/api/accounts/api-key", "POST", {
      masterPasswordHash: "client-derived-secret",
    })
  ).body.apiKey,
  apiKey.body.apiKey
)
const apiLogin = (secret) =>
  fetch(`${origin}/identity/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: `user.${sync.body.profile.id}`,
      client_secret: secret,
      scope: "api",
      device_identifier: crypto.randomUUID(),
      device_type: "14",
    }),
  })
assert.equal((await apiLogin("wrong")).status, 400)
const apiSession = await apiLogin(apiKey.body.apiKey)
assert.equal(apiSession.status, 200)
const apiTokens = await apiSession.json()
assert.equal(apiTokens.scope, "api")
assert.equal(apiTokens.refresh_token, undefined)
assert.equal(
  (
    await post(
      "/api/ciphers",
      { type: 2, name: "2.api-key-note" },
      apiTokens.access_token
    )
  ).status,
  200
)
const apiNotificationSocket = await notificationSocket(
  `/notifications/hub?access_token=${encodeURIComponent(apiTokens.access_token)}`
)
const apiNotificationClosed = socketClosed(apiNotificationSocket)
const rotatedApiKey = await authorized("/api/accounts/rotate-api-key", "POST", {
  masterPasswordHash: "client-derived-secret",
})
assert.equal(rotatedApiKey.status, 200)
assert.equal(await apiNotificationClosed, 1000)
assert.notEqual(rotatedApiKey.body.apiKey, apiKey.body.apiKey)
assert.equal((await apiLogin(apiKey.body.apiKey)).status, 400)
assert.equal(
  (
    await call("/api/sync", {
      headers: { Authorization: `Bearer ${apiTokens.access_token}` },
    })
  ).status,
  401
)
assert.equal((await apiLogin(rotatedApiKey.body.apiKey)).status, 200)
assert.equal(
  (await authorized("/api/accounts/request-otp", "POST")).status,
  200
)
assert.equal(
  (await authorized("/api/accounts/request-otp", "POST")).status,
  429
)
const securityMail = await invitationMail(email, "Cloudwarden security code")
const securityCode = /security code is (\d{6})/.exec(securityMail)?.[1]
assert.ok(securityCode)
const wrongSecurityCode = securityCode === "000001" ? "000002" : "000001"
for (let attempt = 0; attempt < 4; attempt++)
  assert.equal(
    (
      await authorized("/api/accounts/verify-otp", "POST", {
        otp: wrongSecurityCode,
      })
    ).status,
    400
  )
assert.equal(
  (await authorized("/api/accounts/verify-otp", "POST", { otp: "0000000" }))
    .status,
  400
)
const otpRotatedApiKey = await authorized(
  "/api/accounts/rotate-api-key",
  "POST",
  {
    otp: securityCode,
  }
)
assert.equal(otpRotatedApiKey.status, 200)
assert.notEqual(otpRotatedApiKey.body.apiKey, rotatedApiKey.body.apiKey)
assert.equal(
  (
    await authorized("/api/accounts/rotate-api-key", "POST", {
      otp: securityCode,
    })
  ).status,
  403
)
assert.equal((await apiLogin(rotatedApiKey.body.apiKey)).status, 400)
assert.equal((await apiLogin(otpRotatedApiKey.body.apiKey)).status, 200)
assert.equal(sync.body.ciphers[0].login.username, "2.encrypted-login")

const archivedDate = "2024-04-05T12:30:00.000Z"
const createdArchived = await authorized("/api/ciphers", "POST", {
  type: 2,
  name: "2.archived-created",
  archivedDate,
})
assert.equal(createdArchived.status, 200)
assert.equal(createdArchived.body.archivedDate, archivedDate)
const editedArchived = await authorized(
  `/api/ciphers/${createdArchived.body.id}`,
  "PUT",
  { type: 2, name: "2.archived-created", archivedDate: null }
)
assert.equal(editedArchived.status, 200)
assert.equal(editedArchived.body.archivedDate, null)
const beforeImport = await authorized("/api/sync")
assert.equal(
  (
    await authorized("/api/ciphers/import", "POST", {
      folders: [{ name: "2.must-not-appear" }],
      ciphers: [
        { type: 1, name: "2.valid-import" },
        {
          type: 1,
          name: "2.invalid-import",
          organizationId: crypto.randomUUID(),
        },
      ],
      folderRelationships: [{ key: 0, value: 0 }],
    })
  ).status,
  400
)
assert.equal(
  (await authorized("/api/sync")).body.ciphers.length,
  beforeImport.body.ciphers.length
)
assert.equal(
  (
    await authorized("/api/ciphers/import", "POST", {
      folders: [{ name: "2.imported-folder" }],
      ciphers: [
        {
          type: 1,
          name: "2.imported-login",
          login: { username: "2.imported-user" },
        },
        {
          type: 2,
          name: "2.imported-note",
          secureNote: { type: 0 },
          archivedDate,
        },
      ],
      folderRelationships: [{ key: 0, value: 0 }],
    })
  ).status,
  200
)
const imported = await authorized("/api/sync")
const importedFolder = imported.body.folders.find(
  (folder) => folder.name === "2.imported-folder"
)
assert.ok(importedFolder)
assert.equal(
  imported.body.ciphers.find((cipher) => cipher.name === "2.imported-login")
    .folderId,
  importedFolder.id
)
assert.equal(
  imported.body.ciphers.find((cipher) => cipher.name === "2.imported-note")
    .folderId,
  null
)
assert.equal(
  imported.body.ciphers.find((cipher) => cipher.name === "2.imported-note")
    .archivedDate,
  archivedDate
)
assert.equal(
  (
    await authorized("/api/ciphers/import", "POST", {
      folders: [{ id: importedFolder.id, name: "2.ignored-rename" }],
      ciphers: [{ type: 1, name: "2.imported-into-existing-folder" }],
      folderRelationships: [{ key: 0, value: 0 }],
    })
  ).status,
  200
)
const reused = await authorized("/api/sync")
assert.equal(reused.body.folders.length, imported.body.folders.length)
assert.equal(
  reused.body.ciphers.find(
    (cipher) => cipher.name === "2.imported-into-existing-folder"
  ).folderId,
  importedFolder.id
)

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
assert.ok(
  Date.parse(attachedCipher.body.revisionDate) >
    Date.parse(createdCipher.body.revisionDate)
)
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
      archivedDate,
      lastKnownRevisionDate: "2020-01-01T00:00:00.000Z",
    })
  ).status,
  409
)
assert.equal(
  (await authorized(`/api/ciphers/${cipherId}`)).body.archivedDate,
  null
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
assert.ok(
  Date.parse((await authorized(`/api/ciphers/${cipherId}`)).body.revisionDate) >
    Date.parse(attachedCipher.body.revisionDate)
)
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
const refreshedTokens = await refreshed.json()
assert.equal(
  (
    await call("/api/accounts/profile", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
  ).status,
  200
)
currentAccessToken = refreshedTokens.access_token
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
    await registerWithEmail({
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

const organization = await authorized("/api/organizations", "POST", {
  name: "Encrypted Team",
  billingEmail: email,
  collectionName: "Default collection",
  key: "2.encrypted-organization-key",
  keys: {
    encryptedPrivateKey: "2.encrypted-organization-private-key",
    publicKey: "organization-public-key",
  },
})
assert.equal(organization.status, 200)
const orgId = organization.body.id
assert.equal(
  (await authorized(`/api/organizations/${orgId}/public-key`)).body.publicKey,
  "organization-public-key"
)
const renamedOrganization = await authorized(
  `/api/organizations/${orgId}`,
  "PUT",
  {
    name: "Encrypted Team Renamed",
    billingEmail: email,
  }
)
assert.equal(renamedOrganization.status, 200)
assert.equal(renamedOrganization.body.name, "Encrypted Team Renamed")
const orgCollections = await authorized(
  `/api/organizations/${orgId}/collections`
)
assert.equal(orgCollections.status, 200)
assert.equal(orgCollections.body.data.length, 1)
assert.equal(orgCollections.body.data[0].name, "Default collection")
const secondCollection = await authorized(
  `/api/organizations/${orgId}/collections`,
  "POST",
  { name: "Shared logins" }
)
assert.equal(secondCollection.status, 200)
const renamedCollection = await authorized(
  `/api/organizations/${orgId}/collections/${secondCollection.body.id}`,
  "PUT",
  { name: "Shared logins renamed" }
)
assert.equal(renamedCollection.status, 200)
assert.equal(renamedCollection.body.name, "Shared logins renamed")
const emptyCollection = await authorized(
  `/api/organizations/${orgId}/collections`,
  "POST",
  { name: "Temporary" }
)
assert.equal(emptyCollection.status, 200)
assert.equal(
  (
    await authorized(
      `/api/organizations/${orgId}/collections/${emptyCollection.body.id}`,
      "DELETE"
    )
  ).status,
  204
)
const orgSync = await authorized("/api/sync")
assert.equal(
  orgSync.body.profile.organizations[0].key,
  "2.encrypted-organization-key"
)
assert.equal(orgSync.body.collections.length, 2)
assert.equal((await authorized("/api/collections")).body.data.length, 2)
const personalToShare = await authorized("/api/ciphers", "POST", {
  type: 1,
  name: "2.personal-before-share",
  login: { username: "2.personal-login" },
})
assert.equal(personalToShare.status, 200)
const transferId = personalToShare.body.id
const transferAttachment = await authorized(
  `/api/ciphers/${transferId}/attachment/v2`,
  "POST",
  { fileName: "2.personal-file", fileSize: 3, key: "2.personal-file-key" }
)
assert.equal(transferAttachment.status, 200)
const transferUpload = new FormData()
transferUpload.append("data", new File([new Uint8Array([3, 2, 1])], "move.bin"))
assert.equal(
  (
    await fetch(`${origin}/api${transferAttachment.body.url}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${currentAccessToken}` },
      body: transferUpload,
    })
  ).status,
  204
)
const personalAttachmentLink = (await authorized(`/api/ciphers/${transferId}`))
  .body.attachments[0].url
const shareInput = {
  cipher: {
    type: 1,
    name: "2.moved-shared-name",
    organizationId: orgId,
    login: { username: "2.moved-shared-login" },
    lastKnownRevisionDate: personalToShare.body.revisionDate,
    attachments2: {
      [transferAttachment.body.attachmentId]: {
        fileName: "2.shared-attachment-name",
        key: "2.shared-attachment-key",
      },
    },
  },
  collectionIds: [secondCollection.body.id],
}
assert.equal(
  (
    await authorized(`/api/ciphers/${transferId}/share`, "POST", {
      ...shareInput,
      cipher: { ...shareInput.cipher, attachments2: {} },
    })
  ).status,
  400
)
assert.equal(
  (
    await authorized(`/api/ciphers/${transferId}/share`, "POST", {
      ...shareInput,
      collectionIds: [crypto.randomUUID()],
    })
  ).status,
  400
)
assert.equal((await authorized(`/api/ciphers/${transferId}`)).status, 200)
const moved = await authorized(
  `/api/ciphers/${transferId}/share`,
  "POST",
  shareInput
)
assert.equal(moved.status, 200)
assert.equal(moved.body.organizationId, orgId)
assert.equal(moved.body.name, "2.moved-shared-name")
assert.equal(moved.body.attachments[0].key, "2.shared-attachment-key")
assert.deepEqual(
  new Uint8Array(
    await (await fetch(moved.body.attachments[0].url)).arrayBuffer()
  ),
  new Uint8Array([3, 2, 1])
)
assert.equal((await fetch(personalAttachmentLink)).status, 404)
assert.equal(
  (await authorized("/api/sync")).body.ciphers.filter(
    (cipher) => cipher.id === transferId
  ).length,
  1
)
const plainBeforeShare = await authorized("/api/ciphers", "POST", {
  type: 2,
  name: "2.personal-plain-share",
  notes: "2.personal-plain-notes",
  favorite: true,
})
assert.equal(plainBeforeShare.status, 200)
const plainMoved = await authorized(
  `/api/ciphers/${plainBeforeShare.body.id}/share`,
  "PUT",
  {
    cipher: {
      type: 2,
      name: "2.shared-plain-share",
      notes: "2.shared-plain-notes",
      organizationId: orgId,
      archivedDate,
      lastKnownRevisionDate: plainBeforeShare.body.revisionDate,
    },
    collectionIds: [secondCollection.body.id],
  }
)
assert.equal(plainMoved.status, 200)
assert.equal(plainMoved.body.organizationId, orgId)
assert.equal(plainMoved.body.notes, "2.shared-plain-notes")
assert.equal(plainMoved.body.archivedDate, archivedDate)
assert.equal(plainMoved.body.favorite, true)
const bulkSources = await Promise.all(
  ["first", "second"].map((part) =>
    authorized("/api/ciphers", "POST", {
      type: 2,
      name: `2.personal-bulk-${part}`,
    })
  )
)
assert.ok(bulkSources.every((source) => source.status === 200))
const bulkCiphers = bulkSources.map((source, index) => ({
  id: source.body.id,
  type: 2,
  name: `2.shared-bulk-${index}`,
  organizationId: orgId,
  lastKnownRevisionDate: source.body.revisionDate,
}))
assert.equal(
  (
    await authorized("/api/ciphers/share", "PUT", {
      ciphers: [...bulkCiphers, { ...bulkCiphers[0], id: "invalid" }],
      collectionIds: [secondCollection.body.id],
    })
  ).status,
  400
)
assert.equal(
  (
    await authorized("/api/ciphers/share", "PUT", {
      ciphers: bulkCiphers,
      collectionIds: [secondCollection.body.id],
    })
  ).status,
  200
)
for (const cipher of bulkCiphers) {
  const movedBulk = await authorized(`/api/ciphers/${cipher.id}`)
  assert.equal(movedBulk.status, 200)
  assert.equal(movedBulk.body.organizationId, orgId)
  assert.equal(movedBulk.body.name, cipher.name)
}
const sharedCipherBody = {
  type: 1,
  name: "2.encrypted-shared-name",
  organizationId: orgId,
  collectionIds: [secondCollection.body.id],
  login: { username: "2.encrypted-shared-login" },
  favorite: true,
}
const sharedCipher = await authorized("/api/ciphers", "POST", sharedCipherBody)
assert.equal(sharedCipher.status, 200)
assert.equal(sharedCipher.body.favorite, true)
assert.equal(sharedCipher.body.organizationId, orgId)
assert.deepEqual(sharedCipher.body.collectionIds, [secondCollection.body.id])
const sharedId = sharedCipher.body.id
const sharedArchived = await authorized(`/api/ciphers/${sharedId}`, "PUT", {
  ...sharedCipherBody,
  archivedDate,
})
assert.equal(sharedArchived.status, 200)
assert.equal(sharedArchived.body.archivedDate, archivedDate)
const sharedUnarchived = await authorized(`/api/ciphers/${sharedId}`, "PUT", {
  ...sharedCipherBody,
  archivedDate: null,
  favorite: false,
})
assert.equal(sharedUnarchived.status, 200)
assert.equal(sharedUnarchived.body.archivedDate, null)
assert.equal(sharedUnarchived.body.favorite, false)
const ownerMoveFolder = await authorized("/api/folders", "POST", {
  name: "2.owner-move-folder",
})
assert.equal(ownerMoveFolder.status, 200)
assert.equal(
  (
    await authorized("/api/ciphers/move", "PUT", {
      ids: [cipherId, crypto.randomUUID()],
      folderId: ownerMoveFolder.body.id,
    })
  ).status,
  404
)
assert.equal((await authorized(`/api/ciphers/${cipherId}`)).body.folderId, null)
assert.equal(
  (
    await authorized("/api/ciphers/move", "PUT", {
      ids: [cipherId, sharedId],
      folderId: ownerMoveFolder.body.id,
    })
  ).status,
  200
)
assert.equal(
  (await authorized(`/api/ciphers/${cipherId}`)).body.folderId,
  ownerMoveFolder.body.id
)
assert.equal(
  (await authorized(`/api/ciphers/${sharedId}`)).body.folderId,
  ownerMoveFolder.body.id
)
assert.equal(
  (await authorized(`/api/folders/${ownerMoveFolder.body.id}`, "DELETE"))
    .status,
  204
)
assert.equal((await authorized(`/api/ciphers/${sharedId}`)).body.folderId, null)
assert.equal((await authorized(`/api/ciphers/${cipherId}`)).body.folderId, null)
assert.equal(
  (
    await authorized("/api/ciphers/delete", "PUT", {
      ids: [cipherId, crypto.randomUUID()],
    })
  ).status,
  404
)
assert.equal(
  (await authorized(`/api/ciphers/${cipherId}`)).body.deletedDate,
  null
)
const bulkTrashed = await authorized("/api/ciphers/delete", "PUT", {
  ids: [cipherId, sharedId],
})
assert.equal(bulkTrashed.status, 204)
assert.ok((await authorized(`/api/ciphers/${cipherId}`)).body.deletedDate)
assert.ok((await authorized(`/api/ciphers/${sharedId}`)).body.deletedDate)
const bulkRestored = await authorized("/api/ciphers/restore", "PUT", {
  ids: [cipherId, sharedId],
})
assert.equal(bulkRestored.status, 200)
assert.equal(bulkRestored.body.object, "list")
assert.deepEqual(
  bulkRestored.body.data.map((cipher) => cipher.id),
  [cipherId, sharedId]
)
assert.ok(bulkRestored.body.data.every((cipher) => cipher.deletedDate === null))
assert.equal(
  (await otherAuthorized("/api/ciphers/delete", { ids: [sharedId] }, "PUT"))
    .status,
  404
)
const sharedAttachmentInit = await authorized(
  `/api/ciphers/${sharedId}/attachment/v2`,
  "POST",
  { fileName: "2.shared-file", fileSize: 3, key: "2.shared-file-key" }
)
assert.equal(sharedAttachmentInit.status, 200)
const sharedUpload = new FormData()
sharedUpload.append("data", new File([new Uint8Array([9, 8, 7])], "shared.bin"))
const sharedUploaded = await fetch(
  `${origin}/api${sharedAttachmentInit.body.url}`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${currentAccessToken}` },
    body: sharedUpload,
  }
)
assert.equal(sharedUploaded.status, 204)
const ownerSharedLink = (await authorized(`/api/ciphers/${sharedId}`)).body
  .attachments[0].url
const orgExport = await authorized(`/api/organizations/${orgId}/export`)
assert.equal(orgExport.status, 200)
assert.equal(orgExport.body.collections.length, 2)
assert.ok(
  orgExport.body.ciphers.some(
    (cipher) =>
      cipher.id === transferId &&
      cipher.organizationId === orgId &&
      cipher.attachments[0].key === "2.shared-attachment-key"
  )
)
assert.ok(orgExport.body.ciphers.some((cipher) => cipher.id === sharedId))
assert.deepEqual(
  new Uint8Array(await (await fetch(ownerSharedLink)).arrayBuffer()),
  new Uint8Array([9, 8, 7])
)
assert.equal(
  (
    await authorized(
      `/api/organizations/${orgId}/collections/${secondCollection.body.id}`,
      "DELETE"
    )
  ).status,
  409
)
assert.equal(
  (await authorized(`/api/ciphers/${sharedId}`)).body.login.username,
  "2.encrypted-shared-login"
)
assert.equal(
  (await authorized("/api/sync")).body.ciphers.some(
    (cipher) => cipher.id === sharedId
  ),
  true
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).status,
  404
)
assert.equal(
  (
    await otherAuthorized(
      `/api/ciphers/${sharedId}/partial`,
      { folderId: null, favorite: false },
      "PUT"
    )
  ).status,
  404
)
assert.equal(
  (await otherAuthorized("/api/ciphers", sharedCipherBody)).status,
  404
)
const beforeSharedEditRevision = (
  await authorized("/api/accounts/revision-date")
).body
const editedShared = await authorized(`/api/ciphers/${sharedId}`, "PUT", {
  ...sharedCipherBody,
  name: "2.edited-shared-name",
  favorite: false,
})
assert.equal(editedShared.status, 200)
assert.equal(editedShared.body.name, "2.edited-shared-name")
assert.ok(
  Date.parse((await authorized("/api/accounts/revision-date")).body) >
    Date.parse(beforeSharedEditRevision)
)
assert.equal(
  (await authorized(`/api/ciphers/${sharedId}`, "DELETE")).status,
  204
)
assert.ok((await authorized(`/api/ciphers/${sharedId}`)).body.deletedDate)
assert.equal(
  (await authorized(`/api/ciphers/${sharedId}/restore`, "PUT")).status,
  200
)
assert.equal(
  (await otherAuthorized(`/api/organizations/${orgId}`, undefined, "GET"))
    .status,
  404
)
assert.deepEqual(
  (await otherAuthorized("/api/sync", undefined, "GET")).body.collections,
  []
)
assert.equal(
  (
    await otherAuthorized("/api/accounts/keys", {
      encryptedPrivateKey: "2.other-private-key",
      publicKey: "other-public-key",
    })
  ).status,
  200
)
const otherUserId = otherSync.body.profile.id
assert.equal(
  (await authorized(`/api/users/${otherUserId}/public-key`)).body.publicKey,
  "other-public-key"
)
const invitation = await authorized(
  `/api/organizations/${orgId}/users/invite`,
  "POST",
  {
    emails: [otherEmail],
    type: 2,
    accessAll: false,
    collections: [
      { id: secondCollection.body.id, readOnly: false, hidePasswords: false },
    ],
  }
)
assert.equal(invitation.status, 200)
assert.deepEqual(
  (await otherAuthorized("/api/sync", undefined, "GET")).body.profile
    .organizations,
  []
)
const invitedEmail = `invited-${crypto.randomUUID()}@example.test`
assert.equal(
  (
    await authorized(`/api/organizations/${orgId}/users/invite`, "POST", {
      emails: [invitedEmail],
      type: 2,
      accessAll: false,
      collections: [{ id: secondCollection.body.id }],
    })
  ).status,
  200
)
const pendingInvite = (
  await authorized(`/api/organizations/${orgId}/users`)
).body.data.find((member) => member.email === invitedEmail)
assert.equal(pendingInvite.status, 0)
const pendingText = await invitationMail(
  invitedEmail,
  "Invitation to Encrypted Team Renamed"
)
const pendingLink = pendingText.match(/https?:\/\/\S+/)?.[0]
assert.ok(pendingLink)
const pendingParams = new URLSearchParams(
  new URL(pendingLink).hash.split("?")[1]
)
assert.equal(pendingParams.get("orgUserHasExistingUser"), "false")
const invitedRegistration = {
  email: invitedEmail,
  name: "Invited User",
  masterPasswordHash: "invited-secret",
  key: "2.invited-key",
  keys: {
    encryptedPrivateKey: "2.invited-private",
    publicKey: "invited-public",
  },
  kdf: 0,
  kdfIterations: 600_000,
  organizationUserId: pendingInvite.id,
  orgInviteToken: pendingParams.get("token"),
}
assert.equal(
  (
    await post("/identity/accounts/register", {
      ...invitedRegistration,
      orgInviteToken: `${pendingParams.get("token")}tampered`,
    })
  ).status,
  403
)
assert.equal(
  (await post("/identity/accounts/register", invitedRegistration)).status,
  200
)
const invitedLogin = await tokenRequest(invitedEmail, "invited-secret")
assert.equal(invitedLogin.status, 200)
const invitedTokens = await invitedLogin.json()
const invitedAccept = await post(
  `/api/organizations/${orgId}/users/${pendingInvite.id}/accept`,
  { token: pendingParams.get("token") },
  invitedTokens.access_token
)
assert.equal(invitedAccept.status, 200)
assert.equal(
  (
    await authorized(
      `/api/organizations/${orgId}/users/${pendingInvite.id}/confirm`,
      "POST",
      {
        key: "2.wrapped-invited-key",
      }
    )
  ).status,
  200
)
assert.equal(
  (
    await call("/api/sync", {
      headers: { Authorization: `Bearer ${invitedTokens.access_token}` },
    })
  ).body.profile.organizations[0].key,
  "2.wrapped-invited-key"
)
assert.equal(
  (
    await authorized(
      `/api/organizations/${orgId}/users/${pendingInvite.id}`,
      "DELETE"
    )
  ).status,
  200
)
const members = await authorized(`/api/organizations/${orgId}/users`)
const invitee = members.body.data.find((member) => member.email === otherEmail)
assert.equal(invitee.status, 0)
assert.equal(
  (
    await authorized(
      `/api/organizations/${orgId}/users/${invitee.id}/confirm`,
      "POST",
      { key: "premature" }
    )
  ).status,
  404
)
const inviteText = await invitationMail(
  otherEmail,
  "Invitation to Encrypted Team Renamed"
)
const inviteLink = inviteText.match(/https?:\/\/\S+/)?.[0]
assert.ok(inviteLink)
const inviteParams = new URLSearchParams(new URL(inviteLink).hash.split("?")[1])
assert.equal(inviteParams.get("organizationUserId"), invitee.id)
assert.equal(inviteParams.get("orgUserHasExistingUser"), "true")
assert.equal(
  (
    await otherAuthorized(
      `/api/organizations/${orgId}/users/${invitee.id}/accept`,
      { token: `${inviteParams.get("token")}tampered` }
    )
  ).status,
  403
)
assert.equal(
  (
    await otherAuthorized(
      `/api/organizations/${orgId}/users/${invitee.id}/accept`,
      { token: inviteParams.get("token") }
    )
  ).status,
  200
)
assert.equal(
  (
    await authorized(
      `/api/organizations/${orgId}/users/${invitee.id}/confirm`,
      "POST",
      {
        key: "2.encrypted-key-for-other",
      }
    )
  ).status,
  200
)
const memberSync = await otherAuthorized("/api/sync", undefined, "GET")
assert.equal(
  (await otherAuthorized("/api/ciphers/delete", { ids: [sharedId] }, "PUT"))
    .status,
  403
)
assert.equal(
  (
    await otherAuthorized(
      `/api/organizations/${orgId}/export`,
      undefined,
      "GET"
    )
  ).status,
  403
)
assert.equal(
  memberSync.body.profile.organizations[0].key,
  "2.encrypted-key-for-other"
)
assert.deepEqual(
  memberSync.body.collections.map((collection) => collection.id),
  [secondCollection.body.id]
)
assert.equal(
  memberSync.body.ciphers.some((cipher) => cipher.id === sharedId),
  true
)
assert.equal(
  memberSync.body.ciphers.find((cipher) => cipher.id === plainMoved.body.id)
    .archivedDate,
  null
)
assert.equal(
  memberSync.body.ciphers.find((cipher) => cipher.id === plainMoved.body.id)
    .favorite,
  false
)
const memberFolder = await otherAuthorized("/api/folders", {
  name: "2.member-shared-folder",
})
assert.equal(memberFolder.status, 200)
const memberPartial = await otherAuthorized(
  `/api/ciphers/${sharedId}/partial`,
  { folderId: memberFolder.body.id, favorite: true },
  "PUT"
)
assert.equal(memberPartial.status, 200)
assert.equal(memberPartial.body.folderId, memberFolder.body.id)
assert.equal(memberPartial.body.favorite, true)
assert.equal(
  (await authorized(`/api/ciphers/${sharedId}`)).body.favorite,
  false
)
assert.equal((await authorized(`/api/ciphers/${sharedId}`)).body.folderId, null)
assert.equal(
  (await otherAuthorized("/api/sync", undefined, "GET")).body.ciphers.find(
    (cipher) => cipher.id === sharedId
  ).folderId,
  memberFolder.body.id
)
assert.equal(
  (
    await otherAuthorized(
      `/api/folders/${memberFolder.body.id}`,
      undefined,
      "DELETE"
    )
  ).status,
  204
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).body
    .folderId,
  null
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).body
    .favorite,
  true
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).status,
  200
)
const memberArchived = await otherAuthorized(
  `/api/ciphers/${sharedId}/archive`,
  undefined,
  "PUT"
)
assert.equal(memberArchived.status, 200)
assert.ok(Date.parse(memberArchived.body.archivedDate))
assert.equal(
  (await authorized(`/api/ciphers/${sharedId}`)).body.archivedDate,
  null
)
assert.equal(
  (await otherAuthorized("/api/sync", undefined, "GET")).body.ciphers.find(
    (cipher) => cipher.id === sharedId
  ).archivedDate,
  memberArchived.body.archivedDate
)
assert.equal(
  (
    await otherAuthorized(
      `/api/ciphers/${sharedId}/unarchive`,
      undefined,
      "PUT"
    )
  ).body.archivedDate,
  null
)
const memberSharedLink = (
  await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")
).body.attachments[0].url
assert.equal((await fetch(memberSharedLink)).status, 200)
const spoofedSharedLink = memberSharedLink.replace(
  `${orgId}:${otherUserId}.`,
  `${orgId}:${orgSync.body.profile.id}.`
)
assert.notEqual(spoofedSharedLink, memberSharedLink)
assert.equal((await fetch(spoofedSharedLink)).status, 404)
const memberDetail = await authorized(
  `/api/organizations/${orgId}/users/${invitee.id}`
)
assert.deepEqual(
  memberDetail.body.collections.map((entry) => entry.id),
  [secondCollection.body.id]
)
assert.equal(
  (
    await otherAuthorized(
      `/api/organizations/${orgId}/users/${invitee.id}`,
      { type: 2, collections: [] },
      "PUT"
    )
  ).status,
  403
)
assert.equal(
  (
    await authorized(`/api/organizations/${orgId}/users/${invitee.id}`, "PUT", {
      type: 2,
      collections: [],
    })
  ).status,
  200
)
assert.deepEqual(
  (await otherAuthorized("/api/sync", undefined, "GET")).body.collections,
  []
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).status,
  404
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}/archive`, undefined, "PUT"))
    .status,
  404
)
assert.equal((await fetch(memberSharedLink)).status, 404)
assert.equal(
  (
    await otherAuthorized(
      `/api/organizations/${orgId}/groups`,
      undefined,
      "GET"
    )
  ).status,
  403
)
const groupInput = {
  name: "Shared collection readers",
  accessAll: false,
  externalId: "directory-group-1",
  collections: [
    {
      id: secondCollection.body.id,
      readOnly: true,
      hidePasswords: false,
      manage: false,
    },
  ],
  users: [invitee.id],
}
const groupCreated = await authorized(
  `/api/organizations/${orgId}/groups`,
  "POST",
  groupInput
)
assert.equal(groupCreated.status, 200)
const groupId = groupCreated.body.id
assert.deepEqual(
  (await authorized(`/api/organizations/${orgId}/groups/details`)).body.data[0]
    .users,
  [invitee.id]
)
assert.deepEqual(
  (await otherAuthorized("/api/sync", undefined, "GET")).body.collections.map(
    (collection) => collection.id
  ),
  [secondCollection.body.id]
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).status,
  200
)
const groupAttachmentLink = (
  await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")
).body.attachments[0].url
assert.equal((await fetch(groupAttachmentLink)).status, 200)
const groupRevoked = await authorized(
  `/api/organizations/${orgId}/groups/${groupId}`,
  "PUT",
  { ...groupInput, users: [] }
)
assert.equal(groupRevoked.status, 200)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).status,
  404
)
assert.equal((await fetch(groupAttachmentLink)).status, 404)
assert.equal(
  (
    await authorized(`/api/organizations/${orgId}/users/${invitee.id}`, "PUT", {
      type: 2,
      collections: [],
      groups: [groupId],
    })
  ).status,
  200
)
assert.deepEqual(
  (await authorized(`/api/organizations/${orgId}/users/${invitee.id}`)).body
    .groups,
  [groupId]
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).status,
  200
)
assert.equal(
  (
    await authorized(`/api/organizations/${orgId}/users/${invitee.id}`, "PUT", {
      type: 2,
      collections: [],
      groups: [],
    })
  ).status,
  200
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).status,
  404
)
assert.equal(
  (await authorized(`/api/organizations/${orgId}/groups/${groupId}`, "DELETE"))
    .status,
  200
)
assert.equal(
  (
    await authorized(`/api/organizations/${orgId}/users/${invitee.id}`, "PUT", {
      type: 2,
      collections: [
        { id: secondCollection.body.id, readOnly: true, hidePasswords: false },
      ],
    })
  ).status,
  200
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).status,
  200
)
const memberNotificationSocket = await notificationSocket(
  `/notifications/hub?access_token=${encodeURIComponent(otherTokens.access_token)}`
)
const movedAwayNotification = nextSocketMessage(memberNotificationSocket)
const movedShared = await authorized(
  `/api/ciphers/${sharedId}/collections_v2`,
  "PUT",
  {
    collectionIds: [orgCollections.body.data[0].id],
  }
)
assert.equal(movedShared.status, 200)
assert.equal(decodeNotificationFrame(await movedAwayNotification)[4][0].Type, 5)
assert.equal(
  movedShared.body.cipher.collectionIds[0],
  orgCollections.body.data[0].id
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).status,
  404
)
assert.equal(
  (
    await authorized(`/api/ciphers/${sharedId}`, "PUT", {
      ...sharedCipherBody,
      collectionIds: [orgCollections.body.data[0].id],
      name: "2.hidden-from-member",
    })
  ).status,
  200
)
assert.equal(await noSocketMessage(memberNotificationSocket), true)
assert.equal((await fetch(memberSharedLink)).status, 404)
const movedBackNotification = nextSocketMessage(memberNotificationSocket)
assert.equal(
  (
    await authorized(`/api/ciphers/${sharedId}/collections`, "PUT", {
      collectionIds: [secondCollection.body.id],
    })
  ).status,
  200
)
assert.equal(decodeNotificationFrame(await movedBackNotification)[4][0].Type, 5)
memberNotificationSocket.close()
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).status,
  200
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, sharedCipherBody, "PUT"))
    .status,
  403
)
const removedMemberSocket = await notificationSocket(
  `/notifications/hub?access_token=${encodeURIComponent(otherTokens.access_token)}`
)
const removalNotification = nextSocketMessage(removedMemberSocket)
assert.equal(
  (
    await authorized(
      `/api/organizations/${orgId}/users/${invitee.id}`,
      "DELETE"
    )
  ).status,
  200
)
assert.equal(decodeNotificationFrame(await removalNotification)[4][0].Type, 5)
removedMemberSocket.close()
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).status,
  404
)
assert.equal((await fetch(memberSharedLink)).status, 404)
assert.deepEqual(
  (await otherAuthorized("/api/sync", undefined, "GET")).body.profile
    .organizations,
  []
)
assert.equal(
  (
    await authorized("/api/accounts/delete", "POST", {
      masterPasswordHash: "client-derived-secret",
    })
  ).status,
  409
)

const sendBody = {
  type: 0,
  name: "2.encrypted-send-name",
  key: "2.encrypted-send-key",
  text: { text: "2.encrypted-send-body", hidden: false },
  deletionDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  disabled: false,
  maxAccessCount: 1,
}
const send = await otherAuthorized("/api/sends", sendBody)
assert.equal(send.status, 200)
assert.equal(send.body.text.text, "2.encrypted-send-body")
assert.equal(
  (await otherAuthorized("/api/sends", undefined, "GET")).body.data.length,
  1
)
assert.equal(
  (
    await call(`/api/sends/${send.body.id}`, {
      headers: { Authorization: `Bearer ${refreshedTokens.access_token}` },
    })
  ).status,
  404
)
assert.equal(
  (await otherAuthorized("/api/sync", undefined, "GET")).body.sends.length,
  1
)

const sendAccessRequest = (accessId, password) =>
  fetch(`${origin}/identity/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "send_access",
      client_id: "web",
      send_id: accessId,
      ...(password ? { password_hash_b64: password } : {}),
    }),
  })
const raceSend = await otherAuthorized("/api/sends", sendBody)
assert.equal(raceSend.status, 200)
const race = await Promise.all([
  sendAccessRequest(raceSend.body.accessId),
  sendAccessRequest(raceSend.body.accessId),
])
assert.deepEqual(race.map((response) => response.status).sort(), [200, 404])
assert.equal(
  (await otherAuthorized(`/api/sends/${raceSend.body.id}`, undefined, "GET"))
    .body.accessCount,
  1
)
const sendAccess = await sendAccessRequest(send.body.accessId)
assert.equal(sendAccess.status, 200)
const sendToken = (await sendAccess.json()).access_token
assert.equal((await sendAccessRequest(send.body.accessId)).status, 404)
const received = await call("/api/sends/access", {
  method: "POST",
  headers: { Authorization: `Bearer ${sendToken}` },
})
assert.equal(received.status, 200)
assert.equal(received.body.text.text, "2.encrypted-send-body")
assert.equal(received.body.key, undefined)
assert.equal(received.body.creatorIdentifier, otherEmail)
assert.equal(
  (
    await call("/api/sends/access", {
      method: "POST",
      headers: { Authorization: `Bearer ${sendToken}` },
    })
  ).status,
  200
)

const passwordSend = await otherAuthorized("/api/sends", {
  ...sendBody,
  password: "recipient-secret",
  maxAccessCount: 2,
})
assert.equal(passwordSend.status, 200)
const missingPassword = await sendAccessRequest(passwordSend.body.accessId)
assert.equal(missingPassword.status, 400)
assert.equal(
  (await missingPassword.json()).send_access_error_type,
  "password_hash_b64_required"
)
assert.equal(
  (await sendAccessRequest(passwordSend.body.accessId, "wrong")).status,
  404
)
const passwordAccess = await sendAccessRequest(
  passwordSend.body.accessId,
  "recipient-secret"
)
assert.equal(passwordAccess.status, 200)
const passwordToken = (await passwordAccess.json()).access_token
assert.equal(
  (
    await call(`/api/sends/access/${passwordSend.body.accessId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "recipient-secret" }),
    })
  ).status,
  200
)
assert.equal(
  (await sendAccessRequest(passwordSend.body.accessId, "recipient-secret"))
    .status,
  404
)
assert.equal(
  (
    await otherAuthorized(
      `/api/sends/${passwordSend.body.id}`,
      {
        ...sendBody,
        password: null,
        disabled: true,
        maxAccessCount: 2,
      },
      "PUT"
    )
  ).status,
  200
)
assert.equal(
  (
    await call("/api/sends/access", {
      method: "POST",
      headers: { Authorization: `Bearer ${passwordToken}` },
    })
  ).status,
  404
)
assert.equal(
  (
    await otherAuthorized(
      `/api/sends/${passwordSend.body.id}/remove-password`,
      undefined,
      "PUT"
    )
  ).body.authType,
  2
)
assert.equal(
  (await otherAuthorized(`/api/sends/${send.body.id}`, undefined, "DELETE"))
    .status,
  200
)
assert.equal((await sendAccessRequest(send.body.accessId)).status, 404)

const fileSend = await otherAuthorized("/api/sends/file/v2", {
  ...sendBody,
  type: 1,
  text: null,
  file: { fileName: "2.encrypted-file-name" },
  fileLength: 4,
  maxAccessCount: 2,
})
assert.equal(fileSend.status, 200)
assert.equal(fileSend.body.fileUploadType, 0)
assert.equal(fileSend.body.sendResponse.file.size, "4")
const fileSendId = fileSend.body.sendResponse.id
const fileId = fileSend.body.sendResponse.file.id
assert.equal(
  (await sendAccessRequest(fileSend.body.sendResponse.accessId)).status,
  404
)
const wrongUpload = new FormData()
wrongUpload.append(
  "data",
  new File([new Uint8Array([5, 6, 7])], "2.encrypted-file-name")
)
assert.equal(
  (
    await fetch(`${origin}/api${fileSend.body.url}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${otherTokens.access_token}` },
      body: wrongUpload,
    })
  ).status,
  400
)
const fileUpload = new FormData()
fileUpload.append(
  "data",
  new File([new Uint8Array([5, 6, 7, 8])], "2.encrypted-file-name")
)
assert.equal(
  (
    await fetch(`${origin}/api${fileSend.body.url}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${otherTokens.access_token}` },
      body: fileUpload,
    })
  ).status,
  204
)
const fileGrant = await sendAccessRequest(fileSend.body.sendResponse.accessId)
assert.equal(fileGrant.status, 200)
const fileToken = (await fileGrant.json()).access_token
const fileMetadata = await call("/api/sends/access", {
  method: "POST",
  headers: { Authorization: `Bearer ${fileToken}` },
})
assert.equal(fileMetadata.body.file.id, fileId)
assert.equal(fileMetadata.body.key, undefined)
const fileLink = await call(`/api/sends/access/file/${fileId}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${fileToken}` },
})
assert.equal(fileLink.status, 200)
assert.equal(fileLink.body.object, "send-fileDownload")
assert.deepEqual(
  new Uint8Array(await (await fetch(fileLink.body.url)).arrayBuffer()),
  new Uint8Array([5, 6, 7, 8])
)
assert.equal(
  (await fetch(`${origin}/api/sends/${fileSendId}/${fileId}?t=invalid`)).status,
  404
)
const legacyFileLink = await call(
  `/api/sends/${fileSendId}/access/file/${fileId}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }
)
assert.equal(legacyFileLink.status, 200)
assert.equal((await fetch(legacyFileLink.body.url)).status, 200)
assert.equal(
  (await sendAccessRequest(fileSend.body.sendResponse.accessId)).status,
  404
)
assert.equal(
  (await otherAuthorized(`/api/sends/${fileSendId}`, undefined, "DELETE"))
    .status,
  200
)
assert.equal((await fetch(fileLink.body.url)).status, 404)

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

const emailFactorUser = `email-factor-${crypto.randomUUID()}@example.test`
assert.equal(
  (
    await registerWithEmail({
      email: emailFactorUser,
      masterPasswordHash: "email-factor-secret",
      key: "2.email-factor-key",
      kdf: 0,
      kdfIterations: 600_000,
    })
  ).status,
  200
)
const emailFactorLogin = await tokenRequest(
  emailFactorUser,
  "email-factor-secret"
)
assert.equal(emailFactorLogin.status, 200)
const emailFactorToken = (await emailFactorLogin.json()).access_token
const emailFactorAuthorized = (path, body, method = "POST") =>
  call(path, {
    method,
    headers: {
      Authorization: `Bearer ${emailFactorToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
assert.equal(
  (
    await emailFactorAuthorized("/api/two-factor/send-email", {
      email: emailFactorUser,
      masterPasswordHash: "wrong",
    })
  ).status,
  403
)
assert.equal(
  (
    await emailFactorAuthorized("/api/two-factor/send-email", {
      email: emailFactorUser,
      masterPasswordHash: "email-factor-secret",
    })
  ).status,
  200
)
const enrollmentCode = /verification code is (\d{6})/.exec(
  await invitationMail(emailFactorUser, "Cloudwarden verification code")
)?.[1]
assert.match(enrollmentCode, /^\d{6}$/)
assert.equal(
  (
    await emailFactorAuthorized(
      "/api/two-factor/email",
      {
        email: emailFactorUser,
        token: "000000",
        masterPasswordHash: "email-factor-secret",
      },
      "PUT"
    )
  ).status,
  400
)
assert.equal(
  (
    await emailFactorAuthorized(
      "/api/two-factor/email",
      {
        email: emailFactorUser,
        token: enrollmentCode,
        masterPasswordHash: "email-factor-secret",
      },
      "PUT"
    )
  ).status,
  200
)
assert.equal(
  (await emailFactorAuthorized("/api/two-factor", undefined, "GET")).body
    .data[0].type,
  1
)
const emailChallenge = await tokenRequest(
  emailFactorUser,
  "email-factor-secret"
)
assert.deepEqual((await emailChallenge.json()).TwoFactorProviders, ["1"])
assert.equal(
  (
    await post("/api/two-factor/send-email-login", {
      email: emailFactorUser,
      masterPasswordHash: "wrong",
    })
  ).status,
  400
)
assert.equal(
  (
    await post("/api/two-factor/send-email-login", {
      email: emailFactorUser,
      masterPasswordHash: "email-factor-secret",
    })
  ).status,
  200
)
let loginEmailCode
for (let attempt = 0; attempt < 30; attempt++) {
  loginEmailCode = /verification code is (\d{6})/.exec(
    await invitationMail(emailFactorUser, "Cloudwarden verification code")
  )?.[1]
  if (loginEmailCode && loginEmailCode !== enrollmentCode) break
  await delay(100)
}
assert.match(loginEmailCode, /^\d{6}$/)
assert.notEqual(loginEmailCode, enrollmentCode)
assert.equal(
  (
    await tokenRequest(emailFactorUser, "email-factor-secret", {
      two_factor_provider: "1",
      two_factor_token: loginEmailCode,
    })
  ).status,
  200
)
assert.equal(
  (
    await tokenRequest(emailFactorUser, "email-factor-secret", {
      two_factor_provider: "1",
      two_factor_token: loginEmailCode,
    })
  ).status,
  400
)
const combinedEnrollment = await emailFactorAuthorized(
  "/api/two-factor/get-authenticator",
  { masterPasswordHash: "email-factor-secret" }
)
assert.equal(combinedEnrollment.status, 200)
assert.equal(
  (
    await emailFactorAuthorized("/api/two-factor/authenticator", {
      masterPasswordHash: "email-factor-secret",
      key: combinedEnrollment.body.key,
      token: totp(combinedEnrollment.body.key, Math.floor(Date.now() / 30_000)),
    })
  ).status,
  200
)
const combinedChallenge = await tokenRequest(
  emailFactorUser,
  "email-factor-secret"
)
assert.deepEqual((await combinedChallenge.json()).TwoFactorProviders, [
  "0",
  "1",
])
const emailRecovery = await emailFactorAuthorized(
  "/api/two-factor/get-recover",
  { masterPasswordHash: "email-factor-secret" }
)
assert.match(emailRecovery.body.code, /^[A-Z2-7]{32}$/)
const emailRecovered = await tokenRequest(
  emailFactorUser,
  "email-factor-secret",
  {
    two_factor_provider: "8",
    two_factor_token: emailRecovery.body.code,
  }
)
assert.equal(emailRecovered.status, 200)
const emailRecoveredToken = (await emailRecovered.json()).access_token
assert.equal(
  (
    await call("/api/two-factor", {
      headers: { Authorization: `Bearer ${emailRecoveredToken}` },
    })
  ).body.data.length,
  0
)

const webauthnUser = `webauthn-${crypto.randomUUID()}@example.test`
assert.equal(
  (
    await registerWithEmail({
      email: webauthnUser,
      masterPasswordHash: "webauthn-secret",
      key: "2.webauthn-key",
      kdf: 0,
      kdfIterations: 600_000,
    })
  ).status,
  200
)
const webauthnInitialLogin = await tokenRequest(
  webauthnUser,
  "webauthn-secret",
  {},
  "203.0.113.70"
)
assert.equal(webauthnInitialLogin.status, 200)
const webauthnToken = (await webauthnInitialLogin.json()).access_token
const webauthnAuthorized = (path, body, method = "POST") =>
  call(path, {
    method,
    headers: {
      Authorization: `Bearer ${webauthnToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
const webauthnEnrollment = await webauthnAuthorized(
  "/api/two-factor/get-webauthn-challenge",
  { masterPasswordHash: "webauthn-secret" }
)
assert.equal(webauthnEnrollment.status, 200)
assert.equal(webauthnEnrollment.body.status, "ok")
const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
})
const jwk = publicKey.export({ format: "jwk" })
const credentialId = randomBytes(32).toString("base64url")
const rpIdHash = createHash("sha256").update("localhost").digest()
const authenticatorRegistration = Buffer.concat([
  rpIdHash,
  Buffer.from([0x41, 0, 0, 0, 0]),
  Buffer.alloc(16),
  Buffer.from([0, 32]),
  Buffer.from(credentialId, "base64url"),
  Buffer.from(
    encodeCBOR(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ])
    )
  ),
])
const registrationClientData = Buffer.from(
  JSON.stringify({
    type: "webauthn.create",
    challenge: webauthnEnrollment.body.challenge,
    origin,
  })
)
const webauthnRegistered = await webauthnAuthorized(
  "/api/two-factor/webauthn",
  {
    masterPasswordHash: "webauthn-secret",
    id: 1,
    name: "Smoke authenticator",
    deviceResponse: {
      id: credentialId,
      rawId: credentialId,
      response: {
        clientDataJson: registrationClientData.toString("base64url"),
        AttestationObject: Buffer.from(
          encodeCBOR(
            new Map([
              ["fmt", "none"],
              ["attStmt", new Map()],
              ["authData", authenticatorRegistration],
            ])
          )
        ).toString("base64url"),
      },
    },
  }
)
assert.equal(webauthnRegistered.status, 200, JSON.stringify(webauthnRegistered))
assert.equal(webauthnRegistered.body.keys[0].name, "Smoke authenticator")
const webauthnListing = await webauthnAuthorized(
  "/api/two-factor/get-webauthn",
  {
    masterPasswordHash: "webauthn-secret",
  }
)
assert.equal(webauthnListing.body.keys.length, 1)
const webauthnChallenge = await tokenRequest(
  webauthnUser,
  "webauthn-secret",
  {},
  "203.0.113.71"
)
assert.equal(webauthnChallenge.status, 400)
const webauthnChallengeBody = await webauthnChallenge.json()
assert.deepEqual(webauthnChallengeBody.TwoFactorProviders, ["7"])
const authenticationClientData = Buffer.from(
  JSON.stringify({
    type: "webauthn.get",
    challenge: webauthnChallengeBody.TwoFactorProviders2["7"].challenge,
    origin,
  })
)
const authenticatorAssertion = Buffer.concat([
  rpIdHash,
  Buffer.from([0x01, 0, 0, 0, 1]),
])
const assertion = JSON.stringify({
  id: credentialId,
  rawId: credentialId,
  response: {
    clientDataJson: authenticationClientData.toString("base64url"),
    authenticatorData: authenticatorAssertion.toString("base64url"),
    signature: sign(
      "sha256",
      Buffer.concat([
        authenticatorAssertion,
        createHash("sha256").update(authenticationClientData).digest(),
      ]),
      privateKey
    ).toString("base64url"),
  },
})
const webauthnVerified = await tokenRequest(
  webauthnUser,
  "webauthn-secret",
  { two_factor_provider: "7", two_factor_token: assertion },
  "203.0.113.72"
)
assert.equal(webauthnVerified.status, 200, await webauthnVerified.text())
assert.equal(
  (
    await tokenRequest(
      webauthnUser,
      "webauthn-secret",
      { two_factor_provider: "7", two_factor_token: assertion },
      "203.0.113.73"
    )
  ).status,
  400
)
const webauthnRecovery = await webauthnAuthorized(
  "/api/two-factor/get-recover",
  { masterPasswordHash: "webauthn-secret" }
)
assert.match(webauthnRecovery.body.code, /^[A-Z2-7]{32}$/)
const webauthnRecovered = await tokenRequest(
  webauthnUser,
  "webauthn-secret",
  {
    two_factor_provider: "8",
    two_factor_token: webauthnRecovery.body.code,
  },
  "203.0.113.74"
)
assert.equal(webauthnRecovered.status, 200)
const webauthnRecoveredToken = (await webauthnRecovered.json()).access_token
assert.equal(
  (
    await call("/api/two-factor", {
      headers: { Authorization: `Bearer ${webauthnRecoveredToken}` },
    })
  ).body.data.length,
  0
)

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
const rememberedDeviceId = crypto.randomUUID()
const otpLogin = await tokenRequest(
  otherEmail,
  "second-secret",
  {
    two_factor_provider: "0",
    two_factor_token: totp(enrollment.body.key, step),
    two_factor_remember: "1",
    deviceIdentifier: rememberedDeviceId,
  },
  "203.0.113.41"
)
assert.equal(otpLogin.status, 200)
const otpTokens = await otpLogin.json()
assert.ok(otpTokens.access_token)
assert.match(otpTokens.TwoFactorToken, /^[A-Za-z0-9_-]{43}$/)
const rememberedLogin = await tokenRequest(
  otherEmail,
  "second-secret",
  {
    two_factor_provider: "5",
    two_factor_token: otpTokens.TwoFactorToken,
    deviceIdentifier: rememberedDeviceId,
  },
  "203.0.113.42"
)
assert.equal(rememberedLogin.status, 200)
assert.equal((await rememberedLogin.json()).TwoFactorToken, undefined)
const rotatedRememberLogin = await tokenRequest(
  otherEmail,
  "second-secret",
  {
    two_factor_provider: "5",
    two_factor_token: otpTokens.TwoFactorToken,
    two_factor_remember: "1",
    deviceIdentifier: rememberedDeviceId,
  },
  "203.0.113.46"
)
assert.equal(rotatedRememberLogin.status, 200)
const rotatedRememberToken = (await rotatedRememberLogin.json()).TwoFactorToken
assert.match(rotatedRememberToken, /^[A-Za-z0-9_-]{43}$/)
assert.notEqual(rotatedRememberToken, otpTokens.TwoFactorToken)
assert.equal(
  (
    await tokenRequest(
      otherEmail,
      "second-secret",
      {
        two_factor_provider: "5",
        two_factor_token: otpTokens.TwoFactorToken,
        deviceIdentifier: rememberedDeviceId,
      },
      "203.0.113.47"
    )
  ).status,
  400
)
assert.equal(
  (
    await tokenRequest(
      otherEmail,
      "second-secret",
      {
        two_factor_provider: "5",
        two_factor_token: rotatedRememberToken,
        deviceIdentifier: crypto.randomUUID(),
      },
      "203.0.113.43"
    )
  ).status,
  400
)
assert.equal(
  (
    await tokenRequest(
      otherEmail,
      "second-secret",
      {
        two_factor_provider: "5",
        two_factor_token: "wrong",
        deviceIdentifier: rememberedDeviceId,
      },
      "203.0.113.44"
    )
  ).status,
  400
)
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
const reenabledTotp = await post(
  "/api/two-factor/authenticator",
  {
    masterPasswordHash: "second-secret",
    key: enrollment.body.key,
    token: totp(enrollment.body.key, Math.floor(Date.now() / 30_000)),
  },
  recoveredTokens.access_token
)
assert.equal(reenabledTotp.status, 200)
assert.equal(
  (
    await tokenRequest(
      otherEmail,
      "second-secret",
      {
        two_factor_provider: "5",
        two_factor_token: rotatedRememberToken,
        deviceIdentifier: rememberedDeviceId,
      },
      "203.0.113.45"
    )
  ).status,
  400
)
assert.equal(
  (
    await post(
      "/api/two-factor/disable",
      {
        masterPasswordHash: "second-secret",
        type: 0,
      },
      recoveredTokens.access_token
    )
  ).status,
  200
)
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
const profileEdit = await call("/api/accounts/profile", {
  method: "PUT",
  headers: {
    Authorization: `Bearer ${recoveredTokens.access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name: "Updated Vault User" }),
})
assert.equal(profileEdit.status, 200)
assert.equal(profileEdit.body.name, "Updated Vault User")
const newKeys = await call("/api/accounts/keys", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${recoveredTokens.access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    encryptedPrivateKey: "2.new-private-key",
    publicKey: "new-public-key",
  }),
})
assert.equal(newKeys.status, 200)
assert.equal(newKeys.body.privateKey, "2.new-private-key")
const finalProfile = await call("/api/accounts/profile", {
  headers: { Authorization: `Bearer ${recoveredTokens.access_token}` },
})
assert.equal(finalProfile.body.privateKey, "2.new-private-key")

const currentAuthorized = (path, body, method = "POST") =>
  call(path, {
    method,
    headers: {
      Authorization: `Bearer ${recoveredTokens.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
const deletionCipher = await currentAuthorized("/api/ciphers", {
  type: 1,
  name: "2.to-be-deleted",
})
assert.equal(deletionCipher.status, 200)
const deletionAttachment = await currentAuthorized(
  `/api/ciphers/${deletionCipher.body.id}/attachment/v2`,
  { fileName: "2.delete-file", fileSize: 3, key: "2.delete-key" }
)
assert.equal(deletionAttachment.status, 200)
const deletionUpload = new FormData()
deletionUpload.append(
  "data",
  new File([new Uint8Array([9, 8, 7])], "cipher.bin")
)
assert.equal(
  (
    await fetch(`${origin}/api${deletionAttachment.body.url}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${recoveredTokens.access_token}` },
      body: deletionUpload,
    })
  ).status,
  204
)
const deletionCipherDetails = await currentAuthorized(
  `/api/ciphers/${deletionCipher.body.id}`,
  undefined,
  "GET"
)
const attachmentUrl = deletionCipherDetails.body.attachments[0].url
assert.equal((await fetch(attachmentUrl)).status, 200)

const deletionFileSend = await currentAuthorized("/api/sends/file/v2", {
  ...sendBody,
  type: 1,
  text: null,
  file: { fileName: "2.delete-send-file" },
  fileLength: 3,
})
assert.equal(deletionFileSend.status, 200)
const deletionSendUpload = new FormData()
deletionSendUpload.append(
  "data",
  new File([new Uint8Array([4, 3, 2])], "2.delete-send-file")
)
assert.equal(
  (
    await fetch(`${origin}/api${deletionFileSend.body.url}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${recoveredTokens.access_token}` },
      body: deletionSendUpload,
    })
  ).status,
  204
)
const deletionSendGrant = await sendAccessRequest(
  deletionFileSend.body.sendResponse.accessId
)
assert.equal(deletionSendGrant.status, 200)
const deletionSendToken = (await deletionSendGrant.json()).access_token
const deletionFileLink = await call(
  `/api/sends/access/file/${deletionFileSend.body.sendResponse.file.id}`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${deletionSendToken}` },
  }
)
assert.equal(deletionFileLink.status, 200)
assert.equal((await fetch(deletionFileLink.body.url)).status, 200)
assert.equal(
  (
    await currentAuthorized("/api/accounts/delete", {
      masterPasswordHash: "wrong",
    })
  ).status,
  403
)
assert.equal(
  (await currentAuthorized("/api/accounts/request-otp", {})).status,
  200
)
const deletionSecurityMail = await invitationMail(
  otherEmail,
  "Cloudwarden security code"
)
const deletionSecurityCode = /security code is (\d{6})/.exec(
  deletionSecurityMail
)?.[1]
assert.ok(deletionSecurityCode)
assert.equal(
  (
    await currentAuthorized("/api/accounts/delete", {
      otp: deletionSecurityCode,
    })
  ).status,
  200
)
assert.equal(
  (await currentAuthorized("/api/accounts/profile", undefined, "GET")).status,
  401
)
assert.equal((await tokenRequest(otherEmail, "third-secret")).status, 400)
assert.equal((await fetch(attachmentUrl)).status, 404)
assert.equal((await fetch(deletionFileLink.body.url)).status, 404)
assert.equal(
  (await sendAccessRequest(deletionFileSend.body.sendResponse.accessId)).status,
  404
)
assert.equal(
  (
    await authorized(`/api/organizations/${orgId}`, "DELETE", {
      masterPasswordHash: "wrong",
    })
  ).status,
  403
)
const importPath = `/api/ciphers/import-organization?organizationId=${orgId}`
assert.equal(
  (
    await authorized(importPath, "POST", {
      collections: [{ name: "2.bad-import-collection" }],
      ciphers: [{ type: 1, name: "2.bad-import-cipher" }],
      collectionRelationships: [{ key: 0, value: 1 }],
    })
  ).status,
  400
)
const beforeOrgImport = await authorized(`/api/organizations/${orgId}/export`)
assert.equal(
  (
    await authorized(importPath, "POST", {
      collections: [
        { name: "2.imported-collection", externalId: "external-2" },
        { id: secondCollection.body.id, name: "2.existing-collection" },
      ],
      ciphers: [
        {
          type: 1,
          name: "2.imported-org-login",
          login: { username: "2.secret" },
          archivedDate,
        },
        { type: 2, name: "2.imported-org-note", secureNote: { type: 0 } },
      ],
      collectionRelationships: [
        { key: 0, value: 0 },
        { key: 1, value: 1 },
      ],
    })
  ).status,
  200
)
const afterOrgImport = await authorized(`/api/organizations/${orgId}/export`)
assert.equal(
  afterOrgImport.body.collections.length,
  beforeOrgImport.body.collections.length + 1
)
assert.equal(
  afterOrgImport.body.ciphers.length,
  beforeOrgImport.body.ciphers.length + 2
)
const importedOrgCollection = afterOrgImport.body.collections.find(
  (row) => row.name === "2.imported-collection"
)
assert.ok(importedOrgCollection)
const importedOrgLogin = afterOrgImport.body.ciphers.find(
  (row) => row.name === "2.imported-org-login"
)
assert.equal(importedOrgLogin.organizationId, orgId)
assert.equal(importedOrgLogin.folderId, null)
assert.equal(importedOrgLogin.archivedDate, archivedDate)
assert.deepEqual(importedOrgLogin.collectionIds, [importedOrgCollection.id])
assert.deepEqual(
  afterOrgImport.body.ciphers.find((row) => row.name === "2.imported-org-note")
    .collectionIds,
  [secondCollection.body.id]
)
assert.ok(
  (await authorized("/api/sync")).body.ciphers.some(
    (row) => row.id === importedOrgLogin.id
  )
)
assert.equal(
  (
    await authorized("/api/accounts/security-stamp", "POST", {
      masterPasswordHash: "wrong",
    })
  ).status,
  403
)
const revokedAccessToken = currentAccessToken
const revokedNotificationSocket = await notificationSocket(
  `/notifications/hub?access_token=${encodeURIComponent(revokedAccessToken)}`
)
const logoutNotification = nextSocketMessage(revokedNotificationSocket)
assert.equal(
  (
    await authorized("/api/accounts/security-stamp", "POST", {
      masterPasswordHash: "client-derived-secret",
    })
  ).status,
  200
)
assert.equal(decodeNotificationFrame(await logoutNotification)[4][0].Type, 11)
revokedNotificationSocket.close()
assert.equal(
  (
    await call("/api/sync", {
      headers: { Authorization: `Bearer ${revokedAccessToken}` },
    })
  ).status,
  401
)
assert.equal(
  (
    await call("/api/devices/knowndevice", {
      headers: {
        "X-Request-Email": Buffer.from(email).toString("base64url"),
        "X-Device-Identifier": loginDeviceId,
      },
    })
  ).body,
  true
)
assert.equal(
  (
    await post("/identity/connect/token", {
      grant_type: "refresh_token",
      refresh_token: refreshedTokens.refresh_token,
    })
  ).status,
  400
)
const postStampApiLogin = await apiLogin(otpRotatedApiKey.body.apiKey)
assert.equal(postStampApiLogin.status, 200)
currentAccessToken = (await postStampApiLogin.json()).access_token
assert.equal(
  (await post("/api/accounts/delete-recover", { email })).status,
  200
)
const ownerDeletionMail = await invitationMail(
  email,
  "Delete your Cloudwarden account"
)
const ownerDeletionLink = ownerDeletionMail.match(/https?:\/\/\S+/)?.[0]
assert.ok(ownerDeletionLink)
const ownerDeletionParams = new URLSearchParams(
  new URL(ownerDeletionLink).hash.split("?")[1]
)
assert.equal(
  (
    await post("/api/accounts/delete-recover-token", {
      userId: ownerDeletionParams.get("userId"),
      token: ownerDeletionParams.get("token"),
    })
  ).status,
  409
)
assert.equal(
  (
    await authorized(`/api/organizations/${orgId}`, "DELETE", {
      masterPasswordHash: "client-derived-secret",
    })
  ).status,
  200
)
assert.equal((await authorized(`/api/ciphers/${sharedId}`)).status, 404)
assert.equal((await fetch(ownerSharedLink)).status, 404)
assert.deepEqual((await authorized("/api/sync")).body.profile.organizations, [])
assert.equal(
  (
    await authorized("/api/accounts/delete", "POST", {
      masterPasswordHash: "client-derived-secret",
    })
  ).status,
  200
)
assert.equal(
  (
    await post("/api/accounts/delete-recover", {
      email: "missing@example.test",
    })
  ).status,
  200
)
assert.equal(
  (await post("/api/accounts/delete-recover", { email: emailFactorUser }))
    .status,
  200
)
const recoveryDeletionMail = await invitationMail(
  emailFactorUser,
  "Delete your Cloudwarden account"
)
const recoveryDeletionLink = recoveryDeletionMail.match(/https?:\/\/\S+/)?.[0]
assert.ok(recoveryDeletionLink)
const recoveryDeletionParams = new URLSearchParams(
  new URL(recoveryDeletionLink).hash.split("?")[1]
)
const recoveryDeletionId = recoveryDeletionParams.get("userId")
const recoveryDeletionToken = recoveryDeletionParams.get("token")
assert.match(recoveryDeletionId, /^[0-9a-f-]{36}$/i)
assert.ok(recoveryDeletionToken)
assert.equal(
  (
    await post("/api/accounts/delete-recover-token", {
      userId: recoveryDeletionId,
      token: `${recoveryDeletionToken}tampered`,
    })
  ).status,
  400
)
assert.equal(
  (
    await post("/api/accounts/delete-recover-token", {
      userId: sync.body.profile.id,
      token: recoveryDeletionToken,
    })
  ).status,
  400
)
assert.equal(
  (
    await post("/api/accounts/delete-recover-token", {
      userId: recoveryDeletionId,
      token: recoveryDeletionToken,
    })
  ).status,
  200
)
assert.equal(
  (
    await tokenRequest(
      emailFactorUser,
      "email-factor-secret",
      {},
      "203.0.113.75"
    )
  ).status,
  400
)
assert.equal(
  (
    await post("/api/accounts/delete-recover-token", {
      userId: recoveryDeletionId,
      token: recoveryDeletionToken,
    })
  ).status,
  400
)

console.log(
  "Bitwarden auth, vault lifecycle, account changes and deletion, Sends, two-factor, and isolation passed"
)
