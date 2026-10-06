import { createMailer } from "@workspace/email"

import {
  authenticatedVaultUser,
  beginVaultDeletion,
  createVaultUser,
  createVaultStubUser,
  findVaultUser,
  findVaultUserById,
  initializeVaultPassword,
  issueVaultSession,
  normalizeEmail,
  refreshVaultSession,
  tokenHash,
  updateVaultKeys,
  updateVaultPassword,
  updateVaultProfile,
  verifyVaultPassword,
  type VaultUser,
} from "./bitwarden-auth"
import type { AppDatabase } from "./database"
import {
  disableTotp,
  enableTotp,
  getTotp,
  matchingTotpStep,
  newTotpSecret,
  redeemTotpRecoveryCode,
  verifyTotpLogin,
} from "./bitwarden-totp"
import {
  createSendLocator,
  deleteSendLocator,
  getSendLocator,
  hashSendPassword,
  newSendAccessToken,
  newSendPasswordSalt,
  parseSend,
  sendAccessId,
  sendAccessResponse,
  sendIdFromAccessId,
  sendResponse,
} from "./bitwarden-send"
import { cleanupVaultDeletion } from "./bitwarden-delete"
import {
  issueRegistrationToken,
  verifyRegistrationToken,
} from "./bitwarden-register"
import {
  consumeVaultSso,
  finishVaultSsoCallback,
  prevalidateVaultSso,
  redeemVaultSso,
  startVaultSso,
} from "./bitwarden-sso"
import {
  collectionResponse,
  beginOrgDeletion,
  acceptOrgMember,
  cleanupOrgDeletion,
  confirmOrgMember,
  createOrgCipherLocator,
  createVaultCollection,
  deleteEmptyVaultCollection,
  createVaultOrganization,
  deleteOrgCipherLocator,
  getOrgCipherLocator,
  getVaultMembership,
  getVaultCollection,
  getVaultOrganization,
  isLastVaultOwner,
  inviteOrgMember,
  listOrgCipherLocators,
  listOrgMembers,
  orgMemberCollections,
  listVaultCollections,
  listVaultOrganizations,
  organizationResponse,
  profileOrganizationResponse,
  removeOrgMember,
  setOrgCipherCollections,
  setOrgMemberCollections,
  validOrgCollections,
  updateVaultCollection,
  updateVaultOrganization,
} from "./bitwarden-org"
import {
  invitationMailEnabled,
  invitationOrigin,
  sendOrgInvite,
  validOrgInvite,
} from "./bitwarden-invite"
import {
  confirmEmailEnrollment,
  disableEmailTwoFactor,
  emailTwoFactorAvailable,
  getEmailTwoFactor,
  redeemEmailRecoveryCode,
  sendEmailEnrollment,
  sendEmailLogin,
  verifyEmailLogin,
} from "./bitwarden-email"
import { completeVaultShare, startVaultShare } from "./bitwarden-share"
import {
  completeOrgImport,
  startOrgImport,
  type OrgImportPlan,
} from "./bitwarden-org-import"

type Body = Record<string, unknown>
type CipherRow = NonNullable<Awaited<ReturnType<AppDatabase["getVaultCipher"]>>>

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

function failure(message: string, status = 400) {
  return json({ error: message, error_description: message }, status)
}

async function keepCompletedUpload(
  env: CloudflareEnv,
  key: string,
  complete: () => Promise<boolean>
) {
  try {
    if (await complete()) return true
  } catch {
    // The account may have entered deletion after the R2 write.
  }
  await env.VAULT_ATTACHMENTS.delete(key)
  return false
}

function field(body: Body, name: string) {
  const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
  const key = Object.keys(body).find(
    (candidate) =>
      candidate.toLowerCase().replaceAll(/[^a-z0-9]/g, "") === normalized
  )
  return key ? body[key] : undefined
}

function stringField(body: Body, name: string) {
  const value = field(body, name)
  return typeof value === "string" ? value : undefined
}

function numberField(body: Body, name: string) {
  const value = field(body, name)
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined
}

function integerField(body: Body, name: string) {
  const value = field(body, name)
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  return undefined
}

function collectionIdsField(body: Body) {
  const value = field(body, "collectionIds")
  return Array.isArray(value) &&
    value.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id))
    ? (value as string[])
    : null
}

async function bodyOf(request: Request): Promise<Body | null> {
  const text = await request.text()
  if (text.length > 1_000_000) return null
  try {
    if (request.headers.get("Content-Type")?.includes("form-urlencoded"))
      return Object.fromEntries(new URLSearchParams(text))
    const value: unknown = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Body)
      : null
  } catch {
    return null
  }
}

function registrationsAllowed(env: CloudflareEnv) {
  return (
    (env as CloudflareEnv & { SIGNUPS_ALLOWED?: string }).SIGNUPS_ALLOWED ===
    "true"
  )
}

function registrationEmailVerificationRequired(env: CloudflareEnv) {
  return (
    (env as CloudflareEnv & { SIGNUPS_VERIFY?: string }).SIGNUPS_VERIFY !==
    "false"
  )
}

async function enabledTwoFactors(env: CloudflareEnv, userId: string) {
  const [totp, email] = await Promise.all([
    getTotp(env, userId),
    getEmailTwoFactor(env, userId),
  ])
  return { totp, email: email?.email ? email : null }
}

function twoFactorChallenge(
  factors: Awaited<ReturnType<typeof enabledTwoFactors>>
) {
  const providers = [
    ...(factors.totp ? ["0"] : []),
    ...(factors.email ? ["1"] : []),
  ]
  const email = factors.email?.email
  const maskedEmail = email ? `${email[0]}***@${email.split("@")[1]}` : null
  return json(
    {
      error: "invalid_grant",
      error_description: "Two factor required.",
      TwoFactorProviders: providers,
      TwoFactorProviders2: {
        ...(factors.totp ? { "0": null } : {}),
        ...(maskedEmail ? { "1": { Email: maskedEmail } } : {}),
      },
      MasterPasswordPolicy: { Object: "masterPasswordPolicy" },
    },
    400
  )
}

async function verifySecondFactor(
  env: CloudflareEnv,
  userId: string,
  factors: Awaited<ReturnType<typeof enabledTwoFactors>>,
  provider: number,
  code: string
) {
  if (provider === 0 && factors.totp)
    return verifyTotpLogin(env, factors.totp, code)
  if (provider === 1 && factors.email)
    return verifyEmailLogin(env, userId, code)
  if (provider === 8)
    return (
      (factors.totp && (await redeemTotpRecoveryCode(env, userId, code))) ||
      (factors.email && (await redeemEmailRecoveryCode(env, userId, code))) ||
      false
    )
  return false
}

function profile(
  user: VaultUser,
  twoFactorEnabled = false,
  organizations: unknown[] = []
) {
  const accountKeys =
    user.privateKey && user.publicKey
      ? {
          publicKeyEncryptionKeyPair: {
            wrappedPrivateKey: user.privateKey,
            publicKey: user.publicKey,
            signedPublicKey: null,
            object: "publicKeyEncryptionKeyPair",
          },
          securityState: null,
          signatureKeyPair: null,
          object: "privateKeys",
        }
      : null
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    premium: true,
    premiumFromOrganization: false,
    culture: "en-US",
    twoFactorEnabled,
    key: user.key,
    privateKey: user.privateKey,
    accountKeys,
    securityStamp: user.securityStamp,
    organizations,
    providers: [],
    providerOrganizations: [],
    forcePasswordReset: false,
    avatarColor: null,
    usesKeyConnector: false,
    creationDate: user.createdAt.toISOString(),
    object: "profile",
  }
}

function tokenResponse(
  user: VaultUser,
  tokens: { access: string; refresh: string; expiresIn: number }
) {
  const hasMasterPassword = !!user.passwordHash
  const accountKeys =
    user.privateKey && user.publicKey
      ? {
          publicKeyEncryptionKeyPair: {
            wrappedPrivateKey: user.privateKey,
            publicKey: user.publicKey,
            Object: "publicKeyEncryptionKeyPair",
          },
          Object: "privateKeys",
        }
      : null
  return {
    access_token: tokens.access,
    refresh_token: tokens.refresh,
    expires_in: tokens.expiresIn,
    token_type: "Bearer",
    scope: "api offline_access",
    ...(user.key ? { Key: user.key } : {}),
    PrivateKey: user.privateKey,
    AccountKeys: accountKeys,
    Kdf: user.kdf,
    KdfIterations: user.kdfIterations,
    KdfMemory: user.kdfMemory,
    KdfParallelism: user.kdfParallelism,
    ResetMasterPassword: false,
    ForcePasswordReset: false,
    UserDecryptionOptions: {
      HasMasterPassword: hasMasterPassword,
      MasterPasswordUnlock: hasMasterPassword
        ? {
            Kdf: {
              KdfType: user.kdf,
              Iterations: user.kdfIterations,
              Memory: user.kdfMemory,
              Parallelism: user.kdfParallelism,
            },
            MasterKeyEncryptedUserKey: user.key,
            MasterKeyWrappedUserKey: user.key,
            Salt: user.email,
          }
        : null,
      Object: "userDecryptionOptions",
    },
  }
}

async function attachmentResponse(
  vault: Awaited<ReturnType<CloudflareEnv["APP_DATABASE"]["getByName"]>>,
  attachment: {
    id: string
    cipherId: string
    fileName: string
    key: string | null
    size: number
  },
  userId: string,
  origin: string,
  orgId?: string
) {
  const token = await vault.issueVaultAttachmentToken(
    attachment.id,
    attachment.cipherId,
    userId
  )
  if (!token) throw new Error("Attachment became unavailable")
  return {
    id: attachment.id,
    url: `${origin}/attachments/${attachment.cipherId}/${attachment.id}?token=${orgId ? `${orgId}:${userId}` : userId}.${token}`,
    fileName: attachment.fileName,
    size: String(attachment.size),
    key: attachment.key,
    object: "attachment",
  }
}

async function cipherResponse(
  row: CipherRow,
  vault: Awaited<ReturnType<CloudflareEnv["APP_DATABASE"]["getByName"]>>,
  userId: string,
  origin: string,
  organization?: { id: string; collectionIds: string[] }
) {
  const data = JSON.parse(row.payload) as Body
  const attachments = await vault.listVaultAttachments(row.id)
  return {
    object: "cipherDetails",
    id: row.id,
    type: numberField(data, "type"),
    creationDate: row.createdAt.toISOString(),
    revisionDate: row.updatedAt.toISOString(),
    deletedDate: row.deletedAt?.toISOString() ?? null,
    reprompt: numberField(data, "reprompt") ?? 0,
    organizationId: organization?.id ?? null,
    key: field(data, "key") ?? null,
    attachments: attachments.length
      ? await Promise.all(
          attachments.map((attachment) =>
            attachmentResponse(
              vault,
              attachment,
              userId,
              origin,
              organization?.id
            )
          )
        )
      : null,
    organizationUseTotp: true,
    collectionIds: organization?.collectionIds ?? [],
    name: stringField(data, "name"),
    notes: field(data, "notes") ?? null,
    fields: field(data, "fields") ?? [],
    passwordHistory: field(data, "passwordHistory") ?? [],
    login: field(data, "login") ?? null,
    secureNote: field(data, "secureNote") ?? null,
    card: field(data, "card") ?? null,
    identity: field(data, "identity") ?? null,
    sshKey: field(data, "sshKey") ?? null,
    folderId: field(data, "folderId") ?? null,
    favorite: field(data, "favorite") === true,
    archivedDate: field(data, "archivedDate") ?? null,
    edit: true,
    viewPassword: true,
    permissions: { delete: true, restore: true },
  }
}

async function sharedCipherResponses(
  env: CloudflareEnv,
  userId: string,
  origin: string
) {
  const organizations = await listVaultOrganizations(env, userId)
  const responses = await Promise.all(
    organizations.map(async ({ organization, membership }) => {
      const allowed = new Set(
        (await listVaultCollections(env, organization.id, membership)).map(
          (row) => row.id
        )
      )
      const locators = await listOrgCipherLocators(env, organization.id)
      const orgVault = await env.APP_DATABASE.getByName(
        `org:${organization.id}`
      )
      const ciphers = await Promise.all(
        locators.map(async (locator) => {
          if (!locator || !locator.collectionIds.some((id) => allowed.has(id)))
            return null
          const row = await orgVault.getVaultCipher(locator.id)
          return row
            ? cipherResponse(row, orgVault, userId, origin, {
                id: organization.id,
                collectionIds: locator.collectionIds.filter((id) =>
                  allowed.has(id)
                ),
              })
            : null
        })
      )
      return ciphers.filter((cipher) => cipher !== null)
    })
  )
  return responses.flat()
}

function folderResponse(row: { id: string; name: string; updatedAt: Date }) {
  return {
    id: row.id,
    name: row.name,
    revisionDate: row.updatedAt.toISOString(),
    object: "folder",
  }
}

function list(data: unknown[]) {
  return { data, object: "list", continuationToken: null }
}

export function isBitwardenPath(path: string) {
  return (
    path.startsWith("/attachments/") ||
    path.startsWith("/identity/") ||
    path === "/api/config" ||
    path === "/api/alive" ||
    path === "/api/now" ||
    path === "/api/version" ||
    path === "/api/sync" ||
    path === "/api/collections" ||
    path === "/api/organizations" ||
    path.startsWith("/api/organizations/") ||
    path.startsWith("/api/users/") ||
    path === "/api/settings/domains" ||
    path === "/api/ciphers" ||
    path.startsWith("/api/ciphers/") ||
    path === "/api/folders" ||
    path.startsWith("/api/folders/") ||
    path === "/api/accounts" ||
    path.startsWith("/api/accounts/") ||
    path === "/api/two-factor" ||
    path.startsWith("/api/two-factor/") ||
    path === "/api/sends" ||
    path.startsWith("/api/sends/")
  )
}

async function issuePublicSendAccess(
  env: CloudflareEnv,
  request: Request,
  accessId: string,
  password: string | null
) {
  const id = sendIdFromAccessId(accessId)
  if (!id) return { error: "unavailable" as const }
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown"
  const limiter = await env.APP_DATABASE.getByName("bitwarden-send-rates")
  const allowed = await limiter.consumeRateLimit(`send:${ip}`, 30, 60_000)
  if (!allowed.allowed) return { error: "limited" as const }
  const locator = await getSendLocator(env, id)
  if (!locator) return { error: "unavailable" as const }
  if (!(await findVaultUserById(env, locator.userId)))
    return { error: "unavailable" as const }
  const vault = await env.APP_DATABASE.getByName(`vault:${locator.userId}`)
  const salt = await vault.getVaultSendPasswordSalt(id)
  const passwordHash =
    password && salt ? await hashSendPassword(password, salt) : null
  const access = await newSendAccessToken(id)
  const result = await vault.issueVaultSendAccess(id, passwordHash, access.hash)
  return result === "ok"
    ? { token: access.token, userId: locator.userId }
    : { error: result }
}

async function publicSendRecord(env: CloudflareEnv, bearer: string) {
  const [accessId] = bearer.split(".")
  const id = accessId && sendIdFromAccessId(accessId)
  if (!id) return null
  const locator = await getSendLocator(env, id)
  if (!locator) return null
  const vault = await env.APP_DATABASE.getByName(`vault:${locator.userId}`)
  const send = await vault.accessVaultSend(id, await tokenHash(bearer))
  const user = send && (await findVaultUserById(env, locator.userId))
  return send && user
    ? { send, userId: user.id, email: user.email, vault }
    : null
}

async function readPublicSend(env: CloudflareEnv, bearer: string) {
  const record = await publicSendRecord(env, bearer)
  return record ? sendAccessResponse(record.send, record.email) : null
}

async function publicSendFileLink(
  env: CloudflareEnv,
  origin: string,
  bearer: string,
  id: string,
  fileId: string
) {
  const record = await publicSendRecord(env, bearer)
  if (!record || record.send.id !== id) return null
  const token = await newSendAccessToken(id)
  if (!(await record.vault.issueVaultSendDownload(id, fileId, token.hash)))
    return null
  return {
    object: "send-fileDownload",
    id: fileId,
    url: `${origin}/api/sends/${id}/${fileId}?t=${encodeURIComponent(token.token)}`,
  }
}

export async function handleBitwarden(
  request: Request,
  env: CloudflareEnv
): Promise<Response> {
  const url = new URL(request.url)
  const origin = env.APP_URL ? new URL(env.APP_URL).origin : url.origin
  const path = url.pathname.toLowerCase()
  const method = request.method.toUpperCase()

  const sendDownload = /^\/api\/sends\/([0-9a-f-]{36})\/([0-9a-f]{64})$/.exec(
    path
  )
  if (sendDownload && method === "GET") {
    const id = sendDownload[1]!
    const fileId = sendDownload[2]!
    const token = url.searchParams.get("t")
    if (!token) return failure("Send file not found", 404)
    const locator = await getSendLocator(env, id)
    if (!locator) return failure("Send file not found", 404)
    if (!(await findVaultUserById(env, locator.userId)))
      return failure("Send file not found", 404)
    const vault = await env.APP_DATABASE.getByName(`vault:${locator.userId}`)
    if (
      !(await vault.validateVaultSendDownload(
        id,
        fileId,
        await tokenHash(token)
      ))
    )
      return failure("Send file not found", 404)
    const object = await env.VAULT_ATTACHMENTS.get(
      `sends/${locator.userId}/${id}/${fileId}`
    )
    if (!object) return failure("Send file not found", 404)
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(object.size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  }

  const fileAccess = /^\/api\/sends\/access\/file\/([0-9a-f]{64})$/.exec(path)
  if (fileAccess && method === "POST") {
    const bearer = /^Bearer ([-_A-Za-z0-9.]+)$/i.exec(
      request.headers.get("Authorization") ?? ""
    )?.[1]
    const id = bearer && sendIdFromAccessId(bearer.split(".")[0]!)
    const link =
      bearer &&
      id &&
      (await publicSendFileLink(env, origin, bearer, id, fileAccess[1]!))
    return link ? json(link) : failure("Send file not found", 404)
  }
  const legacyFileAccess =
    /^\/api\/sends\/([0-9a-f-]{36})\/access\/file\/([0-9a-f]{64})$/.exec(path)
  if (legacyFileAccess && method === "POST") {
    const body = await bodyOf(request)
    const result = await issuePublicSendAccess(
      env,
      request,
      sendAccessId(legacyFileAccess[1]!),
      (body && stringField(body, "password")) || null
    )
    if ("error" in result)
      return failure(
        "Send file not found",
        result.error === "limited" ? 429 : 404
      )
    const link = await publicSendFileLink(
      env,
      origin,
      result.token,
      legacyFileAccess[1]!,
      legacyFileAccess[2]!
    )
    return link ? json(link) : failure("Send file not found", 404)
  }

  if (path === "/api/sends/access" && method === "POST") {
    const bearer = /^Bearer ([-_A-Za-z0-9.]+)$/i.exec(
      request.headers.get("Authorization") ?? ""
    )?.[1]
    const send = bearer && (await readPublicSend(env, bearer))
    return send ? json(send) : failure("Send is unavailable", 404)
  }
  const legacySendAccess = /^\/api\/sends\/access\/([a-z0-9_-]{22})$/i.exec(
    url.pathname
  )
  if (legacySendAccess && method === "POST") {
    const body = await bodyOf(request)
    const password = body && stringField(body, "password")
    const result = await issuePublicSendAccess(
      env,
      request,
      legacySendAccess[1]!,
      password ?? null
    )
    if ("error" in result)
      return failure(
        result.error === "password_required"
          ? "Password required"
          : "Send is unavailable",
        result.error === "password_required"
          ? 401
          : result.error === "limited"
            ? 429
            : 404
      )
    const send = await readPublicSend(env, result.token)
    return send ? json(send) : failure("Send is unavailable", 404)
  }

  const downloadMatch =
    /^\/attachments\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/.exec(path)
  if (downloadMatch && method === "GET") {
    const [scope, token] = (url.searchParams.get("token") ?? "").split(".")
    if (!scope || !token) return failure("Attachment not found", 404)
    const [orgId, scopedUserId] = scope.includes(":")
      ? scope.split(":")
      : [null, scope]
    const userId = scopedUserId
    if (
      !userId ||
      !/^[0-9a-f-]{36}$/.test(userId) ||
      (orgId && !/^[0-9a-f-]{36}$/.test(orgId))
    )
      return failure("Attachment not found", 404)
    if (!(await findVaultUserById(env, userId)))
      return failure("Attachment not found", 404)
    if (orgId) {
      const locator = await getOrgCipherLocator(env, downloadMatch[1]!)
      const member =
        locator?.orgId === orgId &&
        (await getVaultMembership(env, orgId, userId))
      const allowed =
        member &&
        new Set(
          (await listVaultCollections(env, orgId, member)).map((row) => row.id)
        )
      if (
        !locator ||
        !allowed ||
        !locator.collectionIds.some((id) => allowed.has(id))
      )
        return failure("Attachment not found", 404)
    }
    const vault = await env.APP_DATABASE.getByName(
      orgId ? `org:${orgId}` : `vault:${userId}`
    )
    const authorized = await vault.validateVaultAttachmentToken(
      downloadMatch[2]!,
      downloadMatch[1]!,
      token,
      userId
    )
    if (!authorized) return failure("Attachment not found", 404)
    const object = await env.VAULT_ATTACHMENTS.get(
      `${orgId ? `org/${orgId}` : userId}/${downloadMatch[1]}/${downloadMatch[2]}`
    )
    if (!object) return failure("Attachment not found", 404)
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(object.size),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  }

  if (path === "/api/config" && method === "GET") {
    return json({
      version: "2026.2.0",
      server: { name: "Cloudwarden" },
      settings: { disableUserRegistration: !registrationsAllowed(env) },
      environment: {
        vault: origin,
        api: `${origin}/api`,
        identity: `${origin}/identity`,
        notifications: `${origin}/notifications`,
        sso: "",
        cloudRegion: null,
      },
      push: { pushTechnology: 0, vapidPublicKey: null },
      featureStates: {},
      object: "config",
    })
  }

  if (path === "/api/alive" && method === "GET") return json(true)
  if (path === "/api/now" && method === "GET")
    return json(new Date().toISOString())
  if (path === "/api/version" && method === "GET") return json("2026.2.0")

  if (path === "/api/organizations/domain/sso/verified" && method === "POST") {
    const sso = env as CloudflareEnv & {
      SSO_IDENTIFIER?: string
      SSO_CALLBACK_URL?: string
    }
    const identifier = sso.SSO_IDENTIFIER
    return json(
      list(
        identifier && sso.SSO_CALLBACK_URL
          ? [
              {
                organizationIdentifier: identifier,
                organizationName: identifier,
                domainName: new URL(sso.SSO_CALLBACK_URL).hostname,
              },
            ]
          : []
      )
    )
  }

  if (path === "/identity/sso/prevalidate" && method === "GET")
    return prevalidateVaultSso(request, env)
  if (path === "/identity/connect/authorize" && method === "GET") {
    try {
      return await startVaultSso(request, env)
    } catch {
      return failure("SSO provider is unavailable", 503)
    }
  }
  if (path === "/identity/connect/oidc-signin" && method === "GET")
    return finishVaultSsoCallback(request, env)

  if (
    (path === "/identity/accounts/prelogin" ||
      path === "/identity/accounts/prelogin/password" ||
      path === "/api/accounts/prelogin") &&
    method === "POST"
  ) {
    const body = await bodyOf(request)
    const email = body && stringField(body, "email")
    if (!email) return failure("Email is required")
    const user = await findVaultUser(env, email)
    const kdf = user?.kdf ?? 0
    const iterations = user?.kdfIterations ?? 600_000
    const memory = user?.kdfMemory ?? null
    const parallelism = user?.kdfParallelism ?? null
    return json({
      kdf,
      kdfIterations: iterations,
      kdfMemory: memory,
      kdfParallelism: parallelism,
      kdfSettings: { kdfType: kdf, iterations, memory, parallelism },
      salt: null,
    })
  }

  if (
    (path === "/identity/accounts/register/send-verification-email" ||
      path === "/api/accounts/register/send-verification-email") &&
    method === "POST"
  ) {
    if (!registrationsAllowed(env))
      return failure("Registration is disabled", 403)
    const body = await bodyOf(request)
    const email = body && stringField(body, "email")
    const name = body && stringField(body, "name")
    if (
      !email ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      (name && name.length > 50)
    )
      return failure("Invalid registration request")
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown"
    const limiter = await env.APP_DATABASE.getByName(
      "bitwarden-registration-rates"
    )
    const allowed = await limiter.consumeRateLimit(
      `start:${ip}`,
      10,
      60 * 60_000
    )
    if (!allowed.allowed) return failure("Too many registration attempts", 429)
    const destinationAllowed = await limiter.consumeRateLimit(
      `start-email:${normalizeEmail(email)}`,
      5,
      60 * 60_000
    )
    if (!destinationAllowed.allowed)
      return failure("Too many registration attempts", 429)
    if (await findVaultUser(env, email))
      return failure("Registration unavailable", 409)
    const verifyEmail = registrationEmailVerificationRequired(env)
    const token = await issueRegistrationToken(
      env,
      normalizeEmail(email),
      name ?? null,
      verifyEmail
    )
    if (verifyEmail) {
      if (!env.APP_URL || !env.EMAIL_FROM)
        return failure("Registration email is unavailable", 503)
      const params = new URLSearchParams({
        email: normalizeEmail(email),
        token,
      })
      try {
        await createMailer(
          env.EMAIL,
          env.EMAIL_FROM
        )({
          to: normalizeEmail(email),
          subject: "Verify your Cloudwarden email",
          message:
            "Verify your email address to finish creating your Cloudwarden account.",
          url: `${origin}/#/finish-signup/?${params}`,
          label: "Verify email address",
        })
      } catch {
        return failure("Registration email is unavailable", 503)
      }
      return new Response(null, { status: 204 })
    }
    return request.headers.get("Accept")?.includes("application/json")
      ? json(token)
      : new Response(token, {
          headers: {
            "Content-Type": "text/plain",
            "Cache-Control": "no-store",
          },
        })
  }
  if (
    (path === "/identity/accounts/register" ||
      path === "/api/accounts/register" ||
      path === "/identity/accounts/register/finish" ||
      path === "/api/accounts/register/finish") &&
    method === "POST"
  ) {
    const body = await bodyOf(request)
    if (!body) return failure("Invalid registration request")
    const email = stringField(body, "email")
    const inviteToken =
      stringField(body, "orgInviteToken") ?? stringField(body, "token")
    const inviteMemberId = stringField(body, "organizationUserId")
    const invitation =
      email && inviteToken && inviteMemberId
        ? await validOrgInvite(env, inviteToken, {
            email,
            memberId: inviteMemberId,
          })
        : null
    if (!registrationsAllowed(env) && !invitation)
      return failure("Registration is disabled", 403)
    const finishing = path.endsWith("/finish")
    if (!finishing && registrationEmailVerificationRequired(env) && !invitation)
      return failure("Email verification is required", 403)
    const verification =
      finishing && email
        ? await verifyRegistrationToken(
            env,
            stringField(body, "emailVerificationToken") ?? "",
            normalizeEmail(email)
          )
        : null
    if (finishing && !verification && !invitation)
      return failure("Invalid registration token", 403)
    if (
      finishing &&
      registrationEmailVerificationRequired(env) &&
      !verification?.verified &&
      !invitation
    )
      return failure("Email verification is required", 403)
    const authentication = field(body, "masterPasswordAuthentication") as
      | Body
      | undefined
    const unlock = field(body, "masterPasswordUnlock") as Body | undefined
    const kdfSettings = (authentication && field(authentication, "kdf")) as
      | Body
      | undefined
    const legacyHash = stringField(body, "masterPasswordHash")
    const hash =
      (authentication &&
        (stringField(authentication, "masterPasswordAuthenticationHash") ??
          stringField(authentication, "hash"))) ??
      legacyHash
    const key =
      (unlock &&
        (stringField(unlock, "masterKeyWrappedUserKey") ??
          stringField(unlock, "key"))) ??
      stringField(body, "key")
    const kdf =
      (kdfSettings && numberField(kdfSettings, "kdfType")) ??
      numberField(body, "kdf")
    const iterations =
      (kdfSettings && numberField(kdfSettings, "iterations")) ??
      numberField(body, "kdfIterations")
    if (
      !email ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !hash ||
      hash.length > 1024 ||
      !key ||
      key.length > 20_000 ||
      kdf !== 0 ||
      !iterations ||
      iterations < 100_000 ||
      iterations > 2_000_000 ||
      (authentication &&
        normalizeEmail(email) !== stringField(authentication, "salt")) ||
      (unlock && normalizeEmail(email) !== stringField(unlock, "salt"))
    )
      return failure("Invalid registration fields")
    const existing = await findVaultUser(env, email)
    if (
      existing &&
      (!invitation ||
        existing.id !== invitation.userId ||
        existing.passwordHash)
    )
      return failure("Registration unavailable", 409)
    const keys = (field(body, "keys") ?? field(body, "userAsymmetricKeys")) as
      | Body
      | undefined
    try {
      const name =
        verification?.name ??
        stringField(body, "name")?.slice(0, 50) ??
        normalizeEmail(email)
      if (invitation && existing) {
        const privateKey = keys && stringField(keys, "encryptedPrivateKey")
        const publicKey = keys && stringField(keys, "publicKey")
        if (!privateKey || !publicKey)
          return failure("Account keys are required")
        const initialized = await initializeVaultPassword(env, existing.id, {
          masterPasswordHash: hash,
          key,
          privateKey,
          publicKey,
          kdfIterations: iterations,
          name,
          emailVerified: true,
        })
        if (!initialized) return failure("Registration unavailable", 409)
      } else {
        await createVaultUser(env, {
          email,
          name,
          masterPasswordHash: hash,
          key,
          privateKey: keys && stringField(keys, "encryptedPrivateKey"),
          publicKey: keys && stringField(keys, "publicKey"),
          kdf,
          kdfIterations: iterations,
          emailVerified: !!invitation || (verification?.verified ?? false),
        })
      }
    } catch {
      return failure("Registration unavailable", 409)
    }
    return json({ object: "register", captchaBypassToken: "" })
  }

  if (path === "/api/two-factor/send-email-login" && method === "POST") {
    if (!emailTwoFactorAvailable(env))
      return failure("Email two-factor is unavailable", 503)
    const body = await bodyOf(request)
    const email = body && stringField(body, "email")
    const password = body && stringField(body, "masterPasswordHash")
    if (!email || !password) return failure("Credentials are required")
    const limiter = await env.APP_DATABASE.getByName("bitwarden-login-rates")
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown"
    if (
      !(await limiter.consumeRateLimit(`email-login:${ip}`, 10, 60 * 60_000))
        .allowed
    )
      return failure("Too many email code requests", 429)
    const account = await findVaultUser(env, email)
    if (!(await verifyVaultPassword(account, password)) || !account)
      return failure("Username or password is incorrect")
    if (!(await getEmailTwoFactor(env, account.id))?.email)
      return failure("Email two-factor is unavailable", 404)
    try {
      await sendEmailLogin(env, account.id)
    } catch {
      return failure("Email delivery failed", 503)
    }
    return new Response(null, { status: 200 })
  }

  if (path === "/identity/connect/token" && method === "POST") {
    const body = await bodyOf(request)
    if (!body) return failure("Invalid token request")
    const grant = stringField(body, "grant_type")
    if (grant === "refresh_token") {
      const token = stringField(body, "refresh_token")
      const refreshed = token && (await refreshVaultSession(env, token))
      return refreshed
        ? json({
            access_token: refreshed.access,
            refresh_token: refreshed.refresh,
            expires_in: refreshed.expiresIn,
            token_type: "Bearer",
            scope: "api offline_access",
          })
        : json({ error: "invalid_grant" }, 400)
    }
    if (grant === "authorization_code") {
      const code = stringField(body, "code")
      const verifier = stringField(body, "code_verifier")
      const deviceId = stringField(body, "device_identifier")
      const deviceType = stringField(body, "device_type") ?? "unknown"
      const clientId = stringField(body, "client_id") ?? "web"
      if (!code || !verifier || !deviceId || deviceId.length > 200)
        return failure("Invalid SSO token request")
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown"
      const limiter = await env.APP_DATABASE.getByName("bitwarden-login-rates")
      if (!(await limiter.consumeRateLimit(`login:${ip}`, 20, 60_000)).allowed)
        return failure("Too many login attempts", 429)
      let sso: Awaited<ReturnType<typeof redeemVaultSso>>
      try {
        sso = await redeemVaultSso(env, code, verifier)
      } catch {
        return json({ error: "invalid_grant" }, 400)
      }
      const ssoUser = sso.user
      const factors = await enabledTwoFactors(env, ssoUser.id)
      if (factors.totp || factors.email) {
        const factorCode = stringField(body, "two_factor_token")
        const provider = integerField(body, "two_factor_provider") ?? 0
        if (!factorCode) return twoFactorChallenge(factors)
        if (
          !(
            await limiter.consumeRateLimit(`totp:${ssoUser.id}`, 15, 5 * 60_000)
          ).allowed
        )
          return failure("Too many two-factor attempts", 429)
        const valid = await verifySecondFactor(
          env,
          ssoUser.id,
          factors,
          provider,
          factorCode
        )
        if (!valid) return failure("Invalid two-factor code", 400)
      }
      if (!(await consumeVaultSso(env, code, ssoUser.id)))
        return json({ error: "invalid_grant" }, 400)
      return json(
        tokenResponse(
          ssoUser,
          await issueVaultSession(
            env,
            ssoUser,
            deviceId,
            clientId,
            deviceType,
            {
              issuer: (env as CloudflareEnv & { SSO_AUTHORITY: string })
                .SSO_AUTHORITY,
              refreshToken: sso.refreshToken,
            }
          )
        )
      )
    }
    if (grant === "send_access") {
      const accessId = stringField(body, "send_id")
      if (!accessId) return failure("Send ID is required")
      const result = await issuePublicSendAccess(
        env,
        request,
        accessId,
        stringField(body, "password_hash_b64") ?? null
      )
      if ("error" in result) {
        if (result.error === "limited")
          return failure("Too many Send attempts", 429)
        const required = result.error === "password_required"
        return json(
          {
            error: required ? "invalid_request" : "invalid_grant",
            error_description: required
              ? "Password required"
              : "Send is unavailable",
            send_access_error_type: required
              ? "password_hash_b64_required"
              : result.error === "password_invalid"
                ? "password_hash_b64_invalid"
                : "send_id_invalid",
          },
          required ? 400 : 404
        )
      }
      return json({
        access_token: result.token,
        expires_in: 120,
        token_type: "Bearer",
        scope: "api.send.access",
      })
    }
    if (grant !== "password") return failure("Unsupported grant type")
    const username = stringField(body, "username")
    const password = stringField(body, "password")
    const deviceId = stringField(body, "device_identifier")
    const deviceType = stringField(body, "device_type") ?? "unknown"
    const clientId = stringField(body, "client_id") ?? "unknown"
    if (!username || !password || !deviceId || deviceId.length > 200)
      return failure("Missing credentials")
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown"
    const limiter = await env.APP_DATABASE.getByName("bitwarden-login-rates")
    const allowed = await limiter.consumeRateLimit(`login:${ip}`, 20, 60_000)
    if (!allowed.allowed) return failure("Too many login attempts", 429)
    const user = await findVaultUser(env, username)
    if (!(await verifyVaultPassword(user, password)) || !user)
      return failure("Username or password is incorrect", 400)
    const factors = await enabledTwoFactors(env, user.id)
    if (factors.totp || factors.email) {
      const code = stringField(body, "two_factor_token")
      const provider = integerField(body, "two_factor_provider") ?? 0
      if (!code) return twoFactorChallenge(factors)
      const secondFactorAllowed = await limiter.consumeRateLimit(
        `totp:${user.id}`,
        15,
        5 * 60_000
      )
      if (!secondFactorAllowed.allowed)
        return failure("Too many two-factor attempts", 429)
      const valid = await verifySecondFactor(
        env,
        user.id,
        factors,
        provider,
        code
      )
      if (!valid) return failure("Invalid two-factor code", 400)
    }
    return json(
      tokenResponse(
        user,
        await issueVaultSession(env, user, deviceId, clientId, deviceType)
      )
    )
  }

  const user = await authenticatedVaultUser(env, request)
  if (!user) return failure("Unauthorized", 401)
  const vault = await env.APP_DATABASE.getByName(`vault:${user.id}`)

  if (path === "/api/accounts/set-password" && method === "POST") {
    const body = await bodyOf(request)
    const keys = body && (field(body, "keys") as Body | undefined)
    const hash = body && stringField(body, "masterPasswordHash")
    const key = body && stringField(body, "key")
    const privateKey = keys && stringField(keys, "encryptedPrivateKey")
    const publicKey = keys && stringField(keys, "publicKey")
    const kdf =
      body && (integerField(body, "kdf") ?? integerField(body, "kdfType"))
    const iterations =
      body &&
      (integerField(body, "kdfIterations") ?? integerField(body, "iterations"))
    if (
      !hash ||
      hash.length > 1024 ||
      !key ||
      key.length > 20_000 ||
      !privateKey ||
      privateKey.length > 20_000 ||
      !publicKey ||
      publicKey.length > 20_000 ||
      kdf !== 0 ||
      !iterations ||
      iterations < 100_000 ||
      iterations > 2_000_000
    )
      return failure("Invalid password setup")
    const initialized = await initializeVaultPassword(env, user.id, {
      masterPasswordHash: hash,
      key,
      privateKey,
      publicKey,
      kdfIterations: iterations,
    })
    return initialized
      ? json({ object: "set-password", captchaBypassToken: "" })
      : failure("Account is already initialized", 409)
  }

  if (
    (path === "/api/accounts/delete" && method === "POST") ||
    (path === "/api/accounts" && method === "DELETE")
  ) {
    const body = await bodyOf(request)
    const password = body && stringField(body, "masterPasswordHash")
    if (!password || !(await verifyVaultPassword(user, password)))
      return failure("Invalid password", 403)
    if (await isLastVaultOwner(env, user.id))
      return failure("Transfer or delete owned organizations first", 409)
    if (!(await beginVaultDeletion(env, user.id, user.passwordHash)))
      return failure("Account deletion already started", 409)
    try {
      const complete = await cleanupVaultDeletion(env, user.id)
      return new Response(null, { status: complete ? 200 : 202 })
    } catch {
      return new Response(null, { status: 202 })
    }
  }

  if (
    (path === "/api/accounts/password" || path === "/api/accounts/kdf") &&
    method === "POST"
  ) {
    const body = await bodyOf(request)
    const oldPassword = body && stringField(body, "masterPasswordHash")
    if (!oldPassword || !(await verifyVaultPassword(user, oldPassword)))
      return failure("Invalid password", 403)
    const authentication = body && field(body, "authenticationData")
    const unlock = body && field(body, "unlockData")
    let nextPassword: string | undefined
    let nextKey: string | undefined
    let kdf: { type: number; iterations: number } | null = null
    if (
      authentication &&
      typeof authentication === "object" &&
      !Array.isArray(authentication) &&
      unlock &&
      typeof unlock === "object" &&
      !Array.isArray(unlock)
    ) {
      const auth = authentication as Body
      const wrap = unlock as Body
      const authKdf = field(auth, "kdf") as Body | undefined
      const wrapKdf = field(wrap, "kdf") as Body | undefined
      const authType =
        authKdf &&
        (numberField(authKdf, "kdfType") ?? numberField(authKdf, "kdf"))
      const wrapType =
        wrapKdf &&
        (numberField(wrapKdf, "kdfType") ?? numberField(wrapKdf, "kdf"))
      const authIterations =
        authKdf &&
        (numberField(authKdf, "iterations") ??
          numberField(authKdf, "kdfIterations"))
      const wrapIterations =
        wrapKdf &&
        (numberField(wrapKdf, "iterations") ??
          numberField(wrapKdf, "kdfIterations"))
      if (
        stringField(auth, "salt") !== user.email ||
        stringField(wrap, "salt") !== user.email ||
        authType !== wrapType ||
        authIterations !== wrapIterations ||
        authType !== 0 ||
        !authIterations ||
        authIterations < 100_000 ||
        authIterations > 2_000_000
      )
        return failure("Invalid KDF settings")
      nextPassword = stringField(auth, "masterPasswordAuthenticationHash")
      nextKey = stringField(wrap, "masterKeyWrappedUserKey")
      kdf = { type: authType, iterations: authIterations }
    } else if (path === "/api/accounts/password") {
      nextPassword = body && stringField(body, "newMasterPasswordHash")
      nextKey = body && stringField(body, "key")
    }
    if (
      !nextPassword ||
      nextPassword.length > 1024 ||
      !nextKey ||
      nextKey.length > 20_000
    )
      return failure("Invalid password change fields")
    const updated = await updateVaultPassword(
      env,
      user,
      request,
      nextPassword,
      nextKey,
      kdf
    )
    return updated
      ? new Response(null, { status: 200 })
      : failure("Account changed", 409)
  }

  if (path === "/api/two-factor" && method === "GET") {
    const factors = await enabledTwoFactors(env, user.id)
    return json({
      data: [
        ...(factors.totp
          ? [{ enabled: true, type: 0, object: "twoFactorProvider" }]
          : []),
        ...(factors.email
          ? [{ enabled: true, type: 1, object: "twoFactorProvider" }]
          : []),
      ],
      object: "list",
      continuationToken: null,
    })
  }
  if (path === "/api/two-factor/get-email" && method === "POST") {
    const body = await bodyOf(request)
    const password = body && stringField(body, "masterPasswordHash")
    if (!password || !(await verifyVaultPassword(user, password)))
      return failure("Invalid password", 403)
    const factor = await getEmailTwoFactor(env, user.id)
    return json({
      email: factor?.email ?? null,
      enabled: !!factor?.email,
      object: "twoFactorEmail",
    })
  }
  if (path === "/api/two-factor/send-email" && method === "POST") {
    const body = await bodyOf(request)
    const password = body && stringField(body, "masterPasswordHash")
    const email = body && stringField(body, "email")
    if (!password || !(await verifyVaultPassword(user, password)))
      return failure("Invalid password", 403)
    if (!email) return failure("Email is required")
    const limiter = await env.APP_DATABASE.getByName("bitwarden-login-rates")
    if (
      !(
        await limiter.consumeRateLimit(
          `email-enroll:${user.id}`,
          5,
          60 * 60_000
        )
      ).allowed
    )
      return failure("Too many email code requests", 429)
    try {
      return (await sendEmailEnrollment(env, user.id, email))
        ? new Response(null, { status: 200 })
        : failure("Email two-factor is unavailable")
    } catch {
      return failure("Email delivery failed", 503)
    }
  }
  if (
    path === "/api/two-factor/email" &&
    (method === "PUT" || method === "POST")
  ) {
    const body = await bodyOf(request)
    const password = body && stringField(body, "masterPasswordHash")
    const email = body && stringField(body, "email")
    const code = body && stringField(body, "token")
    if (!password || !(await verifyVaultPassword(user, password)))
      return failure("Invalid password", 403)
    if (!email || !code) return failure("Invalid email factor")
    const limiter = await env.APP_DATABASE.getByName("bitwarden-login-rates")
    if (
      !(
        await limiter.consumeRateLimit(
          `email-confirm:${user.id}`,
          10,
          10 * 60_000
        )
      ).allowed
    )
      return failure("Too many email code attempts", 429)
    if (!(await confirmEmailEnrollment(env, user.id, email, code, request)))
      return failure("Invalid email code")
    return json({ email, enabled: true, object: "twoFactorEmail" })
  }
  if (path === "/api/two-factor/get-authenticator" && method === "POST") {
    const body = await bodyOf(request)
    const password = body && stringField(body, "masterPasswordHash")
    if (!password || !(await verifyVaultPassword(user, password)))
      return failure("Invalid password", 403)
    const factor = await getTotp(env, user.id)
    return json({
      enabled: !!factor,
      key: factor?.secret ?? newTotpSecret(),
      object: "twoFactorAuthenticator",
    })
  }
  if (
    path === "/api/two-factor/authenticator" &&
    (method === "POST" || method === "PUT")
  ) {
    const body = await bodyOf(request)
    const password = body && stringField(body, "masterPasswordHash")
    const key = body && stringField(body, "key")
    const code = body && String(field(body, "token") ?? "")
    if (!password || !(await verifyVaultPassword(user, password)))
      return failure("Invalid password", 403)
    if (!key || !code) return failure("Invalid authenticator fields")
    const step = await matchingTotpStep(key.toUpperCase(), code, 0)
    if (step === null) return failure("Invalid authenticator code")
    if (!(await enableTotp(env, user.id, key.toUpperCase(), step, request)))
      return failure("Invalid authenticator key")
    return json({
      enabled: true,
      key: key.toUpperCase(),
      object: "twoFactorAuthenticator",
    })
  }
  if (path === "/api/two-factor/get-recover" && method === "POST") {
    const body = await bodyOf(request)
    const password = body && stringField(body, "masterPasswordHash")
    if (!password || !(await verifyVaultPassword(user, password)))
      return failure("Invalid password", 403)
    const factors = await enabledTwoFactors(env, user.id)
    const recovery = factors.email?.recoveryCode ?? factors.totp?.recoveryCode
    return recovery
      ? json({ code: recovery, object: "twoFactorRecover" })
      : failure("Two-factor authentication is disabled", 404)
  }
  if (
    (path === "/api/two-factor/disable" ||
      path === "/api/two-factor/authenticator" ||
      path === "/api/two-factor/email") &&
    (method === "POST" || method === "PUT" || method === "DELETE")
  ) {
    const body = await bodyOf(request)
    const password = body && stringField(body, "masterPasswordHash")
    if (!password || !(await verifyVaultPassword(user, password)))
      return failure("Invalid password", 403)
    const type = body && integerField(body, "type")
    if (type !== 0 && type !== 1) return failure("Invalid two-factor provider")
    if (type === 1) {
      if (!(await getEmailTwoFactor(env, user.id))?.email)
        return failure("Two-factor authentication is disabled", 404)
      await disableEmailTwoFactor(env, user.id, request)
      return json({ enabled: false, type: 1, object: "twoFactorProvider" })
    }
    const factor = await getTotp(env, user.id)
    if (!factor) return failure("Two-factor authentication is disabled", 404)
    const key = body && stringField(body, "key")
    if (path === "/api/two-factor/authenticator" && key !== factor.secret)
      return failure("Invalid authenticator key", 403)
    await disableTotp(env, user.id, request)
    return json({ enabled: false, type: 0, object: "twoFactorProvider" })
  }

  const profileOrganizations = async () =>
    (await listVaultOrganizations(env, user.id)).map(
      ({ organization, membership }) =>
        profileOrganizationResponse(organization, membership)
    )
  if (path === "/api/accounts/profile" && method === "GET")
    return json(
      profile(
        user,
        !!(await getTotp(env, user.id)) ||
          !!(await getEmailTwoFactor(env, user.id))?.email,
        await profileOrganizations()
      )
    )
  if (
    path === "/api/accounts/profile" &&
    (method === "POST" || method === "PUT")
  ) {
    const body = await bodyOf(request)
    const name = body && stringField(body, "name")
    if (!name || name.length > 50) return failure("Invalid profile name")
    const updated = await updateVaultProfile(env, user.id, name)
    return json(
      profile(
        updated,
        !!(await getTotp(env, user.id)) ||
          !!(await getEmailTwoFactor(env, user.id))?.email,
        await profileOrganizations()
      )
    )
  }
  if (path === "/api/accounts/keys" && method === "POST") {
    const body = await bodyOf(request)
    const privateKey = body && stringField(body, "encryptedPrivateKey")
    const publicKey = body && stringField(body, "publicKey")
    if (
      !privateKey ||
      privateKey.length > 20_000 ||
      !publicKey ||
      publicKey.length > 20_000
    )
      return failure("Invalid account keys")
    await updateVaultKeys(env, user.id, privateKey, publicKey)
    return json({ privateKey, publicKey, object: "keys" })
  }
  if (path === "/api/accounts/revision-date" && method === "GET") {
    const organizations = await listVaultOrganizations(env, user.id)
    const sharedRevisions = await Promise.all(
      organizations.map(async ({ organization, membership }) => {
        const orgVault = await env.APP_DATABASE.getByName(
          `org:${organization.id}`
        )
        return Math.max(
          organization.updatedAt.getTime(),
          membership.createdAt.getTime(),
          await orgVault.vaultRevision()
        )
      })
    )
    return json(
      new Date(
        Math.max(
          user.updatedAt.getTime(),
          await vault.vaultRevision(),
          ...sharedRevisions
        )
      ).toISOString()
    )
  }
  if (path === "/api/settings/domains" && method === "GET")
    return json({
      equivalentDomains: [],
      globalEquivalentDomains: [],
      object: "domains",
    })
  if (path === "/api/collections" && method === "GET") {
    const organizations = await listVaultOrganizations(env, user.id)
    const collections = (
      await Promise.all(
        organizations.map(async ({ organization, membership }) =>
          (await listVaultCollections(env, organization.id, membership)).map(
            (collection) => collectionResponse(collection, membership)
          )
        )
      )
    ).flat()
    return json(list(collections))
  }
  if (path === "/api/organizations" && method === "POST") {
    const allowed = (env as CloudflareEnv & { ORG_CREATION_USERS?: string })
      .ORG_CREATION_USERS
    if (
      allowed &&
      !allowed.split(",").some((email) => normalizeEmail(email) === user.email)
    )
      return failure("Organization creation is disabled for this account", 403)
    const body = await bodyOf(request)
    const name = body && stringField(body, "name")
    const collectionName = body && stringField(body, "collectionName")
    const key = body && stringField(body, "key")
    const billingEmail = body && stringField(body, "billingEmail")
    const keys = body && field(body, "keys")
    const keyBody =
      keys && typeof keys === "object" && !Array.isArray(keys)
        ? (keys as Body)
        : null
    const privateKey = keyBody && stringField(keyBody, "encryptedPrivateKey")
    const publicKey = keyBody && stringField(keyBody, "publicKey")
    if (
      !name ||
      name.length > 100 ||
      !collectionName ||
      collectionName.length > 100 ||
      !key ||
      key.length > 20_000 ||
      (billingEmail && billingEmail.length > 254) ||
      !!privateKey !== !!publicKey
    )
      return failure("Invalid organization")
    const created = await createVaultOrganization(env, user.id, {
      name,
      collectionName,
      key,
      billingEmail: billingEmail || user.email,
      privateKey: privateKey ?? null,
      publicKey: publicKey ?? null,
    })
    return json(organizationResponse(created.org))
  }
  const orgExportMatch = /^\/api\/organizations\/([0-9a-f-]{36})\/export$/.exec(
    path
  )
  if (orgExportMatch && method === "GET") {
    const orgId = orgExportMatch[1]!
    const membership = await getVaultMembership(env, orgId, user.id)
    if (!membership) return failure("Organization not found", 404)
    if (membership.role > 1 || !membership.accessAll)
      return failure("Organization export is forbidden", 403)
    const collections = await listVaultCollections(env, orgId, membership)
    const locators = await listOrgCipherLocators(env, orgId)
    const orgVault = await env.APP_DATABASE.getByName(`org:${orgId}`)
    const ciphers = await Promise.all(
      locators.map(async (locator) => {
        if (!locator) return null
        const row = await orgVault.getVaultCipher(locator.id)
        return row
          ? cipherResponse(row, orgVault, user.id, origin, {
              id: orgId,
              collectionIds: locator.collectionIds,
            })
          : null
      })
    )
    return json({
      collections: collections.map((collection) =>
        collectionResponse(collection, membership)
      ),
      ciphers: ciphers.filter((cipher) => cipher !== null),
    })
  }
  const orgDeleteMatch =
    /^\/api\/organizations\/([0-9a-f-]{36})(?:\/delete)?$/.exec(path)
  if (
    orgDeleteMatch &&
    (method === "DELETE" || (method === "POST" && path.endsWith("/delete")))
  ) {
    const orgId = orgDeleteMatch[1]!
    const membership = await getVaultMembership(env, orgId, user.id)
    if (!membership) return failure("Organization not found", 404)
    if (membership.role !== 0)
      return failure("Only owners can delete organizations", 403)
    const body = await bodyOf(request)
    const password = body && stringField(body, "masterPasswordHash")
    if (!password || !(await verifyVaultPassword(user, password)))
      return failure("Invalid password", 403)
    if (!(await beginOrgDeletion(env, orgId, user.id)))
      return failure("Organization deletion already started", 409)
    try {
      const complete = await cleanupOrgDeletion(env, orgId)
      return new Response(null, { status: complete ? 200 : 202 })
    } catch {
      return new Response(null, { status: 202 })
    }
  }
  const publicKeyMatch = /^\/api\/users\/([0-9a-f-]{36})\/public-key$/.exec(
    path
  )
  if (publicKeyMatch && method === "GET") {
    const target = await findVaultUserById(env, publicKeyMatch[1]!)
    return target?.publicKey
      ? json({
          userId: target.id,
          publicKey: target.publicKey,
          object: "userKey",
        })
      : failure("Public key not found", 404)
  }
  const orgKeyMatch =
    /^\/api\/organizations\/([0-9a-f-]{36})\/(public-key|keys)$/.exec(path)
  if (orgKeyMatch && method === "GET") {
    const orgId = orgKeyMatch[1]!
    if (!(await getVaultMembership(env, orgId, user.id)))
      return failure("Organization not found", 404)
    const org = await getVaultOrganization(env, orgId)
    return org
      ? json({ object: "organizationPublicKey", publicKey: org.publicKey })
      : failure("Organization not found", 404)
  }
  const memberMatch =
    /^\/api\/organizations\/([0-9a-f-]{36})\/users(?:\/(invite|[0-9a-f-]{36})(?:\/(confirm|delete|accept|reinvite))?)?$/.exec(
      path
    )
  if (memberMatch) {
    const orgId = memberMatch[1]!
    const memberId = memberMatch[2]
    if (memberId && memberMatch[3] === "accept" && method === "POST") {
      const body = await bodyOf(request)
      const token = body && stringField(body, "token")
      const invitation =
        token &&
        (await validOrgInvite(env, token, {
          email: user.email,
          orgId,
          memberId,
        }))
      if (!invitation || invitation.userId !== user.id)
        return failure("Invalid invitation", 403)
      return (await acceptOrgMember(env, orgId, memberId, user.id))
        ? new Response(null, { status: 200 })
        : failure("Invitation is unavailable", 409)
    }
    const membership = await getVaultMembership(env, orgId, user.id)
    if (!membership) return failure("Organization not found", 404)
    if (membership.role !== 0 && membership.role !== 1)
      return failure("Organization management is forbidden", 403)
    if (!memberMatch[2] && method === "GET") {
      const members = await listOrgMembers(env, orgId)
      return json(
        list(
          await Promise.all(
            members.map(async ({ membership: member, user: account }) => ({
              id: member.id,
              userId: account.id,
              email: account.email,
              name: account.name,
              type: member.role,
              status: member.status,
              accessAll: member.accessAll,
              collections: await orgMemberCollections(env, member.id),
              object: "organizationUserUserDetails",
            }))
          )
        )
      )
    }
    if (memberMatch[2] === "invite" && method === "POST") {
      const body = await bodyOf(request)
      const emails = body && field(body, "emails")
      const role = body && integerField(body, "type")
      const accessAll = !!body && field(body, "accessAll") === true
      const collectionData = body && field(body, "collections")
      const collectionIds = Array.isArray(collectionData)
        ? collectionData.map((item) =>
            item && typeof item === "object"
              ? stringField(item as Body, "id")
              : undefined
          )
        : []
      if (
        !Array.isArray(emails) ||
        emails.length === 0 ||
        emails.length > 20 ||
        !emails.every((email) => typeof email === "string") ||
        role !== 2 ||
        collectionIds.some((id) => !id)
      )
        return failure("Invalid invitation")
      const ids = collectionIds as string[]
      if (
        !accessAll &&
        ids.length > 0 &&
        !(await validOrgCollections(env, orgId, membership, ids))
      )
        return failure("Invalid invitation collections")
      const sending = invitationMailEnabled(env)
      if (sending) {
        try {
          invitationOrigin(env)
        } catch {
          return failure("Invitation mail is not configured", 503)
        }
      }
      const org = await getVaultOrganization(env, orgId)
      if (!org) return failure("Organization not found", 404)
      const members = await listOrgMembers(env, orgId)
      const targets: { email: string; user: VaultUser | null }[] = []
      for (const email of emails as string[]) {
        const normalized = normalizeEmail(email)
        if (
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ||
          normalized.length > 254
        )
          return failure("Invalid invitation email")
        const target = await findVaultUser(env, email)
        if (!sending && !target?.publicKey)
          return failure(
            "Invited account must exist and have a public key",
            400
          )
        if (
          (target &&
            members.some(({ user: account }) => account.id === target.id)) ||
          targets.some((entry) => entry.email === normalized)
        )
          return failure("Account is already a member", 409)
        targets.push({ email: normalized, user: target })
      }
      for (const target of targets) {
        const account =
          target.user ??
          (await createVaultStubUser(env, target.email, target.email))
        const invited = await inviteOrgMember(
          env,
          orgId,
          account.id,
          role,
          accessAll,
          accessAll ? [] : ids,
          sending ? 0 : 1
        )
        if (sending) {
          try {
            await sendOrgInvite(env, {
              email: account.email,
              orgId,
              orgName: org.name,
              memberId: invited.id,
              userId: account.id,
              existingUser: !!account.privateKey,
            })
          } catch {
            return failure(
              "Invitation delivery failed; retry the invitation",
              503
            )
          }
        }
      }
      return new Response(null, { status: 200 })
    }
    if (memberId && memberMatch[3] === "reinvite" && method === "POST") {
      if (!invitationMailEnabled(env))
        return failure("Invitation mail is disabled", 403)
      const org = await getVaultOrganization(env, orgId)
      const row = (await listOrgMembers(env, orgId)).find(
        ({ membership: member }) => member.id === memberId
      )
      if (!org || !row || row.membership.status !== 0)
        return failure("Pending invitation not found", 404)
      try {
        await sendOrgInvite(env, {
          email: row.user.email,
          orgId,
          orgName: org.name,
          memberId,
          userId: row.user.id,
          existingUser: !!row.user.privateKey,
        })
      } catch {
        return failure("Invitation delivery failed", 503)
      }
      return new Response(null, { status: 200 })
    }
    if (memberId && !memberMatch[3] && method === "GET") {
      const member = (await listOrgMembers(env, orgId)).find(
        ({ membership: row }) => row.id === memberId
      )
      if (!member) return failure("Member not found", 404)
      return json({
        id: member.membership.id,
        userId: member.user.id,
        email: member.user.email,
        name: member.user.name,
        type: member.membership.role,
        status: member.membership.status,
        accessAll: member.membership.accessAll,
        collections: await orgMemberCollections(env, memberId),
        object: "organizationUserUserDetails",
      })
    }
    if (
      memberId &&
      !memberMatch[3] &&
      (method === "PUT" || method === "POST")
    ) {
      const body = await bodyOf(request)
      const rawCollections = body && field(body, "collections")
      const groups = body && field(body, "groups")
      if (
        (body && integerField(body, "type") !== 2) ||
        !Array.isArray(rawCollections) ||
        (groups !== undefined && (!Array.isArray(groups) || groups.length > 0))
      )
        return failure("Invalid member settings")
      const collections = rawCollections.map((item) => {
        if (!item || typeof item !== "object") return null
        const entry = item as Body
        const id = stringField(entry, "id")
        return id && /^[0-9a-f-]{36}$/.test(id)
          ? {
              id,
              readOnly: field(entry, "readOnly") === true,
              hidePasswords: field(entry, "hidePasswords") === true,
            }
          : null
      })
      if (collections.some((entry) => !entry))
        return failure("Invalid member collections")
      return (await setOrgMemberCollections(
        env,
        orgId,
        memberId,
        collections as {
          id: string
          readOnly: boolean
          hidePasswords: boolean
        }[]
      ))
        ? new Response(null, { status: 200 })
        : failure("Member or collection not found", 404)
    }
    if (memberId && memberMatch[3] === "confirm" && method === "POST") {
      const body = await bodyOf(request)
      const key = body && stringField(body, "key")
      if (!key || key.length > 20_000)
        return failure("Invalid organization key")
      return (await confirmOrgMember(env, orgId, memberId, key))
        ? new Response(null, { status: 200 })
        : failure("Pending member not found", 404)
    }
    if (memberId && !memberMatch[3] && method === "DELETE") {
      return (await removeOrgMember(env, orgId, memberId))
        ? new Response(null, { status: 200 })
        : failure("Member not found", 404)
    }
  }
  const organizationMatch =
    /^\/api\/organizations\/([0-9a-f-]{36})(?:\/collections(?:\/([0-9a-f-]{36}))?)?$/.exec(
      path
    )
  if (organizationMatch) {
    const orgId = organizationMatch[1]!
    const membership = await getVaultMembership(env, orgId, user.id)
    if (!membership) return failure("Organization not found", 404)
    const org = await getVaultOrganization(env, orgId)
    if (!org) return failure("Organization not found", 404)
    if (!path.includes("/collections") && method === "GET")
      return json(organizationResponse(org))
    if (
      !path.includes("/collections") &&
      (method === "PUT" || method === "POST")
    ) {
      if (membership.role !== 0)
        return failure("Only owners can update organizations", 403)
      const body = await bodyOf(request)
      const name = body && stringField(body, "name")
      const billingEmail = body && stringField(body, "billingEmail")
      if (
        !name ||
        name.length > 100 ||
        !billingEmail ||
        billingEmail.length > 254
      )
        return failure("Invalid organization")
      const updated = await updateVaultOrganization(
        env,
        orgId,
        name,
        normalizeEmail(billingEmail)
      )
      return updated
        ? json(organizationResponse(updated))
        : failure("Organization not found", 404)
    }
    if (path.endsWith("/collections") && method === "GET")
      return json(
        list(
          (await listVaultCollections(env, orgId, membership)).map(
            (collection) => collectionResponse(collection, membership)
          )
        )
      )
    if (path.endsWith("/collections") && method === "POST") {
      if (membership.role !== 0 && membership.role !== 1)
        return failure("Collection management is forbidden", 403)
      const body = await bodyOf(request)
      const name = body && stringField(body, "name")
      const externalId = body && stringField(body, "externalId")
      if (!name || name.length > 100 || (externalId && externalId.length > 255))
        return failure("Invalid collection")
      const collection = await createVaultCollection(
        env,
        orgId,
        name,
        externalId ?? null
      )
      return json(collectionResponse(collection, membership))
    }
    const collectionId = organizationMatch[2]
    if (collectionId) {
      const collection = await getVaultCollection(env, orgId, collectionId)
      if (!collection) return failure("Collection not found", 404)
      const visible = (await listVaultCollections(env, orgId, membership)).some(
        (row) => row.id === collectionId
      )
      if (!visible) return failure("Collection not found", 404)
      if (method === "GET")
        return json(collectionResponse(collection, membership))
      if (membership.role !== 0 && membership.role !== 1)
        return failure("Collection management is forbidden", 403)
      if (method === "PUT" || method === "POST") {
        const body = await bodyOf(request)
        const name = body && stringField(body, "name")
        const externalId = body && stringField(body, "externalId")
        if (
          !name ||
          name.length > 100 ||
          (externalId && externalId.length > 255)
        )
          return failure("Invalid collection")
        const updated = await updateVaultCollection(
          env,
          orgId,
          collectionId,
          name,
          externalId ?? null
        )
        return updated
          ? json(collectionResponse(updated, membership))
          : failure("Collection not found", 404)
      }
      if (method === "DELETE") {
        const result = await deleteEmptyVaultCollection(
          env,
          orgId,
          collectionId
        )
        return result === "deleted"
          ? new Response(null, { status: 204 })
          : failure(
              result === "used"
                ? "Collection contains shared ciphers"
                : "Collection not found",
              result === "used" ? 409 : 404
            )
      }
    }
  }
  if (path === "/api/sends" && method === "GET")
    return json(list((await vault.listVaultSends()).map(sendResponse)))
  if (
    (path === "/api/sends" || path === "/api/sends/file/v2") &&
    method === "POST"
  ) {
    const body = await bodyOf(request)
    const input = body && parseSend(body)
    const fileSend = path === "/api/sends/file/v2"
    if (
      !input ||
      (JSON.parse(input.payload) as Body).type !== (fileSend ? 1 : 0)
    )
      return failure("Invalid Send")
    const id = crypto.randomUUID()
    const password = input.password
      ? await (async () => {
          const salt = newSendPasswordSalt()
          return { salt, hash: await hashSendPassword(input.password!, salt) }
        })()
      : null
    const send = await vault.putVaultSend(id, {
      ...input,
      password,
      uploaded: !fileSend,
    })
    try {
      await createSendLocator(env, id, user.id)
    } catch {
      await vault.deleteVaultSend(id)
      return failure("Could not create Send", 503)
    }
    if (!fileSend) return json(sendResponse(send))
    const file = (JSON.parse(send.payload) as { file: { id: string } }).file
    return json({
      fileUploadType: 0,
      object: "send-fileUpload",
      url: `/sends/${id}/file/${file.id}`,
      sendResponse: sendResponse(send),
    })
  }
  const sendUpload =
    /^\/api\/sends\/([0-9a-f-]{36})\/file\/([0-9a-f]{64})$/.exec(path)
  if (sendUpload && method === "POST") {
    const id = sendUpload[1]!
    const fileId = sendUpload[2]!
    const send = await vault.getVaultSend(id)
    if (!send || send.uploaded) return failure("Send file not found", 404)
    const file = (
      JSON.parse(send.payload) as {
        file?: { id?: string; size?: number; fileName?: string }
      }
    ).file
    if (!file || file.id !== fileId || !file.fileName)
      return failure("Send file not found", 404)
    const fileName = file.fileName
    const form = await request.formData()
    const data = form.get("data")
    if (
      !(data instanceof File) ||
      data.size !== file.size ||
      (data.name !== fileName && !fileName.endsWith(data.name))
    )
      return failure("Send file does not match")
    const objectKey = `sends/${user.id}/${id}/${fileId}`
    await env.VAULT_ATTACHMENTS.put(objectKey, data.stream())
    if (
      !(await keepCompletedUpload(env, objectKey, () =>
        vault.completeVaultSendFile(id, fileId, data.size, fileName)
      ))
    )
      return failure("Send upload failed", 503)
    return new Response(null, { status: 204 })
  }
  const sendMatch =
    /^\/api\/sends\/([0-9a-f-]{36})(?:\/(remove-password))?$/.exec(path)
  if (sendMatch) {
    const id = sendMatch[1]!
    const existing = await vault.getVaultSend(id)
    if (!existing) return failure("Send not found", 404)
    if (sendMatch[2] === "remove-password" && method === "PUT") {
      const send = await vault.removeVaultSendPassword(id)
      return json(sendResponse(send!))
    }
    if (!sendMatch[2] && method === "GET") return json(sendResponse(existing))
    if (!sendMatch[2] && method === "DELETE") {
      await vault.deleteVaultSend(id)
      await deleteSendLocator(env, id)
      const data = JSON.parse(existing.payload) as { file?: { id?: string } }
      if (data.file?.id)
        await env.VAULT_ATTACHMENTS.delete(
          `sends/${user.id}/${id}/${data.file.id}`
        )
      return new Response(null, { status: 200 })
    }
    if (!sendMatch[2] && method === "PUT") {
      const body = await bodyOf(request)
      const input = body && parseSend(body, existing)
      if (!input) return failure("Invalid Send")
      const password = input.password
        ? await (async () => {
            const salt = newSendPasswordSalt()
            return { salt, hash: await hashSendPassword(input.password!, salt) }
          })()
        : undefined
      const send = await vault.putVaultSend(id, { ...input, password })
      return json(sendResponse(send))
    }
  }
  if (path === "/api/sync" && method === "GET") {
    const data = await vault.listVault()
    const organizations = await listVaultOrganizations(env, user.id)
    const collections = (
      await Promise.all(
        organizations.map(async ({ organization, membership }) =>
          (await listVaultCollections(env, organization.id, membership)).map(
            (collection) => collectionResponse(collection, membership)
          )
        )
      )
    ).flat()
    return json({
      profile: profile(
        user,
        !!(await getTotp(env, user.id)) ||
          !!(await getEmailTwoFactor(env, user.id))?.email,
        organizations.map(({ organization, membership }) =>
          profileOrganizationResponse(organization, membership)
        )
      ),
      folders: data.folders.map(folderResponse),
      collections,
      policies: [],
      ciphers: [
        ...(await Promise.all(
          data.ciphers.map((cipher) =>
            cipherResponse(cipher, vault, user.id, origin)
          )
        )),
        ...(await sharedCipherResponses(env, user.id, origin)),
      ],
      domains: {
        equivalentDomains: [],
        globalEquivalentDomains: [],
        object: "domains",
      },
      sends: (await vault.listVaultSends()).map(sendResponse),
      userDecryption: {
        masterPasswordUnlock: {
          kdf: {
            kdfType: user.kdf,
            iterations: user.kdfIterations,
            memory: user.kdfMemory,
            parallelism: user.kdfParallelism,
          },
          masterKeyEncryptedUserKey: user.key,
          masterKeyWrappedUserKey: user.key,
          salt: user.email,
        },
      },
      object: "sync",
    })
  }

  if (path === "/api/ciphers" && method === "GET") {
    const data = await vault.listVault()
    return json(
      list([
        ...(await Promise.all(
          data.ciphers.map((cipher) =>
            cipherResponse(cipher, vault, user.id, origin)
          )
        )),
        ...(await sharedCipherResponses(env, user.id, origin)),
      ])
    )
  }
  if (path === "/api/ciphers/import-organization" && method === "POST") {
    const orgId = url.searchParams.get("organizationId")
    if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId))
      return failure("Invalid organization")
    const member = await getVaultMembership(env, orgId, user.id)
    if (!member) return failure("Organization not found", 404)
    if (member.role > 1 || !member.accessAll)
      return failure("Organization import is forbidden", 403)
    const body = await bodyOf(request)
    const rawCollections = body && field(body, "collections")
    const rawCiphers = body && field(body, "ciphers")
    const rawRelations = body && field(body, "collectionRelationships")
    if (
      !Array.isArray(rawCollections) ||
      !Array.isArray(rawCiphers) ||
      !Array.isArray(rawRelations) ||
      rawCollections.length + rawCiphers.length === 0 ||
      rawCollections.length > 100 ||
      rawCiphers.length > 100 ||
      rawRelations.length > 100
    )
      return failure("Invalid organization import")
    const existing = new Set(
      (await listVaultCollections(env, orgId, member)).map((row) => row.id)
    )
    const collections: OrgImportPlan["collections"] = []
    for (const raw of rawCollections) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return failure("Invalid organization import")
      const item = raw as Body
      const name = stringField(item, "name")
      const suppliedId = field(item, "id")
      const externalId = field(item, "externalId")
      if (
        !name ||
        name.length > 100 ||
        (suppliedId != null &&
          (typeof suppliedId !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(suppliedId))) ||
        (externalId != null &&
          (typeof externalId !== "string" || externalId.length > 100))
      )
        return failure("Invalid organization import")
      const reuse = typeof suppliedId === "string" && existing.has(suppliedId)
      collections.push({
        id: reuse ? suppliedId : crypto.randomUUID(),
        name,
        externalId: (externalId as string | null) ?? null,
        existing: reuse,
      })
    }
    if (new Set(collections.map((row) => row.id)).size !== collections.length)
      return failure("Invalid organization import")
    const assigned = rawCiphers.map(() => new Set<string>())
    for (const raw of rawRelations) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return failure("Invalid organization import")
      const key = numberField(raw as Body, "key")
      const value = numberField(raw as Body, "value")
      if (
        key === undefined ||
        value === undefined ||
        key < 0 ||
        key >= rawCiphers.length ||
        value < 0 ||
        value >= collections.length
      )
        return failure("Invalid organization import")
      assigned[key]!.add(collections[value]!.id)
    }
    const ciphers: OrgImportPlan["ciphers"] = []
    for (const [index, raw] of rawCiphers.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return failure("Invalid organization import")
      const cipher = raw as Body
      const name = stringField(cipher, "name")
      const type = numberField(cipher, "type")
      if (!name || name.length > 10_000 || !type || type < 1 || type > 5)
        return failure("Invalid organization import")
      const collectionIds = [...assigned[index]!]
      if (!collectionIds.length)
        collectionIds.push(...collections.map((row) => row.id))
      if (!collectionIds.length) return failure("Invalid organization import")
      const payload = JSON.stringify({
        ...cipher,
        organizationId: orgId,
        folderId: null,
      })
      if (payload.length > 1_000_000)
        return failure("Invalid organization import")
      ciphers.push({ id: crypto.randomUUID(), payload, collectionIds })
    }
    if (
      collections.filter((row) => !row.existing).length +
        ciphers.length +
        ciphers.reduce((sum, row) => sum + row.collectionIds.length, 0) >
      400
    )
      return failure("Organization import is too large")
    const importId = await startOrgImport(env, orgId, user.id, {
      collections,
      ciphers,
    })
    if (!(await completeOrgImport(env, importId)))
      return failure("Organization import is pending; retry sync shortly", 503)
    return new Response(null, { status: 200 })
  }
  if (path === "/api/ciphers/import" && method === "POST") {
    const body = await bodyOf(request)
    const rawFolders = body && field(body, "folders")
    const rawCiphers = body && field(body, "ciphers")
    const rawRelations = body && field(body, "folderRelationships")
    if (
      !Array.isArray(rawFolders) ||
      !Array.isArray(rawCiphers) ||
      !Array.isArray(rawRelations) ||
      rawFolders.length > 1000 ||
      rawCiphers.length > 1000 ||
      rawRelations.length > rawCiphers.length
    )
      return failure("Invalid vault import")
    const folders: { id: string | null; name: string }[] = []
    for (const raw of rawFolders) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return failure("Invalid vault import")
      const name = stringField(raw as Body, "name")
      if (!name || name.length > 10_000) return failure("Invalid vault import")
      const id = field(raw as Body, "id")
      if (
        id != null &&
        (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
      )
        return failure("Invalid vault import")
      folders.push({ id: (id as string | null) ?? null, name })
    }
    const folderIndices = new Map<number, number>()
    for (const raw of rawRelations) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return failure("Invalid vault import")
      const relation = raw as Body
      const key = numberField(relation, "key")
      const value = numberField(relation, "value")
      if (
        key === undefined ||
        value === undefined ||
        key < 0 ||
        key >= rawCiphers.length ||
        value < 0 ||
        value >= folders.length ||
        folderIndices.has(key)
      )
        return failure("Invalid vault import")
      folderIndices.set(key, value)
    }
    const ciphers: { payload: string; folderIndex: number | null }[] = []
    for (const [index, raw] of rawCiphers.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return failure("Invalid vault import")
      const cipher = raw as Body
      const name = stringField(cipher, "name")
      const type = numberField(cipher, "type")
      const orgId = field(cipher, "organizationId")
      const payload = JSON.stringify(cipher)
      if (
        !name ||
        !type ||
        type < 1 ||
        type > 5 ||
        orgId != null ||
        payload.length > 1_000_000
      )
        return failure("Invalid vault import")
      ciphers.push({ payload, folderIndex: folderIndices.get(index) ?? null })
    }
    await vault.importVault(folders, ciphers)
    return new Response(null, { status: 200 })
  }
  if (
    (path === "/api/ciphers" || path === "/api/ciphers/create") &&
    method === "POST"
  ) {
    const body = await bodyOf(request)
    if (!body || !stringField(body, "name") || !numberField(body, "type"))
      return failure("Invalid cipher")
    const orgId = stringField(body, "organizationId")
    if (orgId) {
      const member = await getVaultMembership(env, orgId, user.id)
      if (!member) return failure("Organization not found", 404)
      if (member.role > 1) return failure("Cipher creation is forbidden", 403)
      const collectionIds = collectionIdsField(body)
      if (
        !collectionIds ||
        !(await validOrgCollections(env, orgId, member, collectionIds))
      )
        return failure("Invalid collections")
      if (field(body, "folderId"))
        return failure("Shared ciphers cannot have personal folders")
      const id = crypto.randomUUID()
      await createOrgCipherLocator(env, id, orgId, collectionIds)
      const orgVault = await env.APP_DATABASE.getByName(`org:${orgId}`)
      try {
        const stored = await orgVault.putVaultCipher(id, JSON.stringify(body))
        return json(
          await cipherResponse(stored.cipher!, orgVault, user.id, origin, {
            id: orgId,
            collectionIds,
          })
        )
      } catch (error) {
        await deleteOrgCipherLocator(env, id)
        throw error
      }
    }
    const folderId = stringField(body, "folderId")
    if (folderId && !(await vault.getVaultFolder(folderId)))
      return failure("Folder not found", 404)
    const id = crypto.randomUUID()
    const stored = await vault.putVaultCipher(id, JSON.stringify(body))
    return json(await cipherResponse(stored.cipher!, vault, user.id, origin))
  }

  if (path === "/api/ciphers/share" && method === "PUT") {
    const body = await bodyOf(request)
    const rawCiphers = body && field(body, "ciphers")
    const collectionIds = body && collectionIdsField(body)
    if (
      !Array.isArray(rawCiphers) ||
      rawCiphers.length === 0 ||
      rawCiphers.length > 100 ||
      !collectionIds ||
      new Set(collectionIds).size !== collectionIds.length
    )
      return failure("Invalid shared ciphers")
    const ids = new Set<string>()
    let orgId: string | undefined
    for (const raw of rawCiphers) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return failure("Invalid shared ciphers")
      const cipher = raw as Body
      const id = stringField(cipher, "id")
      const target = stringField(cipher, "organizationId")
      if (
        !id ||
        !/^[0-9a-f-]{36}$/i.test(id) ||
        ids.has(id) ||
        !target ||
        (orgId && target !== orgId)
      )
        return failure("Invalid shared ciphers")
      ids.add(id)
      orgId = target
    }
    const member = await getVaultMembership(env, orgId!, user.id)
    if (!member || member.role > 1)
      return failure("Cipher sharing is forbidden", 403)
    if (!(await validOrgCollections(env, orgId!, member, collectionIds)))
      return failure("Invalid collections")
    for (const raw of rawCiphers) {
      const cipher = raw as Body
      const id = stringField(cipher, "id")!
      const response = await handleBitwarden(
        new Request(`${origin}/api/ciphers/${id}/share`, {
          method: "PUT",
          headers: {
            Authorization: request.headers.get("Authorization") ?? "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ cipher, collectionIds }),
        }),
        env
      )
      if (!response.ok) return response
    }
    return new Response(null, { status: 200 })
  }

  const shareMatch = /^\/api\/ciphers\/([0-9a-f-]{36})\/share$/.exec(path)
  if (shareMatch && (method === "POST" || method === "PUT")) {
    const id = shareMatch[1]!
    const body = await bodyOf(request)
    const cipher = body && field(body, "cipher")
    const collectionIds = body && collectionIdsField(body)
    if (!cipher || typeof cipher !== "object" || Array.isArray(cipher))
      return failure("Invalid shared cipher")
    const data = cipher as Body
    const orgId = stringField(data, "organizationId")
    if (
      !orgId ||
      !stringField(data, "name") ||
      !numberField(data, "type") ||
      field(data, "folderId") ||
      !collectionIds
    )
      return failure("Invalid shared cipher")
    const member = await getVaultMembership(env, orgId, user.id)
    if (!member || member.role > 1)
      return failure("Cipher sharing is forbidden", 403)
    if (!(await validOrgCollections(env, orgId, member, collectionIds)))
      return failure("Invalid collections")
    const existing = await getOrgCipherLocator(env, id)
    if (!existing) {
      const rawAttachments = field(data, "attachments2")
      if (
        rawAttachments != null &&
        (typeof rawAttachments !== "object" || Array.isArray(rawAttachments))
      )
        return failure("Invalid attachment keys")
      const attachmentKeys: Record<string, { fileName: string; key: string }> =
        {}
      for (const [attachmentId, raw] of Object.entries(
        (rawAttachments ?? {}) as Body
      )) {
        if (
          !/^[0-9a-f-]{36}$/i.test(attachmentId) ||
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw)
        )
          return failure("Invalid attachment keys")
        const fileName = stringField(raw as Body, "fileName")
        const key = stringField(raw as Body, "key")
        if (!fileName || !key) return failure("Invalid attachment keys")
        attachmentKeys[attachmentId] = { fileName, key }
      }
      const prepared = await startVaultShare(env, {
        cipherId: id,
        userId: user.id,
        orgId,
        collectionIds,
        payload: JSON.stringify(data),
        attachmentKeys,
        lastKnownRevisionDate: stringField(data, "lastKnownRevisionDate"),
      })
      if (prepared === "missing") return failure("Cipher not found", 404)
      if (prepared === "conflict")
        return failure("Cipher was changed concurrently", 409)
      if (prepared === "invalid") return failure("Invalid shared cipher")
      if (prepared === "busy")
        return failure("Cipher transfer is in progress", 409)
      try {
        if (!(await completeVaultShare(env, id)))
          return failure("Cipher transfer could not complete", 409)
      } catch {
        return failure("Cipher transfer will retry", 503)
      }
    } else if (existing.orgId !== orgId) {
      return failure("Organization mismatch", 409)
    }
    const locator = await getOrgCipherLocator(env, id)
    if (!locator) return failure("Cipher transfer will retry", 503)
    const orgVault = await env.APP_DATABASE.getByName(`org:${orgId}`)
    const shared = await orgVault.getVaultCipher(id)
    return shared
      ? json(
          await cipherResponse(shared, orgVault, user.id, origin, {
            id: orgId,
            collectionIds: locator.collectionIds,
          })
        )
      : failure("Cipher transfer will retry", 503)
  }

  const collectionUpdateMatch =
    /^\/api\/ciphers\/([0-9a-f-]{36})\/collections(_v2)?$/.exec(path)
  if (collectionUpdateMatch && (method === "PUT" || method === "POST")) {
    const locator = await getOrgCipherLocator(env, collectionUpdateMatch[1]!)
    if (!locator) return failure("Cipher not found", 404)
    const member = await getVaultMembership(env, locator.orgId, user.id)
    if (!member) return failure("Cipher not found", 404)
    if (member.role > 1) return failure("Collection editing is forbidden", 403)
    const body = await bodyOf(request)
    const collectionIds = body && collectionIdsField(body)
    if (
      !collectionIds ||
      !(await validOrgCollections(env, locator.orgId, member, collectionIds))
    )
      return failure("Invalid collections")
    const orgVault = await env.APP_DATABASE.getByName(`org:${locator.orgId}`)
    const cipher = await orgVault.getVaultCipher(locator.id)
    if (!cipher) return failure("Cipher not found", 404)
    await setOrgCipherCollections(env, locator.id, collectionIds)
    const updated = await cipherResponse(cipher, orgVault, user.id, origin, {
      id: locator.orgId,
      collectionIds,
    })
    return json(
      collectionUpdateMatch[2]
        ? {
            object: "optionalCipherDetails",
            unavailable: false,
            cipher: updated,
          }
        : updated
    )
  }
  const sharedCipherMatch =
    /^\/api\/ciphers\/([0-9a-f-]{36})(?:\/details|\/delete|\/restore)?$/.exec(
      path
    )
  if (sharedCipherMatch) {
    const locator = await getOrgCipherLocator(env, sharedCipherMatch[1]!)
    if (locator) {
      const member = await getVaultMembership(env, locator.orgId, user.id)
      const available =
        member &&
        new Set(
          (await listVaultCollections(env, locator.orgId, member)).map(
            (row) => row.id
          )
        )
      const visible =
        available && locator.collectionIds.filter((id) => available.has(id))
      if (!visible?.length) return failure("Cipher not found", 404)
      const orgVault = await env.APP_DATABASE.getByName(`org:${locator.orgId}`)
      const response = async (cipher: CipherRow) =>
        json(
          await cipherResponse(cipher, orgVault, user.id, origin, {
            id: locator.orgId,
            collectionIds: visible,
          })
        )
      if (method === "GET") {
        const cipher = await orgVault.getVaultCipher(locator.id)
        return cipher ? response(cipher) : failure("Cipher not found", 404)
      }
      if (!member || member.role > 1)
        return failure("Cipher editing is forbidden", 403)
      if (path.endsWith("/restore") && method === "PUT") {
        const restored = await orgVault.restoreVaultCipher(locator.id)
        return restored ? response(restored) : failure("Cipher not found", 404)
      }
      if (
        method === "DELETE" ||
        (method === "POST" && path.endsWith("/delete"))
      ) {
        const result = await orgVault.trashVaultCipher(locator.id)
        return result.found
          ? new Response(null, { status: 204 })
          : failure("Cipher not found", 404)
      }
      if (method === "PUT" || method === "POST") {
        const body = await bodyOf(request)
        if (
          !body ||
          !stringField(body, "name") ||
          !numberField(body, "type") ||
          stringField(body, "organizationId") !== locator.orgId ||
          field(body, "folderId")
        )
          return failure("Invalid shared cipher")
        const collectionIds = collectionIdsField(body)
        if (
          !collectionIds ||
          collectionIds.length !== locator.collectionIds.length ||
          !collectionIds.every((id) => locator.collectionIds.includes(id))
        )
          return failure(
            "Moving shared ciphers between collections is unavailable",
            409
          )
        const existing = await orgVault.getVaultCipher(locator.id)
        if (!existing) return failure("Cipher not found", 404)
        const stored = await orgVault.putVaultCipher(
          locator.id,
          JSON.stringify(body),
          undefined,
          stringField(body, "lastKnownRevisionDate")
        )
        return stored.conflict
          ? failure("Cipher was changed concurrently", 409)
          : response(stored.cipher!)
      }
    }
  }

  const attachmentMatch =
    /^\/api\/ciphers\/([0-9a-f-]{36})\/attachment(?:\/([0-9a-f-]{36}|v2))?(?:\/delete)?$/.exec(
      path
    )
  if (attachmentMatch) {
    const cipherId = attachmentMatch[1]!
    const attachmentId = attachmentMatch[2]
    const locator = await getOrgCipherLocator(env, cipherId)
    const member =
      locator && (await getVaultMembership(env, locator.orgId, user.id))
    const available =
      member &&
      new Set(
        (await listVaultCollections(env, locator!.orgId, member)).map(
          (row) => row.id
        )
      )
    const visible =
      locator &&
      available &&
      locator.collectionIds.filter((id) => available.has(id))
    if (locator && !visible?.length) return failure("Cipher not found", 404)
    const attachmentVault = locator
      ? await env.APP_DATABASE.getByName(`org:${locator.orgId}`)
      : vault
    const organization =
      locator && visible
        ? { id: locator.orgId, collectionIds: visible }
        : undefined
    const objectPrefix = locator ? `org/${locator.orgId}` : user.id
    const canEdit = !locator || (member && member.role <= 1)
    const cipher = await attachmentVault.getVaultCipher(cipherId)
    if (!cipher || cipher.deletedAt) return failure("Cipher not found", 404)
    const response = async () =>
      json(
        await cipherResponse(
          cipher,
          attachmentVault,
          user.id,
          origin,
          organization
        )
      )
    if (attachmentId === "v2" && method === "POST") {
      if (!canEdit) return failure("Attachment editing is forbidden", 403)
      const body = await bodyOf(request)
      const fileName = body && stringField(body, "fileName")
      const key = body && stringField(body, "key")
      const rawSize = body && field(body, "fileSize")
      const size = Number(rawSize)
      if (
        !fileName ||
        !key ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > 20_000_000
      )
        return failure("Invalid attachment")
      const id = crypto.randomUUID()
      await attachmentVault.createVaultAttachment({
        id,
        cipherId,
        fileName,
        key,
        size,
      })
      return json({
        object: "attachment-fileUpload",
        attachmentId: id,
        url: `/ciphers/${cipherId}/attachment/${id}`,
        fileUploadType: 0,
        cipherResponse: await cipherResponse(
          cipher,
          attachmentVault,
          user.id,
          origin,
          organization
        ),
      })
    }
    if (!attachmentId && method === "POST") {
      if (!canEdit) return failure("Attachment editing is forbidden", 403)
      const form = await request.formData()
      const data = form.get("data")
      if (!(data instanceof File) || data.size > 20_000_000)
        return failure("Invalid attachment")
      const key = form.get("key")
      const id = crypto.randomUUID()
      await attachmentVault.createVaultAttachment({
        id,
        cipherId,
        fileName: data.name,
        key: typeof key === "string" ? key : null,
        size: data.size,
      })
      const objectKey = `${objectPrefix}/${cipherId}/${id}`
      await env.VAULT_ATTACHMENTS.put(objectKey, data.stream())
      if (
        !(await keepCompletedUpload(env, objectKey, () =>
          attachmentVault.completeVaultAttachment(id, cipherId)
        ))
      )
        return failure("Attachment upload failed", 503)
      return response()
    }
    if (attachmentId && attachmentId !== "v2") {
      const attachment = await attachmentVault.getVaultAttachment(
        attachmentId,
        cipherId
      )
      if (!attachment) return failure("Attachment not found", 404)
      if (method === "POST" && !path.endsWith("/delete")) {
        if (!canEdit) return failure("Attachment editing is forbidden", 403)
        if (attachment.uploaded)
          return failure("Attachment already uploaded", 409)
        const form = await request.formData()
        const data = form.get("data")
        if (!(data instanceof File) || data.size !== attachment.size)
          return failure("Attachment size mismatch")
        const objectKey = `${objectPrefix}/${cipherId}/${attachmentId}`
        await env.VAULT_ATTACHMENTS.put(objectKey, data.stream())
        if (
          !(await keepCompletedUpload(env, objectKey, () =>
            attachmentVault.completeVaultAttachment(attachmentId, cipherId)
          ))
        )
          return failure("Attachment upload failed", 503)
        return new Response(null, { status: 204 })
      }
      if (method === "GET")
        return attachment.uploaded
          ? json(
              await attachmentResponse(
                attachmentVault,
                attachment,
                user.id,
                origin,
                locator?.orgId
              )
            )
          : failure("Attachment not found", 404)
      if (
        method === "DELETE" ||
        (method === "POST" && path.endsWith("/delete"))
      ) {
        if (!canEdit) return failure("Attachment editing is forbidden", 403)
        await env.VAULT_ATTACHMENTS.delete(
          `${objectPrefix}/${cipherId}/${attachmentId}`
        )
        await attachmentVault.deleteVaultAttachment(attachmentId, cipherId)
        return response()
      }
    }
  }
  const cipherMatch =
    /^\/api\/ciphers\/([0-9a-f-]{36})(?:\/details|\/delete|\/restore|\/partial)?$/.exec(
      path
    )
  if (cipherMatch) {
    const id = cipherMatch[1]!
    if (method === "GET") {
      const cipher = await vault.getVaultCipher(id)
      return cipher
        ? json(await cipherResponse(cipher, vault, user.id, origin))
        : failure("Cipher not found", 404)
    }
    if (path.endsWith("/restore") && method === "PUT") {
      const restored = await vault.restoreVaultCipher(id)
      return restored
        ? json(await cipherResponse(restored, vault, user.id, origin))
        : failure("Cipher not found", 404)
    }
    if (path.endsWith("/partial") && (method === "PUT" || method === "POST")) {
      const body = await bodyOf(request)
      const existing = await vault.getVaultCipher(id)
      if (!existing) return failure("Cipher not found", 404)
      if (!body) return failure("Invalid cipher")
      const folderId = stringField(body, "folderId")
      if (folderId && !(await vault.getVaultFolder(folderId)))
        return failure("Folder not found", 404)
      const payload = JSON.parse(existing.payload) as Body
      payload.folderId = field(body, "folderId") ?? null
      payload.favorite = field(body, "favorite") === true
      const stored = await vault.putVaultCipher(
        id,
        JSON.stringify(payload),
        existing.revision
      )
      return stored.conflict
        ? failure("Cipher was changed concurrently", 409)
        : json(await cipherResponse(stored.cipher!, vault, user.id, origin))
    }
    if ((method === "PUT" || method === "POST") && !path.endsWith("/delete")) {
      const body = await bodyOf(request)
      if (!body || !stringField(body, "name") || !numberField(body, "type"))
        return failure("Invalid cipher")
      if (!(await vault.getVaultCipher(id)))
        return failure("Cipher not found", 404)
      const folderId = stringField(body, "folderId")
      if (folderId && !(await vault.getVaultFolder(folderId)))
        return failure("Folder not found", 404)
      const stored = await vault.putVaultCipher(
        id,
        JSON.stringify(body),
        undefined,
        stringField(body, "lastKnownRevisionDate")
      )
      return stored.conflict
        ? failure("Cipher was changed concurrently", 409)
        : json(await cipherResponse(stored.cipher!, vault, user.id, origin))
    }
    if (method === "DELETE" || path.endsWith("/delete")) {
      const result = await vault.trashVaultCipher(id)
      return result.found
        ? new Response(null, { status: 204 })
        : failure("Cipher not found", 404)
    }
  }

  if (path === "/api/folders" && method === "GET") {
    const data = await vault.listVault()
    return json(list(data.folders.map(folderResponse)))
  }
  if (path === "/api/folders" && method === "POST") {
    const body = await bodyOf(request)
    const name = body && stringField(body, "name")
    if (!name) return failure("Invalid folder")
    const stored = await vault.putVaultFolder(crypto.randomUUID(), name)
    return json(folderResponse(stored.folder!))
  }
  const folderMatch = /^\/api\/folders\/([0-9a-f-]{36})(?:\/delete)?$/.exec(
    path
  )
  if (folderMatch) {
    const id = folderMatch[1]!
    if (method === "GET") {
      const folder = await vault.getVaultFolder(id)
      return folder
        ? json(folderResponse(folder))
        : failure("Folder not found", 404)
    }
    if (method === "PUT" || (method === "POST" && !path.endsWith("/delete"))) {
      const body = await bodyOf(request)
      const name = body && stringField(body, "name")
      if (!name) return failure("Invalid folder")
      if (!(await vault.getVaultFolder(id)))
        return failure("Folder not found", 404)
      const stored = await vault.putVaultFolder(id, name)
      return stored.conflict
        ? failure("Folder was changed concurrently", 409)
        : json(folderResponse(stored.folder!))
    }
    if (method === "DELETE" || (method === "POST" && path.endsWith("/delete")))
      return (await vault.deleteVaultFolder(id))
        ? new Response(null, { status: 204 })
        : failure("Folder not found", 404)
  }

  return failure("Not found", 404)
}
