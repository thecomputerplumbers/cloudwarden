import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

/**
 * Better Auth's tables, for D1.
 *
 * Column *property* names here must match what Better Auth expects — it
 * addresses fields by the property, not the SQL column — so `emailVerified`
 * stays camelCase even though the column is `email_verified`. Renaming a
 * property breaks sign-in at runtime, not at compile time, so treat these as
 * fixed unless you are also passing a `schema` mapping to the plugin.
 *
 * Regenerate rather than hand-edit when adding a plugin:
 *
 * ```sh
 * pnpm --filter web exec better-auth generate --config lib/auth.ts
 * ```
 *
 * These live in D1 rather than the Durable Object because Better Auth runs in
 * the request handler and needs a database it can await. `durable-sqlite` is
 * synchronous and only reachable from inside the object.
 */

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text("image"),
  ...timestamps,
})

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /**
     * Which organization this session is acting as. Added by the organization
     * plugin, and the thing to read when scoping a query to "the current org".
     */
    activeOrganizationId: text("active_organization_id"),
    ...timestamps,
  },
  (table) => [index("session_user_idx").on(table.userId)]
)

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    idToken: text("id_token"),
    /** Hashed by Better Auth (scrypt). Never store anything here yourself. */
    password: text("password"),
    ...timestamps,
  },
  (table) => [
    index("account_user_idx").on(table.userId),
    uniqueIndex("account_provider_identity_idx").on(
      table.providerId,
      table.accountId
    ),
  ]
)

/** Short-lived tokens: email verification, password reset, magic links. */
export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
)

/**
 * Database-backed rate limiting.
 *
 * Better Auth keeps counters here when `rateLimit.storage` is `"database"`,
 * which is what you want on Workers: the in-memory default is per-isolate,
 * so an attacker spread across isolates would get a fresh budget from each.
 *
 * `lastRequest` is epoch milliseconds as a plain integer, not a timestamp —
 * Better Auth writes a number, so giving it `mode: "timestamp_ms"` would hand
 * Drizzle a `Date` it never receives.
 */
export const rateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
})

// ---------------------------------------------------------------------------
// organization plugin

export const organization = sqliteTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    /** JSON text. Better Auth serializes it; read it back with `JSON.parse`. */
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("organization_slug_idx").on(table.slug)]
)

export const member = sqliteTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** `owner`, `admin` or `member` by default. */
    role: text("role").notNull().default("member"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("member_organization_idx").on(table.organizationId),
    index("member_user_idx").on(table.userId),
    uniqueIndex("member_org_user_idx").on(table.organizationId, table.userId),
  ]
)

export const invitation = sqliteTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    /** `pending`, `accepted`, `rejected` or `canceled`. */
    status: text("status").notNull().default("pending"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("invitation_organization_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ]
)

export type UserRow = typeof user.$inferSelect
export type SessionRow = typeof session.$inferSelect
export type OrganizationRow = typeof organization.$inferSelect
export type MemberRow = typeof member.$inferSelect
export type InvitationRow = typeof invitation.$inferSelect

export * from "@workspace/auth/oauth-schema"

/** Organization-bound agent authorizations, checked on every MCP request. */
export const agentGrant = sqliteTable(
  "agent_grant",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("agent_grant_user_idx").on(t.userId)]
)

export const auditEvent = sqliteTable(
  "audit_event",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    organizationId: text("organization_id").notNull(),
    action: text("action").notNull(),
    grantId: text("grant_id"),
    requestId: text("request_id").notNull().unique(),
    details: text("details", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("audit_event_organization_idx").on(t.organizationId)]
)
