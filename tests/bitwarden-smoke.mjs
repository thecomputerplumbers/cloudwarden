import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"

const origin = process.argv[2]
const storage = process.argv[3]
assert.ok(origin?.startsWith("http://localhost:"))
assert.ok(storage?.startsWith("/tmp/starter-review."))

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

const webEmail = `web-${crypto.randomUUID()}@example.test`
const registrationStart = await fetch(
  `${origin}/identity/accounts/register/send-verification-email`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: webEmail, name: "Web Test" }),
  }
)
assert.equal(registrationStart.status, 200)
const registrationToken = await registrationStart.json()
assert.equal(typeof registrationToken, "string")
const finishBody = {
  email: webEmail,
  emailVerificationToken: registrationToken,
  masterPasswordAuthentication: {
    hash: "web-client-derived-secret",
    salt: webEmail,
    kdf: { kdfType: 0, iterations: 600_000 },
  },
  masterPasswordUnlock: {
    key: "2.web-encrypted-key",
    salt: webEmail,
    kdf: { kdfType: 0, iterations: 600_000 },
  },
  keys: {
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
const refreshedTokens = await refreshed.json()
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
const sharedCipherBody = {
  type: 1,
  name: "2.encrypted-shared-name",
  organizationId: orgId,
  collectionIds: [secondCollection.body.id],
  login: { username: "2.encrypted-shared-login" },
}
const sharedCipher = await authorized("/api/ciphers", "POST", sharedCipherBody)
assert.equal(sharedCipher.status, 200)
assert.equal(sharedCipher.body.organizationId, orgId)
assert.deepEqual(sharedCipher.body.collectionIds, [secondCollection.body.id])
const sharedId = sharedCipher.body.id
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
  (await otherAuthorized("/api/ciphers", sharedCipherBody)).status,
  404
)
const editedShared = await authorized(`/api/ciphers/${sharedId}`, "PUT", {
  ...sharedCipherBody,
  name: "2.edited-shared-name",
})
assert.equal(editedShared.status, 200)
assert.equal(editedShared.body.name, "2.edited-shared-name")
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
  409
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
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).status,
  200
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
assert.equal((await fetch(memberSharedLink)).status, 404)
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
const movedShared = await authorized(
  `/api/ciphers/${sharedId}/collections_v2`,
  "PUT",
  {
    collectionIds: [orgCollections.body.data[0].id],
  }
)
assert.equal(movedShared.status, 200)
assert.equal(
  movedShared.body.cipher.collectionIds[0],
  orgCollections.body.data[0].id
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).status,
  404
)
assert.equal((await fetch(memberSharedLink)).status, 404)
assert.equal(
  (
    await authorized(`/api/ciphers/${sharedId}/collections`, "PUT", {
      collectionIds: [secondCollection.body.id],
    })
  ).status,
  200
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, undefined, "GET")).status,
  200
)
assert.equal(
  (await otherAuthorized(`/api/ciphers/${sharedId}`, sharedCipherBody, "PUT"))
    .status,
  403
)
assert.equal(
  (
    await authorized(
      `/api/organizations/${orgId}/users/${invitee.id}`,
      "DELETE"
    )
  ).status,
  200
)
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
  (
    await currentAuthorized("/api/accounts/delete", {
      masterPasswordHash: "third-secret",
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

console.log(
  "Bitwarden auth, vault lifecycle, account changes and deletion, Sends, two-factor, and isolation passed"
)
