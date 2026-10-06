import { and, eq, gt, lt, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import { vaultProtectedOtp } from "../db/schema/vault"

const CODE_LIFETIME_MS = 10 * 60_000
const RESEND_DELAY_MS = 30_000
const MAX_ATTEMPTS = 5
const encoder = new TextEncoder()

function newCode() {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000
  for (;;) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0]!
    if (value < limit) return String(value % 1_000_000).padStart(6, "0")
  }
}

async function codeHash(env: CloudflareEnv, userId: string, code: string) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new Error("Protected-action signing secret is not configured")
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
      encoder.encode(`cloudwarden-protected-action:${userId}:${code}`)
    )
  )
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

export async function requestProtectedOtp(
  env: CloudflareEnv,
  user: { id: string; email: string; emailVerified: boolean }
) {
  if (!user.emailVerified || !env.EMAIL_FROM || /[\r\n]/.test(env.EMAIL_FROM))
    return "unavailable" as const
  const now = new Date()
  const code = newCode()
  const hash = await codeHash(env, user.id, code)
  const db = drizzle(env.DB)
  const stored = await db
    .insert(vaultProtectedOtp)
    .values({
      userId: user.id,
      codeHash: hash,
      sentAt: now,
      expiresAt: new Date(now.getTime() + CODE_LIFETIME_MS),
      attempts: 0,
    })
    .onConflictDoUpdate({
      target: vaultProtectedOtp.userId,
      set: {
        codeHash: hash,
        sentAt: now,
        expiresAt: new Date(now.getTime() + CODE_LIFETIME_MS),
        attempts: 0,
      },
      setWhere: lt(
        vaultProtectedOtp.sentAt,
        new Date(now.getTime() - RESEND_DELAY_MS)
      ),
    })
    .returning({ userId: vaultProtectedOtp.userId })
    .get()
  if (!stored) return "rate_limited" as const
  try {
    await env.EMAIL.send({
      from: env.EMAIL_FROM,
      to: user.email,
      subject: "Cloudwarden security code",
      text: `Your Cloudwarden security code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
      html: `<p>Your Cloudwarden security code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>`,
    })
  } catch {
    await db
      .delete(vaultProtectedOtp)
      .where(
        and(
          eq(vaultProtectedOtp.userId, user.id),
          eq(vaultProtectedOtp.codeHash, hash),
          eq(vaultProtectedOtp.sentAt, now)
        )
      )
      .run()
    return "delivery_failed" as const
  }
  return "sent" as const
}

export async function consumeProtectedOtp(
  env: CloudflareEnv,
  userId: string,
  code: string
) {
  if (!/^\d{6}$/.test(code)) return false
  const db = drizzle(env.DB)
  const attempted = await db
    .update(vaultProtectedOtp)
    .set({ attempts: sql`${vaultProtectedOtp.attempts} + 1` })
    .where(
      and(
        eq(vaultProtectedOtp.userId, userId),
        gt(vaultProtectedOtp.expiresAt, new Date()),
        lt(vaultProtectedOtp.attempts, MAX_ATTEMPTS)
      )
    )
    .returning({ codeHash: vaultProtectedOtp.codeHash })
    .get()
  if (!attempted || attempted.codeHash !== (await codeHash(env, userId, code)))
    return false
  return !!(await db
    .delete(vaultProtectedOtp)
    .where(
      and(
        eq(vaultProtectedOtp.userId, userId),
        eq(vaultProtectedOtp.codeHash, attempted.codeHash)
      )
    )
    .returning({ userId: vaultProtectedOtp.userId })
    .get())
}

export async function pruneProtectedOtps(env: CloudflareEnv) {
  await drizzle(env.DB)
    .delete(vaultProtectedOtp)
    .where(lt(vaultProtectedOtp.expiresAt, new Date()))
    .run()
}
