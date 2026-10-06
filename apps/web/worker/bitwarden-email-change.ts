import { and, eq, gt, isNull, lt, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import {
  vaultDirectoryIdentity,
  vaultEmailChange,
  vaultMembership,
  vaultSession,
  vaultSsoIdentity,
  vaultUser,
} from "../db/schema/vault"
import {
  clearRememberedVaultDevices,
  findVaultUser,
  hashClientPassword,
  type VaultUser,
} from "./bitwarden-auth"

const CODE_LIFETIME_MS = 10 * 60_000
const RESEND_DELAY_MS = 30_000
const MAX_ATTEMPTS = 5
const encoder = new TextEncoder()

async function externallyManagedEmail(env: CloudflareEnv, userId: string) {
  const db = drizzle(env.DB)
  const [sso, directory] = await Promise.all([
    db
      .select({ id: vaultSsoIdentity.id })
      .from(vaultSsoIdentity)
      .where(eq(vaultSsoIdentity.userId, userId))
      .get(),
    db
      .select({ id: vaultDirectoryIdentity.id })
      .from(vaultDirectoryIdentity)
      .innerJoin(
        vaultMembership,
        eq(vaultMembership.id, vaultDirectoryIdentity.membershipId)
      )
      .where(
        and(
          eq(vaultMembership.userId, userId),
          eq(vaultDirectoryIdentity.active, true)
        )
      )
      .get(),
  ])
  return !!(sso || directory)
}

function newCode() {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000
  for (;;) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0]!
    if (value < limit) return String(value % 1_000_000).padStart(6, "0")
  }
}

async function codeHash(
  env: CloudflareEnv,
  userId: string,
  email: string,
  code: string
) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new Error("Email-change signing secret is not configured")
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
      encoder.encode(`cloudwarden-email-change:${userId}:${email}:${code}`)
    )
  )
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

export async function requestVaultEmailChange(
  env: CloudflareEnv,
  user: VaultUser,
  newEmail: string
) {
  if (!env.EMAIL_FROM || /[\r\n]/.test(env.EMAIL_FROM))
    return "unavailable" as const
  if (await externallyManagedEmail(env, user.id)) return "managed" as const
  if (await findVaultUser(env, newEmail)) return "taken" as const
  const now = new Date()
  const code = newCode()
  const hash = await codeHash(env, user.id, newEmail, code)
  const db = drizzle(env.DB)
  const stored = await db
    .insert(vaultEmailChange)
    .values({
      userId: user.id,
      newEmail,
      codeHash: hash,
      sentAt: now,
      expiresAt: new Date(now.getTime() + CODE_LIFETIME_MS),
      attempts: 0,
    })
    .onConflictDoUpdate({
      target: vaultEmailChange.userId,
      set: {
        newEmail,
        codeHash: hash,
        sentAt: now,
        expiresAt: new Date(now.getTime() + CODE_LIFETIME_MS),
        attempts: 0,
      },
      setWhere: lt(
        vaultEmailChange.sentAt,
        new Date(now.getTime() - RESEND_DELAY_MS)
      ),
    })
    .returning({ userId: vaultEmailChange.userId })
    .get()
  if (!stored) return "rate_limited" as const
  try {
    await env.EMAIL.send({
      from: env.EMAIL_FROM,
      to: newEmail,
      subject: "Confirm your Cloudwarden email change",
      text: `Your Cloudwarden email change code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
      html: `<p>Your Cloudwarden email change code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>`,
    })
  } catch {
    await db
      .delete(vaultEmailChange)
      .where(
        and(
          eq(vaultEmailChange.userId, user.id),
          eq(vaultEmailChange.codeHash, hash)
        )
      )
      .run()
    return "delivery_failed" as const
  }
  return "sent" as const
}

export async function completeVaultEmailChange(
  env: CloudflareEnv,
  user: VaultUser,
  input: {
    newEmail: string
    code: string
    newPasswordHash: string
    key: string
  }
) {
  if (!/^\d{6}$/.test(input.code)) return "invalid" as const
  if (await externallyManagedEmail(env, user.id)) return "managed" as const
  const db = drizzle(env.DB)
  const now = new Date()
  const attempted = await db
    .update(vaultEmailChange)
    .set({ attempts: sql`${vaultEmailChange.attempts} + 1` })
    .where(
      and(
        eq(vaultEmailChange.userId, user.id),
        eq(vaultEmailChange.newEmail, input.newEmail),
        gt(vaultEmailChange.expiresAt, now),
        lt(vaultEmailChange.attempts, MAX_ATTEMPTS)
      )
    )
    .returning({ codeHash: vaultEmailChange.codeHash })
    .get()
  const hash = await codeHash(env, user.id, input.newEmail, input.code)
  if (!attempted || attempted.codeHash !== hash) return "invalid" as const
  if (await findVaultUser(env, input.newEmail)) return "taken" as const
  const salt = crypto.randomUUID()
  const nextSecurityStamp = crypto.randomUUID()
  let updated
  try {
    updated = await db
      .update(vaultUser)
      .set({
        email: input.newEmail,
        emailVerified: true,
        key: input.key,
        passwordSalt: salt,
        passwordHash: await hashClientPassword(input.newPasswordHash, salt),
        securityStamp: nextSecurityStamp,
        updatedAt: now,
      })
      .where(
        and(
          eq(vaultUser.id, user.id),
          eq(vaultUser.email, user.email),
          eq(vaultUser.passwordHash, user.passwordHash),
          isNull(vaultUser.deletingAt),
          sql`not exists (select 1 from ${vaultSsoIdentity} linked where linked.user_id = ${user.id})`,
          sql`not exists (select 1 from ${vaultDirectoryIdentity} directory join ${vaultMembership} membership on membership.id = directory.membership_id where membership.user_id = ${user.id} and directory.active = 1)`,
          sql`exists (select 1 from ${vaultEmailChange} pending where pending.user_id = ${user.id} and pending.new_email = ${input.newEmail} and pending.code_hash = ${hash} and pending.expires_at > ${now.getTime()})`
        )
      )
      .returning({ id: vaultUser.id })
      .get()
  } catch {
    return "conflict" as const
  }
  if (!updated) return "conflict" as const
  await db.batch([
    db.delete(vaultEmailChange).where(eq(vaultEmailChange.userId, user.id)),
    db.delete(vaultSession).where(eq(vaultSession.userId, user.id)),
  ])
  await clearRememberedVaultDevices(env, user.id)
  return "changed" as const
}

export async function pruneVaultEmailChanges(env: CloudflareEnv) {
  await drizzle(env.DB)
    .delete(vaultEmailChange)
    .where(lt(vaultEmailChange.expiresAt, new Date()))
    .run()
}
