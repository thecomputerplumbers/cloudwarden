import { DurableObject } from "cloudflare:workers"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"

import migrations from "../drizzle/migrations.js"
import * as schema from "./schema"

/**
 * Single-object state.
 *
 * Anything queried across rows — users, organizations, subscriptions — lives
 * in D1 (`db/index.ts`), which is async and reachable from the request
 * handler. What belongs here is what actually wants one writer: counters,
 * rate limits, leases, anything where two concurrent requests must not both
 * read the old value.
 */
export class AppDatabase extends DurableObject<CloudflareEnv> {
  private readonly db

  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env)
    this.db = drizzle(ctx.storage)

    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations)
    })
  }

  async consumeRateLimit(key: string, limit: number, windowMs: number) {
    const now = Date.now()
    const stored = this.db
      .select()
      .from(schema.setting)
      .where(eq(schema.setting.key, key))
      .get()
    const prior = stored
      ? (JSON.parse(stored.value) as { start: number; count: number })
      : null
    const bucket =
      prior && now - prior.start < windowMs ? prior : { start: now, count: 0 }
    if (bucket.count >= limit) return { allowed: false }
    bucket.count++
    this.db
      .insert(schema.setting)
      .values({ key, value: JSON.stringify(bucket), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.setting.key,
        set: { value: JSON.stringify(bucket), updatedAt: new Date() },
      })
      .run()
    return { allowed: true }
  }

  async health() {
    this.db
      .select({ key: schema.setting.key })
      .from(schema.setting)
      .limit(1)
      .all()
    return { ok: true as const }
  }

  async getSetting(key: string) {
    return (
      this.db
        .select()
        .from(schema.setting)
        .where(eq(schema.setting.key, key))
        .get() ?? null
    )
  }

  async setSetting(key: string, value: string) {
    if (!key || key.length > 100 || value.length > 10_000) {
      throw new Error("Invalid setting")
    }

    const updatedAt = new Date()
    this.db
      .insert(schema.setting)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({
        target: schema.setting.key,
        set: { value, updatedAt },
      })
      .run()

    return { key, value, updatedAt }
  }
}
