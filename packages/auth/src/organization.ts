import { and, eq } from "drizzle-orm"

import type { AuthDb } from "@workspace/auth/db"
import {
  member,
  organization,
  type MemberRow,
  type OrganizationRow,
} from "@workspace/auth/schema"

/**
 * Organization reads that the app does directly, rather than through Better
 * Auth's API — page renders, and anything that needs to authorize before
 * Better Auth's own endpoints would.
 */

export type OrganizationRole = "owner" | "admin" | "member"

/** Rank, so "at least admin" is a comparison rather than a list of strings. */
const RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 }

export function roleAtLeast(
  role: string | undefined,
  required: OrganizationRole
) {
  return (RANK[role ?? ""] ?? 0) >= RANK[required]!
}

export async function getOrganization(db: AuthDb, id: string) {
  const [row] = await db
    .select()
    .from(organization)
    .where(eq(organization.id, id))
    .limit(1)
  return row ?? null
}

export async function getOrganizationBySlug(db: AuthDb, slug: string) {
  const [row] = await db
    .select()
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1)
  return row ?? null
}

/** The caller's membership, or null when they do not belong to the org. */
export async function getMembership(
  db: AuthDb,
  options: { organizationId: string; userId: string }
): Promise<MemberRow | null> {
  const [row] = await db
    .select()
    .from(member)
    .where(
      and(
        eq(member.organizationId, options.organizationId),
        eq(member.userId, options.userId)
      )
    )
    .limit(1)
  return row ?? null
}

/**
 * Authorizes an action inside an organization.
 *
 * Membership is checked against the database rather than taken from the
 * session: `activeOrganizationId` is whatever the session was last pointed
 * at, and a user removed from an org still carries the old value until their
 * session is refreshed. Trusting it would leave a removed member with access.
 */
export async function requireMembership(
  db: AuthDb,
  options: {
    organizationId: string
    userId: string
    role?: OrganizationRole
  }
): Promise<MemberRow> {
  const membership = await getMembership(db, options)
  if (!membership) {
    throw new Error("Not a member of this organization")
  }
  if (options.role && !roleAtLeast(membership.role, options.role)) {
    throw new Error(`Requires the ${options.role} role`)
  }
  return membership
}

/** Every organization the user belongs to, with their role in each. */
export async function listOrganizations(
  db: AuthDb,
  userId: string
): Promise<Array<OrganizationRow & { role: string }>> {
  const rows = await db
    .select({ organization, role: member.role })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, userId))

  return rows.map((row) => ({ ...row.organization, role: row.role }))
}
