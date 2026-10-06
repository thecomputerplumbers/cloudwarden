import { drizzle } from "drizzle-orm/d1"
import { eq } from "drizzle-orm"

import { vaultSession, vaultUser } from "../db/schema/vault"

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
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
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

export async function findVaultUser(env: CloudflareEnv, email: string) {
  return (
    (await drizzle(env.DB)
      .select()
      .from(vaultUser)
      .where(eq(vaultUser.email, normalizeEmail(email)))
      .get()) ?? null
  )
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

export async function issueVaultSession(
  env: CloudflareEnv,
  user: VaultUser,
  deviceId: string
) {
  const access = randomToken()
  const refresh = randomToken()
  const now = Date.now()
  await drizzle(env.DB)
    .insert(vaultSession)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      deviceId,
      accessHash: await tokenHash(access),
      refreshHash: await tokenHash(refresh),
      accessExpiresAt: new Date(now + ACCESS_LIFETIME_MS),
      refreshExpiresAt: new Date(now + REFRESH_LIFETIME_MS),
    })
    .run()
  return { access, refresh, expiresIn: ACCESS_LIFETIME_MS / 1000 }
}

export async function refreshVaultSession(env: CloudflareEnv, refresh: string) {
  const db = drizzle(env.DB)
  const oldHash = await tokenHash(refresh)
  const session = await db
    .select()
    .from(vaultSession)
    .where(eq(vaultSession.refreshHash, oldHash))
    .get()
  if (!session || session.refreshExpiresAt.getTime() <= Date.now()) return null
  const access = randomToken()
  const nextRefresh = randomToken()
  const now = Date.now()
  const updated = await db
    .update(vaultSession)
    .set({
      accessHash: await tokenHash(access),
      refreshHash: await tokenHash(nextRefresh),
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
  const match = /^Bearer ([-_A-Za-z0-9]+)$/i.exec(
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
      .where(eq(vaultUser.id, session.userId))
      .get()) ?? null
  )
}
