import { drizzle } from "drizzle-orm/d1"
import { and, eq, lt, ne } from "drizzle-orm"

import { vaultSession, vaultTotp } from "../db/schema/vault"
import { tokenHash } from "./bitwarden-auth"

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function newTotpSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  let value = 0
  let bits = 0
  let secret = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      secret += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return secret
}

function decodeSecret(secret: string) {
  if (!/^[A-Z2-7]{32}$/.test(secret)) return null
  let value = 0
  let bits = 0
  const bytes: number[] = []
  for (const letter of secret) {
    value = (value << 5) | ALPHABET.indexOf(letter)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(bytes)
}

export async function totpAtStep(secret: string, step: number) {
  const bytes = decodeSecret(secret)
  if (!bytes || !Number.isSafeInteger(step) || step < 0) return null
  const counter = new ArrayBuffer(8)
  const view = new DataView(counter)
  view.setUint32(0, Math.floor(step / 2 ** 32))
  view.setUint32(4, step >>> 0)
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  )
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter))
  const offset = digest[digest.length - 1]! & 15
  const value =
    ((digest[offset]! & 127) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!
  return String(value % 1_000_000).padStart(6, "0")
}

export async function matchingTotpStep(
  secret: string,
  code: string,
  lastUsedStep: number,
  now = Date.now()
) {
  if (!/^\d{6}$/.test(code)) return null
  const current = Math.floor(now / 30_000)
  for (const step of [current - 1, current, current + 1]) {
    if (step <= lastUsedStep) continue
    if ((await totpAtStep(secret, step)) === code) return step
  }
  return null
}

export async function getTotp(env: CloudflareEnv, userId: string) {
  return (
    (await drizzle(env.DB)
      .select()
      .from(vaultTotp)
      .where(eq(vaultTotp.userId, userId))
      .get()) ?? null
  )
}

export async function enableTotp(
  env: CloudflareEnv,
  userId: string,
  secret: string,
  step: number,
  request: Request
) {
  const bytes = decodeSecret(secret)
  if (!bytes) return false
  const recoveryCode = newTotpSecret()
  const db = drizzle(env.DB)
  await db
    .insert(vaultTotp)
    .values({
      userId,
      secret,
      lastUsedStep: step,
      recoveryCode,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: vaultTotp.userId,
      set: { secret, lastUsedStep: step, recoveryCode, createdAt: new Date() },
    })
    .run()
  await revokeOtherSessions(env, userId, request)
  return true
}

export async function verifyTotpLogin(
  env: CloudflareEnv,
  factor: NonNullable<Awaited<ReturnType<typeof getTotp>>>,
  code: string
) {
  const step = await matchingTotpStep(factor.secret, code, factor.lastUsedStep)
  if (step === null) return false
  const updated = await drizzle(env.DB)
    .update(vaultTotp)
    .set({ lastUsedStep: step })
    .where(
      and(eq(vaultTotp.userId, factor.userId), lt(vaultTotp.lastUsedStep, step))
    )
    .returning({ userId: vaultTotp.userId })
    .get()
  return !!updated
}

export async function redeemTotpRecoveryCode(
  env: CloudflareEnv,
  userId: string,
  code: string
) {
  if (!/^[A-Z2-7]{32}$/.test(code)) return false
  const removed = await drizzle(env.DB)
    .delete(vaultTotp)
    .where(and(eq(vaultTotp.userId, userId), eq(vaultTotp.recoveryCode, code)))
    .returning({ userId: vaultTotp.userId })
    .get()
  if (!removed) return false
  await drizzle(env.DB)
    .delete(vaultSession)
    .where(eq(vaultSession.userId, userId))
    .run()
  return true
}

export async function disableTotp(
  env: CloudflareEnv,
  userId: string,
  request: Request
) {
  await drizzle(env.DB)
    .delete(vaultTotp)
    .where(eq(vaultTotp.userId, userId))
    .run()
  await revokeOtherSessions(env, userId, request)
}

async function revokeOtherSessions(
  env: CloudflareEnv,
  userId: string,
  request: Request
) {
  const token = /^Bearer ([-_A-Za-z0-9.]+)$/i.exec(
    request.headers.get("Authorization") ?? ""
  )?.[1]
  if (!token) return
  await drizzle(env.DB)
    .delete(vaultSession)
    .where(
      and(
        eq(vaultSession.userId, userId),
        ne(vaultSession.accessHash, await tokenHash(token))
      )
    )
    .run()
}
