import { drizzle, type AnyD1Database } from "drizzle-orm/d1"

import * as schema from "@workspace/auth/schema"

/**
 * The auth database is D1, not the Durable Object.
 *
 * Better Auth runs inside the request handler and awaits every query. D1 is
 * async and reachable from there; `durable-sqlite` is synchronous and only
 * exists inside the object, so the adapter cannot reach it. The Durable
 * Object keeps what actually wants single-object coordination — counters,
 * rate limits, leases.
 *
 * `AnyD1Database` rather than `D1Database`, because this package does not
 * load the Workers runtime types; the app's generated `worker-env.d.ts` does.
 */
export function createAuthDb(database: AnyD1Database) {
  return drizzle(database)
}

export type AuthDb = ReturnType<typeof createAuthDb>

export { schema }
