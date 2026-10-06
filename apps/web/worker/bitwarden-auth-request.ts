import { and, eq, gt, isNull, lt } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import { vaultAuthRequest } from "../db/schema/vault"

type AuthRequest = typeof vaultAuthRequest.$inferSelect
const encoder = new TextEncoder()
const lifetimeMs = 15 * 60_000
const loginLifetimeMs = 5 * 60_000

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function decodeBase64Url(value: string) {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0)
  )
}

async function codeHash(
  env: CloudflareEnv,
  userId: string,
  requestId: string,
  code: string
) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new Error("Auth request secret is not configured")
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`cloudwarden-auth-request:${userId}:${requestId}:${code}`)
    )
  )
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

async function encryptionKey(secret: string) {
  if (secret.length < 32)
    throw new Error("Auth request secret is not configured")
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`cloudwarden-auth-request-password:${secret}`)
  )
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ])
}

async function sealPassword(env: CloudflareEnv, password: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const bytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await encryptionKey(env.BETTER_AUTH_SECRET ?? ""),
    encoder.encode(password)
  )
  return `${base64Url(nonce)}.${base64Url(new Uint8Array(bytes))}`
}

async function openPassword(env: CloudflareEnv, sealed: string) {
  const [nonce, ciphertext] = sealed.split(".")
  if (!nonce || !ciphertext) throw new Error("Invalid auth request password")
  const bytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64Url(nonce) },
    await encryptionKey(env.BETTER_AUTH_SECRET ?? ""),
    decodeBase64Url(ciphertext)
  )
  return new TextDecoder().decode(bytes)
}

function deviceTypeName(value: number) {
  return (
    [
      "Android",
      "iOS",
      "Chrome Extension",
      "Firefox Extension",
      "Opera Extension",
      "Edge Extension",
      "Windows",
      "macOS",
      "Linux",
      "Chrome",
      "Firefox",
      "Opera",
      "Edge",
      "Internet Explorer",
      "Unknown Browser",
      "Android",
      "UWP",
      "Safari",
      "Vivaldi",
      "Vivaldi Extension",
      "Safari Extension",
      "SDK",
      "Server",
      "Windows CLI",
      "macOS CLI",
      "Linux CLI",
      "DuckDuckGo",
    ][value] ?? "Unknown Browser"
  )
}

export async function authRequestResponse(
  env: CloudflareEnv,
  row: AuthRequest,
  includePassword = false
) {
  return {
    id: row.id,
    publicKey: row.publicKey,
    requestDeviceType: deviceTypeName(row.deviceType),
    requestIpAddress: row.requestIp,
    key: row.encryptedKey,
    masterPasswordHash:
      includePassword && row.sealedMasterPasswordHash
        ? await openPassword(env, row.sealedMasterPasswordHash)
        : null,
    creationDate: row.createdAt.toISOString(),
    responseDate: row.responseAt?.toISOString() ?? null,
    requestApproved: row.approved,
    origin: new URL(env.APP_URL ?? "http://localhost").origin,
    object: "auth-request",
  }
}

export async function createAuthRequest(
  env: CloudflareEnv,
  input: {
    userId: string
    requestDeviceId: string
    deviceType: number
    requestIp: string
    accessCode: string
    publicKey: string
  }
) {
  const id = crypto.randomUUID()
  const createdAt = new Date()
  return drizzle(env.DB)
    .insert(vaultAuthRequest)
    .values({
      id,
      userId: input.userId,
      requestDeviceId: input.requestDeviceId,
      deviceType: input.deviceType,
      requestIp: input.requestIp,
      accessCodeHash: await codeHash(env, input.userId, id, input.accessCode),
      publicKey: input.publicKey,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + lifetimeMs),
    })
    .returning()
    .get()
}

export async function pendingAuthRequests(env: CloudflareEnv, userId: string) {
  return drizzle(env.DB)
    .select()
    .from(vaultAuthRequest)
    .where(
      and(
        eq(vaultAuthRequest.userId, userId),
        isNull(vaultAuthRequest.approved),
        gt(vaultAuthRequest.expiresAt, new Date())
      )
    )
    .orderBy(vaultAuthRequest.createdAt)
    .limit(100)
    .all()
}

export async function getAuthRequest(
  env: CloudflareEnv,
  userId: string,
  id: string
) {
  return drizzle(env.DB)
    .select()
    .from(vaultAuthRequest)
    .where(
      and(
        eq(vaultAuthRequest.id, id),
        eq(vaultAuthRequest.userId, userId),
        gt(vaultAuthRequest.expiresAt, new Date())
      )
    )
    .get()
}

export async function answerAuthRequest(
  env: CloudflareEnv,
  userId: string,
  id: string,
  input: {
    approved: boolean
    encryptedKey: string
    masterPasswordHash: string | null
  }
) {
  const db = drizzle(env.DB)
  if (!input.approved)
    return db
      .delete(vaultAuthRequest)
      .where(
        and(
          eq(vaultAuthRequest.id, id),
          eq(vaultAuthRequest.userId, userId),
          isNull(vaultAuthRequest.approved),
          gt(vaultAuthRequest.expiresAt, new Date())
        )
      )
      .returning()
      .get()
  const sealedMasterPasswordHash = input.masterPasswordHash
    ? await sealPassword(env, input.masterPasswordHash)
    : null
  return db
    .update(vaultAuthRequest)
    .set({
      approved: true,
      encryptedKey: input.encryptedKey,
      sealedMasterPasswordHash,
      responseAt: new Date(),
    })
    .where(
      and(
        eq(vaultAuthRequest.id, id),
        eq(vaultAuthRequest.userId, userId),
        isNull(vaultAuthRequest.approved),
        gt(vaultAuthRequest.expiresAt, new Date())
      )
    )
    .returning()
    .get()
}

export async function authRequestForCode(
  env: CloudflareEnv,
  id: string,
  code: string,
  requestIp: string,
  deviceType: number
) {
  const db = drizzle(env.DB)
  const row = await db
    .select()
    .from(vaultAuthRequest)
    .where(
      and(
        eq(vaultAuthRequest.id, id),
        eq(vaultAuthRequest.requestIp, requestIp),
        eq(vaultAuthRequest.deviceType, deviceType),
        gt(vaultAuthRequest.expiresAt, new Date())
      )
    )
    .get()
  return row &&
    row.accessCodeHash === (await codeHash(env, row.userId, id, code))
    ? row
    : null
}

export async function claimAuthRequestLogin(
  env: CloudflareEnv,
  row: AuthRequest,
  userId: string,
  deviceId: string
) {
  if (
    row.userId !== userId ||
    row.requestDeviceId !== deviceId ||
    !row.approved
  )
    return false
  return !!(await drizzle(env.DB)
    .update(vaultAuthRequest)
    .set({ authenticatedAt: new Date() })
    .where(
      and(
        eq(vaultAuthRequest.id, row.id),
        eq(vaultAuthRequest.userId, userId),
        eq(vaultAuthRequest.requestDeviceId, deviceId),
        eq(vaultAuthRequest.approved, true),
        isNull(vaultAuthRequest.authenticatedAt),
        gt(vaultAuthRequest.createdAt, new Date(Date.now() - loginLifetimeMs)),
        gt(vaultAuthRequest.expiresAt, new Date())
      )
    )
    .returning({ id: vaultAuthRequest.id })
    .get())
}

export async function pruneAuthRequests(env: CloudflareEnv) {
  await drizzle(env.DB)
    .delete(vaultAuthRequest)
    .where(lt(vaultAuthRequest.expiresAt, new Date()))
    .run()
}
