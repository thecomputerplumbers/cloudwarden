/**
 * Better Auth, wired for Cloudflare D1.
 *
 * ```
 * @workspace/auth              server instance, secret handling, org helpers
 * @workspace/auth/schema       Drizzle tables
 * @workspace/auth/client       browser client ("use client")
 * @workspace/auth/react/*      sign-in and sign-up forms
 * ```
 *
 * The browser client is a separate entry point on purpose: importing it from
 * a server module would drag `"use client"` code into the RSC graph.
 */

export {
  createAuth,
  lazyAuth,
  resolveSecret,
  type Auth,
  type CreateAuthOptions,
} from "@workspace/auth/auth"

export { createAuthDb, type AuthDb } from "@workspace/auth/db"

export {
  getMembership,
  getOrganization,
  getOrganizationBySlug,
  listOrganizations,
  requireMembership,
  roleAtLeast,
  type OrganizationRole,
} from "@workspace/auth/organization"

export type {
  InvitationRow,
  MemberRow,
  OrganizationRow,
  SessionRow,
  UserRow,
} from "@workspace/auth/schema"
