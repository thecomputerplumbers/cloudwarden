import {
  authenticatedVaultUser,
  createVaultUser,
  findVaultUser,
  issueVaultSession,
  normalizeEmail,
  refreshVaultSession,
  verifyVaultPassword,
  type VaultUser,
} from "./bitwarden-auth"
import type { AppDatabase } from "./database"

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
  const key = Object.keys(body).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase()
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

function profile(user: VaultUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: false,
    premium: true,
    premiumFromOrganization: false,
    culture: "en-US",
    twoFactorEnabled: false,
    key: user.key,
    privateKey: user.privateKey,
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
  return {
    access_token: tokens.access,
    refresh_token: tokens.refresh,
    expires_in: tokens.expiresIn,
    token_type: "Bearer",
    scope: "api offline_access",
    Key: user.key,
    PrivateKey: user.privateKey,
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

function cipherResponse(row: CipherRow) {
  const data = JSON.parse(row.payload) as Body
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
    attachments: null,
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
    path.startsWith("/api/accounts/")
  )
}

export async function handleBitwarden(request: Request, env: CloudflareEnv) {
  const url = new URL(request.url)
  const path = url.pathname.toLowerCase()
  const method = request.method.toUpperCase()

  if (path === "/api/config" && method === "GET") {
    const origin = url.origin
    return json({
      version: "2026.6.0",
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
  if (path === "/api/version" && method === "GET") return json("2026.6.0")

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
    const keys = field(body, "keys") as Body | undefined
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
    if (grant !== "password") return failure("Unsupported grant type")
    const username = stringField(body, "username")
    const password = stringField(body, "password")
    const deviceId = stringField(body, "device_identifier")
    if (!username || !password || !deviceId || deviceId.length > 200)
      return failure("Missing credentials")
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown"
    const limiter = await env.APP_DATABASE.getByName("bitwarden-login-rates")
    const allowed = await limiter.consumeRateLimit(`login:${ip}`, 10, 60_000)
    if (!allowed.allowed) return failure("Too many login attempts", 429)
    const user = await findVaultUser(env, username)
    if (!(await verifyVaultPassword(user, password)) || !user)
      return failure("Username or password is incorrect", 400)
    return json(
      tokenResponse(user, await issueVaultSession(env, user, deviceId))
    )
  }

  const user = await authenticatedVaultUser(env, request)
  if (!user) return failure("Unauthorized", 401)
  const vault = await env.APP_DATABASE.getByName(`vault:${user.id}`)

  if (path === "/api/accounts/profile" && method === "GET")
    return json(profile(user))
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
  if (path === "/api/sync" && method === "GET") {
    const data = await vault.listVault()
    return json({
      profile: profile(user),
      folders: data.folders.map(folderResponse),
      collections: [],
      policies: [],
      ciphers: data.ciphers.map(cipherResponse),
      domains: {
        equivalentDomains: [],
        globalEquivalentDomains: [],
        object: "domains",
      },
      sends: [],
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
    return json(list(data.ciphers.map(cipherResponse)))
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
    return json(cipherResponse(stored.cipher!), 201)
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
        ? json(cipherResponse(cipher))
        : failure("Cipher not found", 404)
    }
    if (path.endsWith("/restore") && method === "PUT") {
      const restored = await vault.restoreVaultCipher(id)
      return restored
        ? json(cipherResponse(restored))
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
        : json(cipherResponse(stored.cipher!))
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
        : json(cipherResponse(stored.cipher!))
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
    return json(folderResponse(stored.folder!), 201)
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
