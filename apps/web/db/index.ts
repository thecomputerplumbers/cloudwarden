import { env } from "cloudflare:workers"
import { drizzle } from "drizzle-orm/d1"

import * as schema from "./schema"

/**
 * The relational store.
 *
 * D1 holds anything that is queried across rows — users, organizations,
 * subscriptions. The Durable Object (`worker/database.ts`) holds what wants
 * single-object coordination instead: counters, rate limits, leases.
 */
export function getDb() {
  return drizzle(env.DB)
}

export type AppDb = ReturnType<typeof getDb>

export { schema }
