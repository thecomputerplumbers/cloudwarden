import { drizzle } from "drizzle-orm/d1"
import { and, eq, gt, isNotNull, isNull, ne, or, sql } from "drizzle-orm"

import {
  vaultApiKey,
  vaultCipherTransfer,
  vaultDevice,
  vaultOrgImport,
  vaultMembership,
  vaultSession,
  vaultUser,
} from "../db/schema/vault"
import {
  discoverVaultOidc,
  openVaultOidcRefresh,
  refreshVaultOidc,
  sealVaultOidcRefresh,
} from "./bitwarden-oidc"

export type VaultUser = typeof vaultUser.$inferSelect

const ACCESS_LIFETIME_MS = 60 * 60 * 1000
const REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
const ACCESS_REFRESH_OVERLAP_MS = 30 * 1000
const encoder = new TextEncoder()

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return base64Url(bytes)
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

async function accessToken(
  env: CloudflareEnv,
  user: VaultUser,
  deviceId: string,
  clientId: string,
  deviceType: string,
  apiKey = false
) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new Error("Token signing secret is not configured")
  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(
    encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  )
  const payload = base64Url(
    encoder.encode(
      JSON.stringify({
        nbf: now,
        exp: now + ACCESS_LIFETIME_MS / 1000,
        iss: "cloudwarden|login",
        sub: user.id,
        premium: true,
        name: user.name,
        email: user.email,
        email_verified: user.emailVerified,
        sstamp: user.securityStamp,
        device: deviceId,
        devicetype: deviceType,
        client_id: clientId,
        scope: apiKey ? ["api"] : ["api", "offline_access"],
        amr: ["Application"],
        jti: crypto.randomUUID(),
      })
    )
  )
  const input = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(input))
  return `${input}.${base64Url(new Uint8Array(signature))}`
}

export async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token))
  return bytesToHex(new Uint8Array(digest))
}

export async function hashClientPassword(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: 120_000,
    },
    key,
    256
  )
  return bytesToHex(new Uint8Array(derived))
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let different = 0
  for (let i = 0; i < a.length; i++)
    different |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return different === 0
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

export async function createVaultUser(
  env: CloudflareEnv,
  input: {
    email: string
    name: string
    masterPasswordHash: string
    passwordHint?: string | null
    key: string
    privateKey?: string
    publicKey?: string
    kdf: number
    kdfIterations: number
    kdfMemory?: number
    kdfParallelism?: number
    emailVerified?: boolean
  }
) {
  const db = drizzle(env.DB)
  const email = normalizeEmail(input.email)
  const salt = randomToken()
  const now = new Date()
  const user: typeof vaultUser.$inferInsert = {
    id: crypto.randomUUID(),
    email,
    name: input.name || email,
    passwordSalt: salt,
    passwordHash: await hashClientPassword(input.masterPasswordHash, salt),
    passwordHint: input.passwordHint ?? null,
    key: input.key,
    privateKey: input.privateKey ?? null,
    publicKey: input.publicKey ?? null,
    kdf: input.kdf,
    kdfIterations: input.kdfIterations,
    kdfMemory: input.kdfMemory ?? null,
    kdfParallelism: input.kdfParallelism ?? null,
    emailVerified: input.emailVerified ?? false,
    securityStamp: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(vaultUser).values(user).run()
  return user
}

export async function createVaultStubUser(
  env: CloudflareEnv,
  email: string,
  name: string,
  emailVerified = false
) {
  const now = new Date()
  return drizzle(env.DB)
    .insert(vaultUser)
    .values({
      id: crypto.randomUUID(),
      email: normalizeEmail(email),
      name,
      emailVerified,
      passwordHash: "",
      passwordSalt: "",
      key: "",
      privateKey: null,
      publicKey: null,
      kdf: 0,
      kdfIterations: 600_000,
      kdfMemory: null,
      kdfParallelism: null,
      securityStamp: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()
}

export async function initializeVaultPassword(
  env: CloudflareEnv,
  userId: string,
  input: {
    masterPasswordHash: string
    passwordHint?: string | null
    key: string
    privateKey: string
    publicKey: string
    kdf: number
    kdfIterations: number
    kdfMemory: number | null
    kdfParallelism: number | null
    name?: string
    emailVerified?: boolean
  }
) {
  const salt = randomToken()
  return drizzle(env.DB)
    .update(vaultUser)
    .set({
      passwordHash: await hashClientPassword(input.masterPasswordHash, salt),
      passwordHint: input.passwordHint ?? null,
      passwordSalt: salt,
      key: input.key,
      privateKey: input.privateKey,
      publicKey: input.publicKey,
      kdf: input.kdf,
      kdfIterations: input.kdfIterations,
      kdfMemory: input.kdfMemory,
      kdfParallelism: input.kdfParallelism,
      ...(input.name ? { name: input.name } : {}),
      ...(input.emailVerified ? { emailVerified: true } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(vaultUser.id, userId),
        eq(vaultUser.passwordHash, ""),
        eq(vaultUser.key, ""),
        isNull(vaultUser.privateKey),
        isNull(vaultUser.deletingAt)
      )
    )
    .returning()
    .get()
}

export async function findVaultUser(env: CloudflareEnv, email: string) {
  return (
    (await drizzle(env.DB)
      .select()
      .from(vaultUser)
      .where(
        and(
          eq(vaultUser.email, normalizeEmail(email)),
          isNull(vaultUser.deletingAt)
        )
      )
      .get()) ?? null
  )
}

export async function findVaultUserById(env: CloudflareEnv, id: string) {
  return (
    (await drizzle(env.DB)
      .select()
      .from(vaultUser)
      .where(and(eq(vaultUser.id, id), isNull(vaultUser.deletingAt)))
      .get()) ?? null
  )
}

export async function beginVaultDeletion(
  env: CloudflareEnv,
  id: string,
  expectedPasswordHash: string
) {
  return !!(await drizzle(env.DB)
    .update(vaultUser)
    .set({ deletingAt: new Date() })
    .where(
      and(
        eq(vaultUser.id, id),
        eq(vaultUser.passwordHash, expectedPasswordHash),
        isNull(vaultUser.deletingAt),
        sql`not exists (
          select 1 from ${vaultMembership} owned
          where owned.user_id = ${id} and owned.role = 0 and owned.status = 2
            and not exists (
              select 1 from ${vaultMembership} other
              inner join ${vaultUser} other_user on other_user.id = other.user_id
              where other.org_id = owned.org_id and other.id != owned.id
                and other.role = 0 and other.status = 2
                and other_user.deleting_at is null
            )
        )`
      )
    )
    .returning({ id: vaultUser.id })
    .get())
}

export async function deletingVaultUsers(env: CloudflareEnv) {
  return drizzle(env.DB)
    .select({ id: vaultUser.id })
    .from(vaultUser)
    .where(isNotNull(vaultUser.deletingAt))
    .limit(10)
    .all()
}

export async function finishVaultDeletion(env: CloudflareEnv, id: string) {
  return !!(await drizzle(env.DB)
    .delete(vaultUser)
    .where(
      and(
        eq(vaultUser.id, id),
        isNotNull(vaultUser.deletingAt),
        sql`not exists (select 1 from ${vaultCipherTransfer} pending where pending.user_id = ${id})`,
        sql`not exists (select 1 from ${vaultOrgImport} pending where pending.user_id = ${id} and pending.completed_at is null)`
      )
    )
    .returning({ id: vaultUser.id })
    .get())
}

export async function verifyVaultPassword(
  user: VaultUser | null,
  supplied: string
) {
  // Always perform the KDF, including for unknown accounts.
  const computed = await hashClientPassword(
    supplied,
    user?.passwordSalt ?? "cloudwarden-unknown-account"
  )
  return !!user && constantTimeEqual(computed, user.passwordHash)
}

export async function updateVaultPassword(
  env: CloudflareEnv,
  user: VaultUser,
  request: Request,
  newPassword: string,
  newKey: string,
  passwordHint: string | null | undefined,
  kdf: {
    type: number
    iterations: number
    memory: number | null
    parallelism: number | null
  } | null
) {
  const db = drizzle(env.DB)
  const salt = randomToken()
  const nextSecurityStamp = crypto.randomUUID()
  const updated = await db
    .update(vaultUser)
    .set({
      passwordSalt: salt,
      passwordHash: await hashClientPassword(newPassword, salt),
      key: newKey,
      ...(passwordHint !== undefined ? { passwordHint } : {}),
      kdf: kdf?.type ?? user.kdf,
      kdfIterations: kdf?.iterations ?? user.kdfIterations,
      kdfMemory: kdf ? kdf.memory : user.kdfMemory,
      kdfParallelism: kdf ? kdf.parallelism : user.kdfParallelism,
      securityStamp: nextSecurityStamp,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(vaultUser.id, user.id),
        eq(vaultUser.passwordHash, user.passwordHash)
      )
    )
    .returning({ id: vaultUser.id })
    .get()
  if (!updated) return false
  await clearRememberedVaultDevices(env, user.id)
  const bearer = /^Bearer ([-_A-Za-z0-9.]+)$/i.exec(
    request.headers.get("Authorization") ?? ""
  )?.[1]
  if (bearer) {
    const hash = await tokenHash(bearer)
    const current = await db
      .select({ id: vaultSession.id })
      .from(vaultSession)
      .where(
        and(
          eq(vaultSession.userId, user.id),
          or(
            eq(vaultSession.accessHash, hash),
            eq(vaultSession.previousAccessHash, hash)
          )
        )
      )
      .get()
    if (current)
      await db.batch([
        db
          .update(vaultSession)
          .set({ securityStamp: nextSecurityStamp })
          .where(eq(vaultSession.id, current.id)),
        db
          .delete(vaultSession)
          .where(
            and(
              eq(vaultSession.userId, user.id),
              ne(vaultSession.id, current.id)
            )
          ),
      ])
    else
      await db
        .delete(vaultSession)
        .where(eq(vaultSession.userId, user.id))
        .run()
  }
  return true
}

export async function resetVaultSecurityStamp(
  env: CloudflareEnv,
  userId: string
) {
  const db = drizzle(env.DB)
  await db.batch([
    db
      .update(vaultUser)
      .set({ securityStamp: crypto.randomUUID(), updatedAt: new Date() })
      .where(and(eq(vaultUser.id, userId), isNull(vaultUser.deletingAt))),
    db.delete(vaultSession).where(eq(vaultSession.userId, userId)),
  ])
  await clearRememberedVaultDevices(env, userId)
}

export async function updateVaultProfile(
  env: CloudflareEnv,
  userId: string,
  name: string
) {
  return drizzle(env.DB)
    .update(vaultUser)
    .set({ name, updatedAt: new Date() })
    .where(eq(vaultUser.id, userId))
    .returning()
    .get()
}

export async function updateVaultKeys(
  env: CloudflareEnv,
  userId: string,
  privateKey: string,
  publicKey: string
) {
  return drizzle(env.DB)
    .update(vaultUser)
    .set({ privateKey, publicKey, updatedAt: new Date() })
    .where(eq(vaultUser.id, userId))
    .returning()
    .get()
}

export async function issueVaultSession(
  env: CloudflareEnv,
  user: VaultUser,
  deviceId: string,
  clientId: string,
  deviceType: string,
  options: {
    sso?: { issuer: string; refreshToken: string }
    apiKey?: boolean
    apiKeyHash?: string | null
    deviceName?: string
  } = {}
) {
  const apiKey = options.apiKey ?? false
  const access = await accessToken(
    env,
    user,
    deviceId,
    clientId,
    deviceType,
    apiKey
  )
  const refresh = randomToken()
  const now = Date.now()
  await drizzle(env.DB)
    .insert(vaultSession)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      deviceId,
      deviceType,
      deviceName: options.deviceName?.slice(0, 200) || "Unknown device",
      createdAt: new Date(now),
      clientId,
      securityStamp: user.securityStamp,
      apiKey,
      apiKeyHash: options.apiKeyHash ?? null,
      accessHash: await tokenHash(access),
      refreshHash: await tokenHash(refresh),
      ssoIssuer: options.sso?.issuer ?? null,
      ssoRefreshToken: options.sso
        ? await sealVaultOidcRefresh(
            env.BETTER_AUTH_SECRET ?? "",
            options.sso.refreshToken
          )
        : null,
      accessExpiresAt: new Date(now + ACCESS_LIFETIME_MS),
      refreshExpiresAt: new Date(now + REFRESH_LIFETIME_MS),
    })
    .run()
  await drizzle(env.DB)
    .insert(vaultDevice)
    .values({
      id: `${user.id}:${deviceId}`,
      userId: user.id,
      deviceId,
      deviceType: Number(deviceType) || 0,
      deviceName: options.deviceName?.slice(0, 200) || "Unknown device",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .onConflictDoUpdate({
      target: vaultDevice.id,
      set: {
        deviceType: Number(deviceType) || 0,
        deviceName: options.deviceName?.slice(0, 200) || "Unknown device",
        updatedAt: new Date(now),
      },
    })
    .run()
  return { access, refresh, expiresIn: ACCESS_LIFETIME_MS / 1000 }
}

export async function refreshVaultSession(
  env: CloudflareEnv,
  refresh: string,
  fetcher: typeof fetch = fetch
) {
  const db = drizzle(env.DB)
  const oldHash = await tokenHash(refresh)
  const session = await db
    .select()
    .from(vaultSession)
    .where(eq(vaultSession.refreshHash, oldHash))
    .get()
  if (
    !session ||
    session.apiKey ||
    session.refreshExpiresAt.getTime() <= Date.now()
  )
    return null
  const user = await db
    .select()
    .from(vaultUser)
    .where(and(eq(vaultUser.id, session.userId), isNull(vaultUser.deletingAt)))
    .get()
  if (!user) return null
  if (session.securityStamp !== user.securityStamp) return null
  let nextSsoRefresh = session.ssoRefreshToken
  if (session.ssoIssuer) {
    const config = env as CloudflareEnv & {
      SSO_AUTHORITY?: string
      SSO_CLIENT_ID?: string
      SSO_CLIENT_SECRET?: string
    }
    if (
      !session.ssoRefreshToken ||
      !config.SSO_CLIENT_ID ||
      !config.SSO_CLIENT_SECRET ||
      config.SSO_AUTHORITY !== session.ssoIssuer
    )
      return null
    try {
      const provider = await discoverVaultOidc(config.SSO_AUTHORITY, fetcher)
      const refreshed = await refreshVaultOidc(
        provider,
        {
          clientId: config.SSO_CLIENT_ID,
          clientSecret: config.SSO_CLIENT_SECRET,
          refreshToken: await openVaultOidcRefresh(
            env.BETTER_AUTH_SECRET ?? "",
            session.ssoRefreshToken
          ),
        },
        fetcher
      )
      nextSsoRefresh = await sealVaultOidcRefresh(
        env.BETTER_AUTH_SECRET ?? "",
        refreshed
      )
    } catch {
      return null
    }
  }
  const access = await accessToken(
    env,
    user,
    session.deviceId,
    session.clientId,
    session.deviceType
  )
  const nextRefresh = randomToken()
  const now = Date.now()
  const updated = await db
    .update(vaultSession)
    .set({
      previousAccessHash:
        session.accessExpiresAt.getTime() > now ? session.accessHash : null,
      previousAccessExpiresAt:
        session.accessExpiresAt.getTime() > now
          ? new Date(
              Math.min(
                session.accessExpiresAt.getTime(),
                now + ACCESS_REFRESH_OVERLAP_MS
              )
            )
          : null,
      accessHash: await tokenHash(access),
      refreshHash: await tokenHash(nextRefresh),
      ssoRefreshToken: nextSsoRefresh,
      accessExpiresAt: new Date(now + ACCESS_LIFETIME_MS),
      refreshExpiresAt: new Date(now + REFRESH_LIFETIME_MS),
    })
    .where(eq(vaultSession.refreshHash, oldHash))
    .returning()
    .get()
  return updated
    ? { access, refresh: nextRefresh, expiresIn: ACCESS_LIFETIME_MS / 1000 }
    : null
}

export async function authenticatedVaultUser(
  env: CloudflareEnv,
  request: Request
) {
  const match = /^Bearer ([-_A-Za-z0-9.]+)$/i.exec(
    request.headers.get("Authorization") ?? ""
  )
  if (!match) return null
  const db = drizzle(env.DB)
  const hash = await tokenHash(match[1]!)
  const now = new Date()
  const session = await db
    .select()
    .from(vaultSession)
    .where(
      or(
        and(
          eq(vaultSession.accessHash, hash),
          gt(vaultSession.accessExpiresAt, now)
        ),
        and(
          eq(vaultSession.previousAccessHash, hash),
          gt(vaultSession.previousAccessExpiresAt, now)
        )
      )
    )
    .get()
  if (!session) return null
  if (session.apiKey) {
    if (!session.apiKeyHash) return null
    const current = await db
      .select({ secretHash: vaultApiKey.secretHash })
      .from(vaultApiKey)
      .where(eq(vaultApiKey.userId, session.userId))
      .get()
    if (current?.secretHash !== session.apiKeyHash) return null
  }
  const user = await db
    .select()
    .from(vaultUser)
    .where(and(eq(vaultUser.id, session.userId), isNull(vaultUser.deletingAt)))
    .get()
  return user && session.securityStamp === user.securityStamp ? user : null
}

export async function listVaultDevices(env: CloudflareEnv, userId: string) {
  return drizzle(env.DB)
    .select()
    .from(vaultDevice)
    .where(eq(vaultDevice.userId, userId))
    .orderBy(vaultDevice.createdAt)
    .limit(1000)
    .all()
}

export async function verifyRememberedVaultDevice(
  env: CloudflareEnv,
  userId: string,
  deviceId: string,
  token: string
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false
  const db = drizzle(env.DB)
  const device = await db
    .select({
      hash: vaultDevice.twoFactorRememberHash,
      expiresAt: vaultDevice.twoFactorRememberExpiresAt,
    })
    .from(vaultDevice)
    .where(
      and(eq(vaultDevice.userId, userId), eq(vaultDevice.deviceId, deviceId))
    )
    .get()
  if (!device?.hash || !device.expiresAt || device.expiresAt <= new Date())
    return false
  return constantTimeEqual(device.hash, await tokenHash(token))
}

export async function rememberVaultDevice(
  env: CloudflareEnv,
  userId: string,
  deviceId: string
) {
  const token = randomToken()
  const updated = await drizzle(env.DB)
    .update(vaultDevice)
    .set({
      twoFactorRememberHash: await tokenHash(token),
      twoFactorRememberExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    })
    .where(
      and(eq(vaultDevice.userId, userId), eq(vaultDevice.deviceId, deviceId))
    )
    .returning({ id: vaultDevice.id })
    .get()
  if (!updated) throw new Error("Device was not registered")
  return token
}

export async function clearRememberedVaultDevices(
  env: CloudflareEnv,
  userId: string
) {
  await drizzle(env.DB)
    .update(vaultDevice)
    .set({ twoFactorRememberHash: null, twoFactorRememberExpiresAt: null })
    .where(eq(vaultDevice.userId, userId))
    .run()
}

export async function knownVaultDevice(
  env: CloudflareEnv,
  userId: string,
  deviceId: string
) {
  return !!(await drizzle(env.DB)
    .select({ id: vaultDevice.id })
    .from(vaultDevice)
    .where(
      and(eq(vaultDevice.userId, userId), eq(vaultDevice.deviceId, deviceId))
    )
    .get())
}

export async function knownVaultDeviceType(
  env: CloudflareEnv,
  userId: string,
  deviceId: string,
  deviceType: number
) {
  return !!(await drizzle(env.DB)
    .select({ id: vaultDevice.id })
    .from(vaultDevice)
    .where(
      and(
        eq(vaultDevice.userId, userId),
        eq(vaultDevice.deviceId, deviceId),
        eq(vaultDevice.deviceType, deviceType)
      )
    )
    .get())
}

export async function currentVaultDeviceId(
  env: CloudflareEnv,
  request: Request,
  user: VaultUser
) {
  const bearer = /^Bearer ([-_A-Za-z0-9.]+)$/i.exec(
    request.headers.get("Authorization") ?? ""
  )?.[1]
  if (!bearer) return null
  const hash = await tokenHash(bearer)
  const now = new Date()
  const session = await drizzle(env.DB)
    .select({ deviceId: vaultSession.deviceId })
    .from(vaultSession)
    .where(
      and(
        eq(vaultSession.userId, user.id),
        eq(vaultSession.securityStamp, user.securityStamp),
        or(
          and(
            eq(vaultSession.accessHash, hash),
            gt(vaultSession.accessExpiresAt, now)
          ),
          and(
            eq(vaultSession.previousAccessHash, hash),
            gt(vaultSession.previousAccessExpiresAt, now)
          )
        )
      )
    )
    .get()
  return session?.deviceId ?? null
}
