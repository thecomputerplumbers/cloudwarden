import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import { vaultApiKey, vaultSession, vaultUser } from "../db/schema/vault"
import { tokenHash } from "./bitwarden-auth"

const encoder = new TextEncoder()
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function decodeBase64Url(value: string) {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0)
  )
}

function randomSecret() {
  const result: string[] = []
  while (result.length < 30) {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    for (const byte of bytes) {
      if (byte < 248) result.push(alphabet[byte % alphabet.length]!)
      if (result.length === 30) break
    }
  }
  return result.join("")
}

async function encryptionKey(secret: string) {
  if (secret.length < 32)
    throw new Error("API key encryption secret is not configured")
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`cloudwarden-personal-api-key:${secret}`)
  )
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ])
}

async function seal(secret: string, value: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await encryptionKey(secret),
    encoder.encode(value)
  )
  return `${base64Url(nonce)}.${base64Url(new Uint8Array(encrypted))}`
}

async function open(secret: string, value: string) {
  const [nonce, encrypted] = value.split(".")
  if (!nonce || !encrypted) throw new Error("Invalid stored API key")
  const bytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64Url(nonce) },
    await encryptionKey(secret),
    decodeBase64Url(encrypted)
  )
  return new TextDecoder().decode(bytes)
}

export async function personalApiKey(
  env: CloudflareEnv,
  userId: string,
  rotate: boolean
) {
  const db = drizzle(env.DB)
  const existing = await db
    .select()
    .from(vaultApiKey)
    .where(eq(vaultApiKey.userId, userId))
    .get()
  if (existing && !rotate)
    return open(env.BETTER_AUTH_SECRET ?? "", existing.sealedSecret)

  const value = randomSecret()
  const secretHash = await tokenHash(value)
  const sealedSecret = await seal(env.BETTER_AUTH_SECRET ?? "", value)
  const now = new Date()
  if (rotate) {
    await db.batch([
      db
        .insert(vaultApiKey)
        .values({ userId, secretHash, sealedSecret, updatedAt: now })
        .onConflictDoUpdate({
          target: vaultApiKey.userId,
          set: { secretHash, sealedSecret, updatedAt: now },
        }),
      db
        .delete(vaultSession)
        .where(
          and(eq(vaultSession.userId, userId), eq(vaultSession.apiKey, true))
        ),
    ])
    return value
  }
  await db
    .insert(vaultApiKey)
    .values({ userId, secretHash, sealedSecret, updatedAt: now })
    .onConflictDoNothing()
    .run()
  const stored = await db
    .select()
    .from(vaultApiKey)
    .where(eq(vaultApiKey.userId, userId))
    .get()
  if (!stored) throw new Error("Could not create API key")
  return open(env.BETTER_AUTH_SECRET ?? "", stored.sealedSecret)
}

export async function userForPersonalApiKey(
  env: CloudflareEnv,
  userId: string,
  supplied: string
) {
  const db = drizzle(env.DB)
  const stored = await db
    .select({ user: vaultUser })
    .from(vaultApiKey)
    .innerJoin(vaultUser, eq(vaultUser.id, vaultApiKey.userId))
    .where(
      and(
        eq(vaultApiKey.userId, userId),
        eq(vaultApiKey.secretHash, await tokenHash(supplied))
      )
    )
    .get()
  return stored?.user && !stored.user.deletingAt ? stored.user : null
}
