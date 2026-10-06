/**
 * Auth tables, owned by `@workspace/auth`.
 *
 * Re-exported rather than redefined so the columns stay in step with what
 * Better Auth expects. The migrations are generated and committed here,
 * because this app owns the database.
 */

export * from "@workspace/auth/schema"
