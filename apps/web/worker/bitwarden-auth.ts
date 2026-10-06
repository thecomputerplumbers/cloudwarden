import { drizzle } from "drizzle-orm/d1"
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm"

import { vaultMembership, vaultSession, vaultUser } from "../db/schema/vault"
import {
  discoverVaultOidc,
  openVaultOidcRefresh,
  refreshVaultOidc,
  sealVaultOidcRefresh,
} from "./bitwarden-oidc"

export type VaultUser = typeof vaultUser.$inferSelect

const ACCESS_LIFETIME_MS = 60 * 60 * 1000
const REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
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
  deviceType: string
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
        scope: ["api", "offline_access"],
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
    key: string
    privateKey?: string
    publicKey?: string
    kdf: number
    kdfIterations: number
    kdfMemory?: number
    kdfParallelism?: number
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
    key: input.key,
    privateKey: input.privateKey ?? null,
    publicKey: input.publicKey ?? null,
    kdf: input.kdf,
    kdfIterations: input.kdfIterations,
    kdfMemory: input.kdfMemory ?? null,
    kdfParallelism: input.kdfParallelism ?? null,
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
    key: string
    privateKey: string
    publicKey: string
    kdfIterations: number
    name?: string
    emailVerified?: boolean
  }
) {
  const salt = randomToken()
  return drizzle(env.DB)
    .update(vaultUser)
    .set({
      passwordHash: await hashClientPassword(input.masterPasswordHash, salt),
      passwordSalt: salt,
      key: input.key,
      privateKey: input.privateKey,
      publicKey: input.publicKey,
      kdfIterations: input.kdfIterations,
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
  await drizzle(env.DB)
    .delete(vaultUser)
    .where(and(eq(vaultUser.id, id), isNotNull(vaultUser.deletingAt)))
    .run()
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
  kdf: { type: number; iterations: number } | null
) {
  const db = drizzle(env.DB)
  const salt = randomToken()
  const updated = await db
    .update(vaultUser)
    .set({
      passwordSalt: salt,
      passwordHash: await hashClientPassword(newPassword, salt),
      key: newKey,
      kdf: kdf?.type ?? user.kdf,
      kdfIterations: kdf?.iterations ?? user.kdfIterations,
      securityStamp: crypto.randomUUID(),
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
  const bearer = /^Bearer ([-_A-Za-z0-9.]+)$/i.exec(
    request.headers.get("Authorization") ?? ""
  )?.[1]
  if (bearer)
    await db
      .delete(vaultSession)
      .where(
        and(
          eq(vaultSession.userId, user.id),
          ne(vaultSession.accessHash, await tokenHash(bearer))
        )
      )
      .run()
  return true
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
  sso?: { issuer: string; refreshToken: string }
) {
  const access = await accessToken(env, user, deviceId, clientId, deviceType)
  const refresh = randomToken()
  const now = Date.now()
  await drizzle(env.DB)
    .insert(vaultSession)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      deviceId,
      deviceType,
      clientId,
      accessHash: await tokenHash(access),
      refreshHash: await tokenHash(refresh),
      ssoIssuer: sso?.issuer ?? null,
      ssoRefreshToken: sso
        ? await sealVaultOidcRefresh(
            env.BETTER_AUTH_SECRET ?? "",
            sso.refreshToken
          )
        : null,
      accessExpiresAt: new Date(now + ACCESS_LIFETIME_MS),
      refreshExpiresAt: new Date(now + REFRESH_LIFETIME_MS),
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
  if (!session || session.refreshExpiresAt.getTime() <= Date.now()) return null
  const user = await db
    .select()
    .from(vaultUser)
    .where(and(eq(vaultUser.id, session.userId), isNull(vaultUser.deletingAt)))
    .get()
  if (!user) return null
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
  const session = await db
    .select()
    .from(vaultSession)
    .where(eq(vaultSession.accessHash, await tokenHash(match[1]!)))
    .get()
  if (!session || session.accessExpiresAt.getTime() <= Date.now()) return null
  return (
    (await db
      .select()
      .from(vaultUser)
      .where(
        and(eq(vaultUser.id, session.userId), isNull(vaultUser.deletingAt))
      )
      .get()) ?? null
  )
}
