import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { getMembership } from "@workspace/auth"
import { getDb } from "@/db"

import { auth } from "@/lib/auth"

export async function getServerSession() {
  return auth.api.getSession({ headers: await headers() })
}

/** Redirects to sign-in instead of returning null. */
export async function requireServerSession() {
  const session = await getServerSession()
  if (!session) redirect("/sign-in")
  if (!session.user.emailVerified) redirect("/verify-email")
  return session
}

/**
 * The organization the session is acting as.
 *
 * Returns the id only. Anything that authorizes against it must re-check
 * membership in the database — `activeOrganizationId` is whatever the session
 * was last pointed at, and a user removed from an organization keeps the
 * stale value until their session refreshes. See `requireMembership`.
 */
export async function getActiveOrganizationId() {
  const session = await getServerSession()
  return session?.session.activeOrganizationId ?? null
}

export async function requireActiveOrganization() {
  const session = await requireServerSession()
  const organizationId = session.session.activeOrganizationId
  if (!organizationId) redirect("/onboarding")
  const membership = await getMembership(getDb(), {
    organizationId,
    userId: session.user.id,
  })
  if (!membership) redirect("/onboarding")
  return { session, organizationId, membership }
}
