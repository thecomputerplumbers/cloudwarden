import { createMailer } from "@workspace/email"
import { and, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import {
  vaultEmailTwoFactor,
  vaultMembership,
  vaultTotp,
  vaultUser,
  vaultWebauthnCredential,
  vaultWebauthnFactor,
} from "../db/schema/vault"
import { vaultEmergencyAccess } from "../db/schema/vault-emergency"
import {
  findVaultUser,
  findVaultUserById,
  normalizeEmail,
  settleVaultKeyRotation,
  updateVaultPassword,
  type VaultUser,
} from "./bitwarden-auth"
import { invitationMailEnabled, invitationOrigin } from "./bitwarden-invite"
import { publishVaultNotification } from "./bitwarden-notifications"
import type { AppDatabase } from "./database"

type Body = Record<string, unknown>
type Grant = typeof vaultEmergencyAccess.$inferSelect
type Vault = Awaited<ReturnType<CloudflareEnv["APP_DATABASE"]["getByName"]>>
type CipherRow = NonNullable<Awaited<ReturnType<AppDatabase["getVaultCipher"]>>>

// bitwarden.ts owns the cipher response shape and passes it in.
export type EmergencyCipherRenderer = (
  row: CipherRow,
  vault: Vault,
  env: CloudflareEnv,
  userId: string,
  origin: string
) => Promise<unknown>

const INVITED = 0
const ACCEPTED = 1
const CONFIRMED = 2
const RECOVERY_INITIATED = 3
const RECOVERY_APPROVED = 4
const VIEW = 0
const TAKEOVER = 1

const DAY_MS = 24 * 60 * 60_000
const INVITE_LIFETIME_MS = 7 * DAY_MS
const MAX_WAIT_DAYS = 365
const MAX_GRANTS = 50
const BASE = "/api/emergency-access"
const INVALID = "Emergency access not valid."
const encoder = new TextEncoder()

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

function failure(message: string, status = 400) {
  return json({ error: message, error_description: message }, status)
}

function ok() {
  return new Response(null, { status: 200 })
}

function field(body: Body, name: string) {
  const normalized = name.toLowerCase()
  const key = Object.keys(body).find(
    (candidate) => candidate.toLowerCase() === normalized
  )
  return key ? body[key] : undefined
}

function stringField(body: Body, name: string) {
  const value = field(body, name)
  return typeof value === "string" ? value : undefined
}

// Clients send the enum values as numbers or as numeric strings.
function integerField(body: Body, name: string) {
  const value = field(body, name)
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value === "string" && /^\d{1,6}$/.test(value)) return Number(value)
  return undefined
}

function objectField(body: Body, name: string) {
  const value = field(body, name)
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Body)
    : null
}

async function bodyOf(request: Request): Promise<Body | null> {
  const text = await request.text()
  if (text.length > 1_000_000) return null
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Body)
      : null
  } catch {
    return null
  }
}

function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function decode(value: string) {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0)
  )
}

async function signingKey(env: CloudflareEnv) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new Error("Invitation signing secret is not configured")
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  )
}

export async function issueEmergencyInviteToken(
  env: CloudflareEnv,
  input: { id: string; email: string }
) {
  const payload = encode(
    encoder.encode(
      JSON.stringify({
        purpose: "cloudwarden-emergency-invite",
        id: input.id,
        email: normalizeEmail(input.email),
        expiresAt: Date.now() + INVITE_LIFETIME_MS,
      })
    )
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(env),
    encoder.encode(payload)
  )
  return `${payload}.${encode(new Uint8Array(signature))}`
}

async function validEmergencyInvite(
  env: CloudflareEnv,
  token: string,
  input: { id: string; email: string }
) {
  const parts = token.split(".")
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  )
    return false
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(env),
      decode(parts[1]!),
      encoder.encode(parts[0]!)
    )
    if (!valid) return false
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(decode(parts[0]!))
    )
    if (!claims || typeof claims !== "object") return false
    const value = claims as Record<string, unknown>
    return (
      value.purpose === "cloudwarden-emergency-invite" &&
      value.id === input.id &&
      value.email === normalizeEmail(input.email) &&
      typeof value.expiresAt === "number" &&
      value.expiresAt > Date.now()
    )
  } catch {
    return false
  }
}

function displayName(user: { name: string; email: string }) {
  return (user.name.trim() || user.email)
    .replaceAll(/\p{Cc}+/gu, " ")
    .slice(0, 100)
}

function mailer(env: CloudflareEnv, origin: string) {
  const local = ["localhost", "127.0.0.1"].includes(new URL(origin).hostname)
  return createMailer(
    env.EMAIL,
    env.EMAIL_FROM ?? (local ? "cloudwarden@example.com" : "")
  )
}

async function sendEmergencyInvite(
  env: CloudflareEnv,
  grant: { id: string; email: string },
  grantor: VaultUser
) {
  const origin = invitationOrigin(env)
  const name = displayName(grantor)
  const params = new URLSearchParams({
    id: grant.id,
    name,
    email: grant.email,
    token: await issueEmergencyInviteToken(env, grant),
  })
  await mailer(
    env,
    origin
  )({
    to: grant.email,
    subject: `Emergency access invitation from ${name}`,
    message: `${name} has invited you to become an emergency contact.`,
    url: `${origin}/#/accept-emergency?${params}`,
    label: "Become emergency contact",
  })
}

// Status mail is a courtesy; a failed send never blocks the transition.
async function notify(
  env: CloudflareEnv,
  to: string,
  subject: string,
  message: string
) {
  if (!invitationMailEnabled(env)) return
  try {
    const origin = invitationOrigin(env)
    await mailer(
      env,
      origin
    )({
      to,
      subject,
      message,
      url: `${origin}/#/settings/emergency-access`,
      label: "Review emergency access",
    })
  } catch {
    console.error("Emergency access notification was not delivered")
  }
}

function accessLabel(type: number) {
  return type === TAKEOVER ? "take over" : "view"
}

function elapsed(now: number) {
  return sql`${vaultEmergencyAccess.recoveryInitiatedAt} + ${vaultEmergencyAccess.waitTimeDays} * ${DAY_MS} <= ${now}`
}

// A recovery request the grantor has not answered is approved once the wait
// time has passed. This runs before every emergency access request for the
// caller's own grants, so access never depends on the scheduled handler.
async function approveElapsedRecoveries(env: CloudflareEnv, userId?: string) {
  const now = Date.now()
  const approved = await drizzle(env.DB)
    .update(vaultEmergencyAccess)
    .set({ status: RECOVERY_APPROVED, updatedAt: new Date(now) })
    .where(
      and(
        eq(vaultEmergencyAccess.status, RECOVERY_INITIATED),
        elapsed(now),
        userId
          ? or(
              eq(vaultEmergencyAccess.grantorId, userId),
              eq(vaultEmergencyAccess.granteeId, userId)
            )
          : undefined
      )
    )
    .returning()
    .all()
  if (!approved.length || !invitationMailEnabled(env)) return
  for (const grant of approved) {
    const [grantor, grantee] = await Promise.all([
      findVaultUserById(env, grant.grantorId),
      grant.granteeId ? findVaultUserById(env, grant.granteeId) : null,
    ])
    if (!grantor || !grantee) continue
    await notify(
      env,
      grantee.email,
      "Emergency access request approved",
      `Your request to ${accessLabel(grant.type)} the vault of ${displayName(grantor)} has been approved.`
    )
    await notify(
      env,
      grantor.email,
      "Emergency access request timed out",
      `${displayName(grantee)} can now ${accessLabel(grant.type)} your vault because the wait time passed without a response.`
    )
  }
}

async function remindGrantors(env: CloudflareEnv) {
  if (!invitationMailEnabled(env)) return
  const now = Date.now()
  const db = drizzle(env.DB)
  const due = await db
    .select({ id: vaultEmergencyAccess.id })
    .from(vaultEmergencyAccess)
    .where(
      and(
        eq(vaultEmergencyAccess.status, RECOVERY_INITIATED),
        sql`${vaultEmergencyAccess.recoveryInitiatedAt} + (${vaultEmergencyAccess.waitTimeDays} - 1) * ${DAY_MS} <= ${now}`,
        sql`coalesce(${vaultEmergencyAccess.lastNotificationAt}, 0) + ${DAY_MS} <= ${now}`
      )
    )
    .limit(50)
    .all()
  for (const { id } of due) {
    const grant = await db
      .update(vaultEmergencyAccess)
      .set({ lastNotificationAt: new Date(now) })
      .where(
        and(
          eq(vaultEmergencyAccess.id, id),
          eq(vaultEmergencyAccess.status, RECOVERY_INITIATED),
          sql`coalesce(${vaultEmergencyAccess.lastNotificationAt}, 0) + ${DAY_MS} <= ${now}`
        )
      )
      .returning()
      .get()
    if (!grant?.granteeId) continue
    const [grantor, grantee] = await Promise.all([
      findVaultUserById(env, grant.grantorId),
      findVaultUserById(env, grant.granteeId),
    ])
    if (!grantor || !grantee) continue
    await notify(
      env,
      grantor.email,
      "Pending emergency access request",
      `${displayName(grantee)} will be able to ${accessLabel(grant.type)} your vault soon unless you reject the request.`
    )
  }
}

type Database = ReturnType<typeof drizzle>

export async function hasEmergencyAccess(env: CloudflareEnv, userId: string) {
  return !!(await drizzle(env.DB)
    .select({ id: vaultEmergencyAccess.id })
    .from(vaultEmergencyAccess)
    .where(
      or(
        eq(vaultEmergencyAccess.grantorId, userId),
        eq(vaultEmergencyAccess.granteeId, userId)
      )
    )
    .get())
}

// A key rotation must re-wrap the user key for every confirmed contact. This
// returns the writes for the rotation's commit batch, or null when the
// request does not cover exactly the grants that hold a key.
export async function emergencyAccessRotation(
  env: CloudflareEnv,
  grantorId: string,
  items: Body[]
) {
  const holding = (
    await drizzle(env.DB)
      .select({
        id: vaultEmergencyAccess.id,
        keyEncrypted: vaultEmergencyAccess.keyEncrypted,
      })
      .from(vaultEmergencyAccess)
      .where(eq(vaultEmergencyAccess.grantorId, grantorId))
      .all()
  ).filter((grant) => grant.keyEncrypted)
  const next = new Map<string, string>()
  for (const item of items) {
    const id = stringField(item, "id")
    const key = stringField(item, "keyEncrypted")
    if (!id || !key || key.length > 5000 || next.has(id)) return null
    next.set(id, key)
  }
  if (
    next.size !== holding.length ||
    !holding.every((grant) => next.has(grant.id))
  )
    return null
  return (db: Database, committed: SQL) =>
    [...next].map(([id, keyEncrypted]) =>
      db
        .update(vaultEmergencyAccess)
        .set({ keyEncrypted, updatedAt: new Date() })
        .where(
          and(
            eq(vaultEmergencyAccess.id, id),
            eq(vaultEmergencyAccess.grantorId, grantorId),
            committed
          )
        )
    )
}

/** Called by the scheduled handler. */
export async function processEmergencyAccess(env: CloudflareEnv) {
  await approveElapsedRecoveries(env)
  await remindGrantors(env)
}

async function findGrant(env: CloudflareEnv, id: string) {
  return (
    (await drizzle(env.DB)
      .select()
      .from(vaultEmergencyAccess)
      .where(eq(vaultEmergencyAccess.id, id))
      .get()) ?? null
  )
}

function granteeDetails(grant: Grant, grantee: VaultUser | null) {
  return {
    id: grant.id,
    status: grant.status,
    type: grant.type,
    waitTimeDays: grant.waitTimeDays,
    granteeId: grant.granteeId,
    email: grantee?.email ?? grant.email,
    name: grantee?.name ?? null,
    avatarColor: grantee?.avatarColor ?? null,
    object: "emergencyAccessGranteeDetails",
  }
}

function grantorDetails(grant: Grant, grantor: VaultUser) {
  return {
    id: grant.id,
    status: grant.status,
    type: grant.type,
    waitTimeDays: grant.waitTimeDays,
    grantorId: grant.grantorId,
    email: grantor.email,
    name: grantor.name,
    avatarColor: grantor.avatarColor,
    object: "emergencyAccessGrantorDetails",
  }
}

function list(data: unknown[]) {
  return { data, object: "list", continuationToken: null }
}

function validType(type: number | undefined): type is 0 | 1 {
  return type === VIEW || type === TAKEOVER
}

function validWaitTime(days: number | undefined): days is number {
  return days !== undefined && days >= 1 && days <= MAX_WAIT_DAYS
}

async function inviteAllowed(env: CloudflareEnv, userId: string) {
  const limiter = await env.APP_DATABASE.getByName("bitwarden-login-rates")
  return (
    await limiter.consumeRateLimit(
      `emergency-invite:${userId}`,
      20,
      60 * 60_000
    )
  ).allowed
}

// Recovery is open only to the grantee, only for the granted access type, and
// only while the grant is approved. Every recovery route reloads it.
async function approvedGrant(
  env: CloudflareEnv,
  id: string,
  grantee: VaultUser,
  type: number
) {
  const grant = await findGrant(env, id)
  if (
    !grant ||
    grant.granteeId !== grantee.id ||
    grant.status !== RECOVERY_APPROVED ||
    grant.type !== type
  )
    return null
  const grantor = await findVaultUserById(env, grant.grantorId)
  if (!grantor) return null
  // The grantor's vault must match the key this grant wraps.
  await settleVaultKeyRotation(env, grantor)
  return { grant, grantor }
}

export async function handleEmergencyAccess(
  env: CloudflareEnv,
  request: Request,
  user: VaultUser,
  path: string,
  method: string,
  origin: string,
  renderCipher: EmergencyCipherRenderer
): Promise<Response | null> {
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return null
  const db = drizzle(env.DB)
  await approveElapsedRecoveries(env, user.id)

  if (path === `${BASE}/trusted` && method === "GET") {
    const rows = await db
      .select({ grant: vaultEmergencyAccess, grantee: vaultUser })
      .from(vaultEmergencyAccess)
      .leftJoin(vaultUser, eq(vaultUser.id, vaultEmergencyAccess.granteeId))
      .where(eq(vaultEmergencyAccess.grantorId, user.id))
      .orderBy(vaultEmergencyAccess.createdAt)
      .limit(MAX_GRANTS)
      .all()
    return json(
      list(rows.map(({ grant, grantee }) => granteeDetails(grant, grantee)))
    )
  }

  if (path === `${BASE}/granted` && method === "GET") {
    const rows = await db
      .select({ grant: vaultEmergencyAccess, grantor: vaultUser })
      .from(vaultEmergencyAccess)
      .innerJoin(vaultUser, eq(vaultUser.id, vaultEmergencyAccess.grantorId))
      .where(
        and(
          eq(vaultEmergencyAccess.granteeId, user.id),
          isNull(vaultUser.deletingAt)
        )
      )
      .orderBy(vaultEmergencyAccess.createdAt)
      .limit(500)
      .all()
    return json(
      list(rows.map(({ grant, grantor }) => grantorDetails(grant, grantor)))
    )
  }

  if (path === `${BASE}/invite` && method === "POST") {
    const body = await bodyOf(request)
    const email = normalizeEmail((body && stringField(body, "email")) ?? "")
    const type = body ? integerField(body, "type") : undefined
    const waitTimeDays = body ? integerField(body, "waitTimeDays") : undefined
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      return failure("Invalid emergency contact email")
    if (!validType(type)) return failure("Invalid emergency access type.")
    if (!validWaitTime(waitTimeDays)) return failure("Invalid wait time")
    if (email === user.email)
      return failure("You can not set yourself as an emergency contact.")
    const sending = invitationMailEnabled(env)
    if (sending) {
      try {
        invitationOrigin(env)
      } catch {
        return failure("Invitation mail is not configured", 503)
      }
    }
    const target = await findVaultUser(env, email)
    if (!sending && !target?.publicKey)
      return failure("Invited account must exist and have a public key")
    const existing = await db
      .select({
        id: vaultEmergencyAccess.id,
        email: vaultEmergencyAccess.email,
        granteeId: vaultEmergencyAccess.granteeId,
      })
      .from(vaultEmergencyAccess)
      .where(eq(vaultEmergencyAccess.grantorId, user.id))
      .all()
    if (
      existing.some(
        (grant) =>
          grant.email === email || (target && grant.granteeId === target.id)
      )
    )
      return failure("Emergency contact is already invited", 409)
    if (existing.length >= MAX_GRANTS)
      return failure("Too many emergency contacts")
    if (sending && !(await inviteAllowed(env, user.id)))
      return failure("Too many invitations", 429)
    const now = new Date()
    const id = crypto.randomUUID()
    try {
      // Without mail there is no token to deliver, so an existing account is
      // treated as having accepted, as organization invitations are.
      await db
        .insert(vaultEmergencyAccess)
        .values({
          id,
          grantorId: user.id,
          granteeId: sending ? null : target!.id,
          email: sending ? email : null,
          type,
          status: sending ? INVITED : ACCEPTED,
          waitTimeDays,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    } catch {
      return failure("Emergency contact is already invited", 409)
    }
    if (sending) {
      try {
        await sendEmergencyInvite(env, { id, email }, user)
      } catch {
        return failure("Invitation delivery failed; resend the invitation", 503)
      }
    }
    return ok()
  }

  const attachmentMatch =
    /^\/api\/emergency-access\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/attachment\/([0-9a-f-]{36})$/.exec(
      path
    )
  if (attachmentMatch && method === "GET") {
    const access = await approvedGrant(env, attachmentMatch[1]!, user, VIEW)
    if (!access) return failure(INVALID)
    const cipherId = attachmentMatch[2]!
    const vault = await env.APP_DATABASE.getByName(`vault:${access.grantor.id}`)
    const attachment = (await vault.getVaultCipher(cipherId))
      ? await vault.getVaultAttachment(attachmentMatch[3]!, cipherId)
      : null
    // The download route resolves the vault and the R2 prefix from the account
    // the token is bound to, which is the grantor.
    const token = attachment?.uploaded
      ? await vault.issueVaultAttachmentToken(
          attachment.id,
          cipherId,
          access.grantor.id
        )
      : null
    if (!attachment || !token) return failure("Attachment not found", 404)
    return json({
      id: attachment.id,
      url: `${origin}/attachments/${cipherId}/${attachment.id}?token=${access.grantor.id}.${token}`,
      fileName: attachment.fileName,
      size: String(attachment.size),
      key: attachment.key,
      object: "attachment",
    })
  }

  const match =
    /^\/api\/emergency-access\/([0-9a-f-]{36})(?:\/(delete|reinvite|accept|confirm|initiate|approve|reject|view|takeover|password|policies))?$/.exec(
      path
    )
  if (!match) return null
  const id = match[1]!
  const action = match[2]
  const mine = and(
    eq(vaultEmergencyAccess.id, id),
    eq(vaultEmergencyAccess.grantorId, user.id)
  )

  if (!action && method === "GET") {
    const grant = await findGrant(env, id)
    if (!grant || grant.grantorId !== user.id) return failure(INVALID)
    return json(
      granteeDetails(
        grant,
        grant.granteeId ? await findVaultUserById(env, grant.granteeId) : null
      )
    )
  }

  if (!action && (method === "PUT" || method === "POST")) {
    const body = await bodyOf(request)
    const type = body ? integerField(body, "type") : undefined
    const waitTimeDays = body ? integerField(body, "waitTimeDays") : undefined
    if (!validType(type)) return failure("Invalid emergency access type.")
    if (!validWaitTime(waitTimeDays)) return failure("Invalid wait time")
    const keyEncrypted = body && stringField(body, "keyEncrypted")
    if (keyEncrypted && keyEncrypted.length > 5000)
      return failure("Invalid emergency access key")
    const grant = await findGrant(env, id)
    if (!grant || grant.grantorId !== user.id) return failure(INVALID)
    const updated = await db
      .update(vaultEmergencyAccess)
      .set({
        type,
        waitTimeDays,
        // A key exists only on a confirmed grant and can only be replaced.
        ...(keyEncrypted && grant.keyEncrypted ? { keyEncrypted } : {}),
        updatedAt: new Date(),
      })
      .where(mine)
      .returning({ id: vaultEmergencyAccess.id })
      .get()
    return updated ? ok() : failure(INVALID)
  }

  if (
    (!action && method === "DELETE") ||
    (action === "delete" && method === "POST")
  ) {
    const removed = await db
      .delete(vaultEmergencyAccess)
      .where(
        and(
          eq(vaultEmergencyAccess.id, id),
          or(
            eq(vaultEmergencyAccess.grantorId, user.id),
            eq(vaultEmergencyAccess.granteeId, user.id)
          )
        )
      )
      .returning({ id: vaultEmergencyAccess.id })
      .get()
    return removed ? ok() : failure(INVALID)
  }

  if (action === "policies" && method === "GET") {
    return (await approvedGrant(env, id, user, TAKEOVER))
      ? json(list([]))
      : failure(INVALID)
  }

  if (!action || method !== "POST") return null

  if (action === "reinvite") {
    const grant = await findGrant(env, id)
    if (
      !grant ||
      grant.grantorId !== user.id ||
      grant.status !== INVITED ||
      !grant.email
    )
      return failure(INVALID)
    if (!invitationMailEnabled(env))
      return failure("Invitation mail is disabled", 403)
    if (!(await inviteAllowed(env, user.id)))
      return failure("Too many invitations", 429)
    try {
      await sendEmergencyInvite(env, { id, email: grant.email }, user)
    } catch {
      return failure("Invitation delivery failed", 503)
    }
    return ok()
  }

  if (action === "accept") {
    const body = await bodyOf(request)
    const token = body && stringField(body, "token")
    const grant = await findGrant(env, id)
    if (!grant) return failure(INVALID)
    if (
      !token ||
      !(await validEmergencyInvite(env, token, { id, email: user.email }))
    )
      return failure("Invalid token.")
    if (grant.status === ACCEPTED)
      return failure(
        "Invitation already accepted. You will receive an email when the grantor confirms you as an emergency access contact."
      )
    if (grant.status !== INVITED) return failure("Invitation already accepted.")
    if (grant.email !== user.email || grant.grantorId === user.id)
      return failure("User email does not match invite.")
    let accepted
    try {
      accepted = await db
        .update(vaultEmergencyAccess)
        .set({
          status: ACCEPTED,
          granteeId: user.id,
          email: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(vaultEmergencyAccess.id, id),
            eq(vaultEmergencyAccess.status, INVITED),
            eq(vaultEmergencyAccess.email, user.email)
          )
        )
        .returning({ id: vaultEmergencyAccess.id })
        .get()
    } catch {
      // The grantor already has a grant for this account.
      return failure("Invitation already accepted.")
    }
    if (!accepted) return failure("Invitation already accepted.")
    const grantor = await findVaultUserById(env, grant.grantorId)
    if (grantor)
      await notify(
        env,
        grantor.email,
        "Emergency contact accepted",
        `${user.email} has accepted your invitation to become an emergency contact. Confirm them to finish.`
      )
    return ok()
  }

  if (action === "confirm") {
    const body = await bodyOf(request)
    const key = body && stringField(body, "key")
    if (!key || key.length > 5000)
      return failure("Invalid emergency access key")
    const confirmed = await db
      .update(vaultEmergencyAccess)
      .set({
        status: CONFIRMED,
        keyEncrypted: key,
        email: null,
        updatedAt: new Date(),
      })
      .where(and(mine, eq(vaultEmergencyAccess.status, ACCEPTED)))
      .returning()
      .get()
    if (!confirmed) return failure(INVALID)
    const grantee = confirmed.granteeId
      ? await findVaultUserById(env, confirmed.granteeId)
      : null
    if (grantee)
      await notify(
        env,
        grantee.email,
        "You have been confirmed as an emergency contact",
        `${displayName(user)} has confirmed you as an emergency contact.`
      )
    return ok()
  }

  if (action === "initiate") {
    const grant = await findGrant(env, id)
    const grantor =
      grant?.granteeId === user.id && grant.status === CONFIRMED
        ? await findVaultUserById(env, grant.grantorId)
        : null
    if (!grant || !grantor) return failure(INVALID)
    const now = new Date()
    const initiated = await db
      .update(vaultEmergencyAccess)
      .set({
        status: RECOVERY_INITIATED,
        recoveryInitiatedAt: now,
        lastNotificationAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(vaultEmergencyAccess.id, id),
          eq(vaultEmergencyAccess.granteeId, user.id),
          eq(vaultEmergencyAccess.status, CONFIRMED)
        )
      )
      .returning()
      .get()
    if (!initiated) return failure(INVALID)
    await notify(
      env,
      grantor.email,
      "Emergency access requested",
      `${displayName(user)} has requested to ${accessLabel(initiated.type)} your vault. Access is granted in ${initiated.waitTimeDays} day(s) unless you reject the request.`
    )
    return ok()
  }

  if (action === "approve" || action === "reject") {
    const approving = action === "approve"
    const changed = await db
      .update(vaultEmergencyAccess)
      .set(
        approving
          ? { status: RECOVERY_APPROVED, updatedAt: new Date() }
          : {
              status: CONFIRMED,
              recoveryInitiatedAt: null,
              lastNotificationAt: null,
              updatedAt: new Date(),
            }
      )
      .where(
        and(
          mine,
          approving
            ? eq(vaultEmergencyAccess.status, RECOVERY_INITIATED)
            : inArray(vaultEmergencyAccess.status, [
                RECOVERY_INITIATED,
                RECOVERY_APPROVED,
              ])
        )
      )
      .returning()
      .get()
    if (!changed) return failure(INVALID)
    const grantee = changed.granteeId
      ? await findVaultUserById(env, changed.granteeId)
      : null
    if (grantee)
      await notify(
        env,
        grantee.email,
        approving
          ? "Emergency access request approved"
          : "Emergency access request rejected",
        `${displayName(user)} has ${approving ? "approved" : "rejected"} your emergency access request.`
      )
    return ok()
  }

  if (action === "view") {
    const access = await approvedGrant(env, id, user, VIEW)
    if (!access) return failure(INVALID)
    // The vault is selected from the validated grant, never from the request.
    const vault = await env.APP_DATABASE.getByName(`vault:${access.grantor.id}`)
    const { ciphers } = await vault.listVault()
    return json({
      ciphers: await Promise.all(
        ciphers.map((row) =>
          renderCipher(row, vault, env, access.grantor.id, origin)
        )
      ),
      keyEncrypted: access.grant.keyEncrypted,
      object: "emergencyAccessView",
    })
  }

  if (action === "takeover") {
    const access = await approvedGrant(env, id, user, TAKEOVER)
    if (!access) return failure(INVALID)
    return json({
      kdf: access.grantor.kdf,
      kdfIterations: access.grantor.kdfIterations,
      kdfMemory: access.grantor.kdfMemory,
      kdfParallelism: access.grantor.kdfParallelism,
      keyEncrypted: access.grant.keyEncrypted,
      salt: access.grantor.email,
      object: "emergencyAccessTakeover",
    })
  }

  if (action === "password") {
    const body = await bodyOf(request)
    const access = await approvedGrant(env, id, user, TAKEOVER)
    if (!access) return failure(INVALID)
    const { grantor } = access
    const authentication = body && objectField(body, "authenticationData")
    const unlock = body && objectField(body, "unlockData")
    let password: string | undefined
    let key: string | undefined
    if (authentication && unlock) {
      // A takeover replaces the password only; the KDF and salt stay as the
      // grantor set them.
      for (const data of [authentication, unlock]) {
        const kdf = objectField(data, "kdf")
        if (
          stringField(data, "salt") !== grantor.email ||
          !kdf ||
          (integerField(kdf, "kdfType") ?? integerField(kdf, "kdf")) !==
            grantor.kdf ||
          integerField(kdf, "iterations") !== grantor.kdfIterations ||
          (integerField(kdf, "memory") ?? null) !== grantor.kdfMemory ||
          (integerField(kdf, "parallelism") ?? null) !== grantor.kdfParallelism
        )
          return failure("KDF settings do not match the grantor account")
      }
      const containedKeyId = stringField(unlock, "containedKeyId")
      if (
        grantor.userKeyId &&
        containedKeyId &&
        containedKeyId !== grantor.userKeyId
      )
        return failure("Invalid user key sent in master-password unlock data.")
      password = stringField(authentication, "masterPasswordAuthenticationHash")
      key = stringField(unlock, "masterKeyWrappedUserKey")
    } else if (body) {
      password = stringField(body, "newMasterPasswordHash")
      key = stringField(body, "key")
    }
    if (!password || password.length > 1024 || !key || key.length > 20_000)
      return failure("Invalid password change fields")
    // The request carries the grantee's bearer, which matches none of the
    // grantor's sessions, so this rotates the security stamp and signs the
    // grantor out everywhere. The old hint no longer describes the password.
    if (
      !(await updateVaultPassword(
        env,
        grantor,
        request,
        password,
        key,
        null,
        null
      ))
    )
      return failure("Account changed", 409)
    // Two-factor would otherwise still lock the grantee out.
    await db.batch([
      db.delete(vaultTotp).where(eq(vaultTotp.userId, grantor.id)),
      db
        .delete(vaultEmailTwoFactor)
        .where(eq(vaultEmailTwoFactor.userId, grantor.id)),
      db
        .delete(vaultWebauthnCredential)
        .where(eq(vaultWebauthnCredential.userId, grantor.id)),
      db
        .delete(vaultWebauthnFactor)
        .where(eq(vaultWebauthnFactor.userId, grantor.id)),
      // Upstream removes the grantor from every organization it does not own.
      db
        .delete(vaultMembership)
        .where(
          and(
            eq(vaultMembership.userId, grantor.id),
            ne(vaultMembership.role, 0)
          )
        ),
    ])
    await publishVaultNotification(env, { type: 11, userId: grantor.id })
    return ok()
  }

  return null
}
