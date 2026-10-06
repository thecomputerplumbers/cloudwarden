import { createMailer } from "@workspace/email"
import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import { vaultMembership, vaultUser } from "../db/schema/vault"
import { normalizeEmail } from "./bitwarden-auth"

const encoder = new TextEncoder()
const lifetimeMs = 7 * 24 * 60 * 60_000

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

export async function issueOrgInviteToken(
  env: CloudflareEnv,
  input: { email: string; orgId: string; memberId: string; userId: string }
) {
  const payload = encode(
    encoder.encode(
      JSON.stringify({
        purpose: "cloudwarden-org-invite",
        email: normalizeEmail(input.email),
        orgId: input.orgId,
        memberId: input.memberId,
        userId: input.userId,
        expiresAt: Date.now() + lifetimeMs,
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

export async function validOrgInvite(
  env: CloudflareEnv,
  token: string,
  input: { email: string; orgId?: string; memberId: string }
) {
  const parts = token.split(".")
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  )
    return null
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(env),
      decode(parts[1]!),
      encoder.encode(parts[0]!)
    )
    if (!valid) return null
    const claims: unknown = JSON.parse(
      new TextDecoder().decode(decode(parts[0]!))
    )
    if (!claims || typeof claims !== "object") return null
    const value = claims as Record<string, unknown>
    if (
      value.purpose !== "cloudwarden-org-invite" ||
      value.email !== normalizeEmail(input.email) ||
      value.memberId !== input.memberId ||
      (input.orgId && value.orgId !== input.orgId) ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt <= Date.now() ||
      typeof value.orgId !== "string" ||
      typeof value.userId !== "string"
    )
      return null
    const member = await drizzle(env.DB)
      .select({ membership: vaultMembership, user: vaultUser })
      .from(vaultMembership)
      .innerJoin(vaultUser, eq(vaultUser.id, vaultMembership.userId))
      .where(
        and(
          eq(vaultMembership.id, input.memberId),
          eq(vaultMembership.orgId, value.orgId)
        )
      )
      .get()
    return member?.membership.status === 0 &&
      member.membership.userId === value.userId &&
      member.user.email === value.email &&
      !member.user.deletingAt
      ? { orgId: value.orgId, memberId: input.memberId, userId: value.userId }
      : null
  } catch {
    return null
  }
}

export function invitationMailEnabled(env: CloudflareEnv) {
  return (
    (env as CloudflareEnv & { ORG_INVITATION_EMAILS_ENABLED?: string })
      .ORG_INVITATION_EMAILS_ENABLED === "true"
  )
}

export function invitationOrigin(env: CloudflareEnv) {
  const origin = new URL(env.APP_URL ?? "").origin
  const parsed = new URL(origin)
  if (
    parsed.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(parsed.hostname)
  )
    throw new Error("Invitation origin must use HTTPS")
  return origin
}

export async function sendOrgInvite(
  env: CloudflareEnv,
  input: {
    email: string
    orgId: string
    orgName: string
    memberId: string
    userId: string
    existingUser: boolean
  }
) {
  const origin = invitationOrigin(env)
  const token = await issueOrgInviteToken(env, input)
  const params = new URLSearchParams({
    email: input.email,
    organizationName: input.orgName,
    organizationId: input.orgId,
    organizationUserId: input.memberId,
    token,
    initOrganization: "false",
    orgUserHasExistingUser: String(input.existingUser),
  })
  const local = ["localhost", "127.0.0.1"].includes(new URL(origin).hostname)
  const from = env.EMAIL_FROM ?? (local ? "cloudwarden@example.com" : "")
  await createMailer(
    env.EMAIL,
    from
  )({
    to: input.email,
    subject: `Invitation to ${input.orgName}`,
    message: `You have been invited to ${input.orgName}.`,
    url: `${origin}/#/accept-organization/?${params}`,
    label: "Accept invitation",
  })
}
