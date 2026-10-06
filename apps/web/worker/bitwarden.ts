import {
  authenticatedVaultUser,
  createVaultUser,
  findVaultUser,
  findVaultUserById,
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
  parseTextSend,
  sendAccessResponse,
  sendIdFromAccessId,
  sendResponse,
} from "./bitwarden-send"

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

function profile(user: VaultUser, twoFactorEnabled = false) {
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
    emailVerified: false,
    premium: true,
    premiumFromOrganization: false,
    culture: "en-US",
    twoFactorEnabled,
    key: user.key,
    privateKey: user.privateKey,
    accountKeys,
    securityStamp: user.securityStamp,
    organizations: [],
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
    Key: user.key,
    PrivateKey: user.privateKey,
    AccountKeys: accountKeys,
    Kdf: user.kdf,
    KdfIterations: user.kdfIterations,
    KdfMemory: user.kdfMemory,
    KdfParallelism: user.kdfParallelism,
    ResetMasterPassword: false,
    ForcePasswordReset: false,
    UserDecryptionOptions: {
      HasMasterPassword: true,
      MasterPasswordUnlock: {
        Kdf: {
          KdfType: user.kdf,
          Iterations: user.kdfIterations,
          Memory: user.kdfMemory,
          Parallelism: user.kdfParallelism,
        },
        MasterKeyEncryptedUserKey: user.key,
        MasterKeyWrappedUserKey: user.key,
        Salt: user.email,
      },
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
  origin: string
) {
  const token = await vault.issueVaultAttachmentToken(
    attachment.id,
    attachment.cipherId
  )
  if (!token) throw new Error("Attachment became unavailable")
  return {
    id: attachment.id,
    url: `${origin}/attachments/${attachment.cipherId}/${attachment.id}?token=${userId}.${token}`,
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
  origin: string
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
    organizationId: null,
    key: field(data, "key") ?? null,
    attachments: attachments.length
      ? await Promise.all(
          attachments.map((attachment) =>
            attachmentResponse(vault, attachment, userId, origin)
          )
        )
      : null,
    organizationUseTotp: true,
    collectionIds: [],
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
    path === "/api/settings/domains" ||
    path === "/api/ciphers" ||
    path.startsWith("/api/ciphers/") ||
    path === "/api/folders" ||
    path.startsWith("/api/folders/") ||
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

async function readPublicSend(env: CloudflareEnv, bearer: string) {
  const [accessId] = bearer.split(".")
  const id = accessId && sendIdFromAccessId(accessId)
  if (!id) return null
  const locator = await getSendLocator(env, id)
  if (!locator) return null
  const vault = await env.APP_DATABASE.getByName(`vault:${locator.userId}`)
  const send = await vault.accessVaultSend(id, await tokenHash(bearer))
  const user = send && (await findVaultUserById(env, locator.userId))
  return send && user ? sendAccessResponse(send, user.email) : null
}

export async function handleBitwarden(request: Request, env: CloudflareEnv) {
  const url = new URL(request.url)
  const path = url.pathname.toLowerCase()
  const method = request.method.toUpperCase()

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
    const [userId, token] = (url.searchParams.get("token") ?? "").split(".")
    if (!userId || !token || !/^[0-9a-f-]{36}$/.test(userId))
      return failure("Attachment not found", 404)
    const vault = await env.APP_DATABASE.getByName(`vault:${userId}`)
    const authorized = await vault.validateVaultAttachmentToken(
      downloadMatch[2]!,
      downloadMatch[1]!,
      token
    )
    if (!authorized) return failure("Attachment not found", 404)
    const object = await env.VAULT_ATTACHMENTS.get(
      `${userId}/${downloadMatch[1]}/${downloadMatch[2]}`
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
    const origin = url.origin
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
    (path === "/identity/accounts/register" ||
      path === "/api/accounts/register") &&
    method === "POST"
  ) {
    if (!registrationsAllowed(env))
      return failure("Registration is disabled", 403)
    const body = await bodyOf(request)
    if (!body) return failure("Invalid registration request")
    const email = stringField(body, "email")
    const authentication = field(body, "masterPasswordAuthentication") as
      | Body
      | undefined
    const unlock = field(body, "masterPasswordUnlock") as Body | undefined
    const kdfSettings = (authentication && field(authentication, "kdf")) as
      | Body
      | undefined
    const legacyHash = stringField(body, "masterPasswordHash")
    const hash =
      (authentication && stringField(authentication, "hash")) ?? legacyHash
    const key =
      (unlock && stringField(unlock, "key")) ?? stringField(body, "key")
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
    if (await findVaultUser(env, email))
      return failure("Registration unavailable", 409)
    const keys = (field(body, "keys") ?? field(body, "userAsymmetricKeys")) as
      | Body
      | undefined
    try {
      await createVaultUser(env, {
        email,
        name: stringField(body, "name")?.slice(0, 50) ?? normalizeEmail(email),
        masterPasswordHash: hash,
        key,
        privateKey: keys && stringField(keys, "encryptedPrivateKey"),
        publicKey: keys && stringField(keys, "publicKey"),
        kdf,
        kdfIterations: iterations,
      })
    } catch {
      return failure("Registration unavailable", 409)
    }
    return json({ object: "register", captchaBypassToken: "" })
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
    const factor = await getTotp(env, user.id)
    if (factor) {
      const code = stringField(body, "two_factor_token")
      const provider = integerField(body, "two_factor_provider") ?? 0
      if (!code)
        return json(
          {
            error: "invalid_grant",
            error_description: "Two factor required.",
            TwoFactorProviders: ["0"],
            TwoFactorProviders2: { "0": null },
            MasterPasswordPolicy: { Object: "masterPasswordPolicy" },
          },
          400
        )
      const secondFactorAllowed = await limiter.consumeRateLimit(
        `totp:${user.id}`,
        15,
        5 * 60_000
      )
      if (!secondFactorAllowed.allowed)
        return failure("Too many two-factor attempts", 429)
      const valid =
        provider === 0
          ? await verifyTotpLogin(env, factor, code)
          : provider === 8
            ? await redeemTotpRecoveryCode(env, user.id, code)
            : false
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

  if (path === "/api/two-factor" && method === "GET")
    return json({
      data: (await getTotp(env, user.id))
        ? [{ enabled: true, type: 0, object: "twoFactorProvider" }]
        : [],
      object: "list",
      continuationToken: null,
    })
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
    const factor = await getTotp(env, user.id)
    return factor
      ? json({ code: factor.recoveryCode, object: "twoFactorRecover" })
      : failure("Two-factor authentication is disabled", 404)
  }
  if (
    (path === "/api/two-factor/disable" ||
      path === "/api/two-factor/authenticator") &&
    (method === "POST" || method === "PUT" || method === "DELETE")
  ) {
    const body = await bodyOf(request)
    const password = body && stringField(body, "masterPasswordHash")
    if (!password || !(await verifyVaultPassword(user, password)))
      return failure("Invalid password", 403)
    if (body && integerField(body, "type") !== 0)
      return failure("Invalid two-factor provider")
    const factor = await getTotp(env, user.id)
    if (!factor) return failure("Two-factor authentication is disabled", 404)
    const key = body && stringField(body, "key")
    if (path === "/api/two-factor/authenticator" && key !== factor.secret)
      return failure("Invalid authenticator key", 403)
    await disableTotp(env, user.id, request)
    return json({ enabled: false, type: 0, object: "twoFactorProvider" })
  }

  if (path === "/api/accounts/profile" && method === "GET")
    return json(profile(user, !!(await getTotp(env, user.id))))
  if (
    path === "/api/accounts/profile" &&
    (method === "POST" || method === "PUT")
  ) {
    const body = await bodyOf(request)
    const name = body && stringField(body, "name")
    if (!name || name.length > 50) return failure("Invalid profile name")
    const updated = await updateVaultProfile(env, user.id, name)
    return json(profile(updated, !!(await getTotp(env, user.id))))
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
  if (path === "/api/accounts/revision-date" && method === "GET")
    return json(
      new Date(
        Math.max(user.updatedAt.getTime(), await vault.vaultRevision())
      ).toISOString()
    )
  if (path === "/api/settings/domains" && method === "GET")
    return json({
      equivalentDomains: [],
      globalEquivalentDomains: [],
      object: "domains",
    })
  if (path === "/api/sends" && method === "GET")
    return json(list((await vault.listVaultSends()).map(sendResponse)))
  if (path === "/api/sends" && method === "POST") {
    const body = await bodyOf(request)
    const input = body && parseTextSend(body)
    if (!input) return failure("Invalid Send")
    const id = crypto.randomUUID()
    const password = input.password
      ? await (async () => {
          const salt = newSendPasswordSalt()
          return { salt, hash: await hashSendPassword(input.password!, salt) }
        })()
      : null
    const send = await vault.putVaultSend(id, { ...input, password })
    try {
      await createSendLocator(env, id, user.id)
    } catch {
      await vault.deleteVaultSend(id)
      return failure("Could not create Send", 503)
    }
    return json(sendResponse(send))
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
      return new Response(null, { status: 200 })
    }
    if (!sendMatch[2] && method === "PUT") {
      const body = await bodyOf(request)
      const input = body && parseTextSend(body)
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
    return json({
      profile: profile(user, !!(await getTotp(env, user.id))),
      folders: data.folders.map(folderResponse),
      collections: [],
      policies: [],
      ciphers: await Promise.all(
        data.ciphers.map((cipher) =>
          cipherResponse(cipher, vault, user.id, url.origin)
        )
      ),
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
      list(
        await Promise.all(
          data.ciphers.map((cipher) =>
            cipherResponse(cipher, vault, user.id, url.origin)
          )
        )
      )
    )
  }
  if (
    (path === "/api/ciphers" || path === "/api/ciphers/create") &&
    method === "POST"
  ) {
    const body = await bodyOf(request)
    if (!body || !stringField(body, "name") || !numberField(body, "type"))
      return failure("Invalid cipher")
    if (field(body, "organizationId"))
      return failure("Organization ciphers are unavailable", 501)
    const folderId = stringField(body, "folderId")
    if (folderId && !(await vault.getVaultFolder(folderId)))
      return failure("Folder not found", 404)
    const id = crypto.randomUUID()
    const stored = await vault.putVaultCipher(id, JSON.stringify(body))
    return json(
      await cipherResponse(stored.cipher!, vault, user.id, url.origin)
    )
  }

  const attachmentMatch =
    /^\/api\/ciphers\/([0-9a-f-]{36})\/attachment(?:\/([0-9a-f-]{36}|v2))?(?:\/delete)?$/.exec(
      path
    )
  if (attachmentMatch) {
    const cipherId = attachmentMatch[1]!
    const attachmentId = attachmentMatch[2]
    const cipher = await vault.getVaultCipher(cipherId)
    if (!cipher || cipher.deletedAt) return failure("Cipher not found", 404)
    if (attachmentId === "v2" && method === "POST") {
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
      await vault.createVaultAttachment({ id, cipherId, fileName, key, size })
      return json({
        object: "attachment-fileUpload",
        attachmentId: id,
        url: `/ciphers/${cipherId}/attachment/${id}`,
        fileUploadType: 0,
        cipherResponse: await cipherResponse(
          cipher,
          vault,
          user.id,
          url.origin
        ),
      })
    }
    if (!attachmentId && method === "POST") {
      const form = await request.formData()
      const data = form.get("data")
      if (!(data instanceof File) || data.size > 20_000_000)
        return failure("Invalid attachment")
      const key = form.get("key")
      const id = crypto.randomUUID()
      await vault.createVaultAttachment({
        id,
        cipherId,
        fileName: data.name,
        key: typeof key === "string" ? key : null,
        size: data.size,
      })
      await env.VAULT_ATTACHMENTS.put(
        `${user.id}/${cipherId}/${id}`,
        data.stream()
      )
      if (!(await vault.completeVaultAttachment(id, cipherId)))
        return failure("Attachment upload failed", 503)
      return json(await cipherResponse(cipher, vault, user.id, url.origin))
    }
    if (attachmentId && attachmentId !== "v2") {
      const attachment = await vault.getVaultAttachment(attachmentId, cipherId)
      if (!attachment) return failure("Attachment not found", 404)
      if (method === "POST" && !path.endsWith("/delete")) {
        if (attachment.uploaded)
          return failure("Attachment already uploaded", 409)
        const form = await request.formData()
        const data = form.get("data")
        if (!(data instanceof File) || data.size !== attachment.size)
          return failure("Attachment size mismatch")
        await env.VAULT_ATTACHMENTS.put(
          `${user.id}/${cipherId}/${attachmentId}`,
          data.stream()
        )
        if (!(await vault.completeVaultAttachment(attachmentId, cipherId)))
          return failure("Attachment upload failed", 503)
        return new Response(null, { status: 204 })
      }
      if (method === "GET")
        return attachment.uploaded
          ? json(
              await attachmentResponse(vault, attachment, user.id, url.origin)
            )
          : failure("Attachment not found", 404)
      if (
        method === "DELETE" ||
        (method === "POST" && path.endsWith("/delete"))
      ) {
        await env.VAULT_ATTACHMENTS.delete(
          `${user.id}/${cipherId}/${attachmentId}`
        )
        await vault.deleteVaultAttachment(attachmentId, cipherId)
        return json(await cipherResponse(cipher, vault, user.id, url.origin))
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
        ? json(await cipherResponse(cipher, vault, user.id, url.origin))
        : failure("Cipher not found", 404)
    }
    if (path.endsWith("/restore") && method === "PUT") {
      const restored = await vault.restoreVaultCipher(id)
      return restored
        ? json(await cipherResponse(restored, vault, user.id, url.origin))
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
        : json(await cipherResponse(stored.cipher!, vault, user.id, url.origin))
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
        : json(await cipherResponse(stored.cipher!, vault, user.id, url.origin))
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
