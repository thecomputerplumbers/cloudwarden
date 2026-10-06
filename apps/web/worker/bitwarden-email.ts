import { and, eq, gt, isNotNull, lt, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import {
  vaultEmailTwoFactor,
  vaultSession,
  vaultTotp,
  vaultWebauthnCredential,
  vaultWebauthnFactor,
} from "../db/schema/vault"
import { newTotpSecret, revokeOtherSessions } from "./bitwarden-totp"

const CODE_LIFETIME_MS = 10 * 60_000

type EmailEnv = CloudflareEnv & { EMAIL_2FA_ENABLED?: string }

export function emailTwoFactorAvailable(env: CloudflareEnv) {
  return (
    (env as EmailEnv).EMAIL_2FA_ENABLED === "true" &&
    !!env.EMAIL_FROM &&
    !/[\r\n]/.test(env.EMAIL_FROM)
  )
}

async function codeHash(
  env: CloudflareEnv,
  userId: string,
  purpose: "enroll" | "login",
  code: string
) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new Error("Token signing secret is not configured")
  const encoder = new TextEncoder()
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
      encoder.encode(`${purpose}:${userId}:${code}`)
    )
  )
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

function newCode() {
  return String(
    crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000
  ).padStart(6, "0")
}

async function mailCode(env: CloudflareEnv, to: string, code: string) {
  if (!emailTwoFactorAvailable(env)) throw new Error("Email 2FA is disabled")
  await env.EMAIL.send({
    from: env.EMAIL_FROM!,
    to,
    subject: "Cloudwarden verification code",
    text: `Your Cloudwarden verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
    html: `<p>Your Cloudwarden verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>`,
  })
}

export async function getEmailTwoFactor(env: CloudflareEnv, userId: string) {
  return (
    (await drizzle(env.DB)
      .select()
      .from(vaultEmailTwoFactor)
      .where(eq(vaultEmailTwoFactor.userId, userId))
      .get()) ?? null
  )
}

export async function sendEmailEnrollment(
  env: CloudflareEnv,
  userId: string,
  email: string
) {
  if (
    !emailTwoFactorAvailable(env) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254
  )
    return false
  const code = newCode()
  const now = new Date()
  await drizzle(env.DB)
    .insert(vaultEmailTwoFactor)
    .values({
      userId,
      email: null,
      pendingEmail: email,
      pendingCodeHash: await codeHash(env, userId, "enroll", code),
      pendingCodeExpiresAt: new Date(now.getTime() + CODE_LIFETIME_MS),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: vaultEmailTwoFactor.userId,
      set: {
        pendingEmail: email,
        pendingCodeHash: await codeHash(env, userId, "enroll", code),
        pendingCodeExpiresAt: new Date(now.getTime() + CODE_LIFETIME_MS),
        updatedAt: now,
      },
    })
    .run()
  await mailCode(env, email, code)
  return true
}

export async function confirmEmailEnrollment(
  env: CloudflareEnv,
  userId: string,
  email: string,
  code: string,
  request: Request
) {
  if (!/^\d{6}$/.test(code)) return false
  const db = drizzle(env.DB)
  const updated = await db
    .update(vaultEmailTwoFactor)
    .set({
      email,
      pendingEmail: null,
      pendingCodeHash: null,
      pendingCodeExpiresAt: null,
      loginCodeHash: null,
      loginCodeExpiresAt: null,
      loginAttempts: 0,
      recoveryCode: newTotpSecret(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(vaultEmailTwoFactor.userId, userId),
        eq(vaultEmailTwoFactor.pendingEmail, email),
        eq(
          vaultEmailTwoFactor.pendingCodeHash,
          await codeHash(env, userId, "enroll", code)
        ),
        gt(vaultEmailTwoFactor.pendingCodeExpiresAt, new Date())
      )
    )
    .returning({ userId: vaultEmailTwoFactor.userId })
    .get()
  if (!updated) return false
  await revokeOtherSessions(env, userId, request)
  return true
}

export async function sendEmailLogin(env: CloudflareEnv, userId: string) {
  if (!emailTwoFactorAvailable(env)) return false
  const factor = await getEmailTwoFactor(env, userId)
  if (!factor?.email) return false
  const code = newCode()
  const now = new Date()
  await drizzle(env.DB)
    .update(vaultEmailTwoFactor)
    .set({
      loginCodeHash: await codeHash(env, userId, "login", code),
      loginCodeExpiresAt: new Date(now.getTime() + CODE_LIFETIME_MS),
      loginAttempts: 0,
      updatedAt: now,
    })
    .where(eq(vaultEmailTwoFactor.userId, userId))
    .run()
  await mailCode(env, factor.email, code)
  return true
}

export async function verifyEmailLogin(
  env: CloudflareEnv,
  userId: string,
  code: string
) {
  if (!/^\d{6}$/.test(code)) return false
  const db = drizzle(env.DB)
  const updated = await db
    .update(vaultEmailTwoFactor)
    .set({ loginCodeHash: null, loginCodeExpiresAt: null, loginAttempts: 0 })
    .where(
      and(
        eq(vaultEmailTwoFactor.userId, userId),
        isNotNull(vaultEmailTwoFactor.email),
        eq(
          vaultEmailTwoFactor.loginCodeHash,
          await codeHash(env, userId, "login", code)
        ),
        gt(vaultEmailTwoFactor.loginCodeExpiresAt, new Date()),
        lt(vaultEmailTwoFactor.loginAttempts, 5)
      )
    )
    .returning({ userId: vaultEmailTwoFactor.userId })
    .get()
  if (updated) return true
  await db
    .update(vaultEmailTwoFactor)
    .set({ loginAttempts: sql`${vaultEmailTwoFactor.loginAttempts} + 1` })
    .where(
      and(
        eq(vaultEmailTwoFactor.userId, userId),
        isNotNull(vaultEmailTwoFactor.loginCodeHash),
        lt(vaultEmailTwoFactor.loginAttempts, 5)
      )
    )
    .run()
  return false
}

export async function redeemEmailRecoveryCode(
  env: CloudflareEnv,
  userId: string,
  code: string
) {
  if (!/^[A-Z2-7]{32}$/.test(code)) return false
  const db = drizzle(env.DB)
  const removed = await db
    .delete(vaultEmailTwoFactor)
    .where(
      and(
        eq(vaultEmailTwoFactor.userId, userId),
        eq(vaultEmailTwoFactor.recoveryCode, code)
      )
    )
    .returning({ userId: vaultEmailTwoFactor.userId })
    .get()
  if (!removed) return false
  await db.delete(vaultTotp).where(eq(vaultTotp.userId, userId)).run()
  await db
    .delete(vaultWebauthnCredential)
    .where(eq(vaultWebauthnCredential.userId, userId))
    .run()
  await db
    .delete(vaultWebauthnFactor)
    .where(eq(vaultWebauthnFactor.userId, userId))
    .run()
  await db.delete(vaultSession).where(eq(vaultSession.userId, userId)).run()
  return true
}

export async function disableEmailTwoFactor(
  env: CloudflareEnv,
  userId: string,
  request: Request
) {
  await drizzle(env.DB)
    .delete(vaultEmailTwoFactor)
    .where(eq(vaultEmailTwoFactor.userId, userId))
    .run()
  await revokeOtherSessions(env, userId, request)
}
