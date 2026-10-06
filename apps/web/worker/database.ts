import { DurableObject } from "cloudflare:workers"
import { and, eq } from "drizzle-orm"
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

  // The caller selects this object by the authenticated user's ID. All vault
  // mutations below are synchronous SQLite operations with no intervening
  // await, so a read/check/write cannot interleave with another request.
  async listVault() {
    return {
      ciphers: this.db.select().from(schema.vaultCipher).all(),
      folders: this.db.select().from(schema.vaultFolder).all(),
    }
  }

  async getVaultCipher(id: string) {
    return (
      this.db
        .select()
        .from(schema.vaultCipher)
        .where(eq(schema.vaultCipher.id, id))
        .get() ?? null
    )
  }

  async putVaultCipher(id: string, payload: string, expectedRevision?: number) {
    if (!id || payload.length > 1_000_000) throw new Error("Invalid cipher")
    const now = new Date()
    const existing = this.db
      .select()
      .from(schema.vaultCipher)
      .where(eq(schema.vaultCipher.id, id))
      .get()
    if (existing) {
      if (
        expectedRevision !== undefined &&
        expectedRevision !== existing.revision
      )
        return { conflict: true as const, cipher: existing }
      const cipher = this.db
        .update(schema.vaultCipher)
        .set({ payload, revision: existing.revision + 1, updatedAt: now })
        .where(
          and(
            eq(schema.vaultCipher.id, id),
            eq(schema.vaultCipher.revision, existing.revision)
          )
        )
        .returning()
        .get()
      return cipher
        ? { conflict: false as const, cipher }
        : { conflict: true as const, cipher: existing }
    }
    if (expectedRevision !== undefined)
      return { conflict: true as const, cipher: null }
    const cipher = this.db
      .insert(schema.vaultCipher)
      .values({ id, payload, revision: 1, createdAt: now, updatedAt: now })
      .returning()
      .get()
    return { conflict: false as const, cipher }
  }

  async trashVaultCipher(id: string, expectedRevision?: number) {
    const existing = this.db
      .select()
      .from(schema.vaultCipher)
      .where(eq(schema.vaultCipher.id, id))
      .get()
    if (!existing) return { found: false as const, conflict: false as const }
    if (
      expectedRevision !== undefined &&
      expectedRevision !== existing.revision
    )
      return { found: true as const, conflict: true as const }
    const now = new Date()
    const cipher = this.db
      .update(schema.vaultCipher)
      .set({ revision: existing.revision + 1, deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.vaultCipher.id, id),
          eq(schema.vaultCipher.revision, existing.revision)
        )
      )
      .returning()
      .get()
    return { found: true as const, conflict: !cipher }
  }

  async getVaultFolder(id: string) {
    return (
      this.db
        .select()
        .from(schema.vaultFolder)
        .where(eq(schema.vaultFolder.id, id))
        .get() ?? null
    )
  }

  async putVaultFolder(id: string, name: string, expectedRevision?: number) {
    if (!id || !name || name.length > 10_000) throw new Error("Invalid folder")
    const now = new Date()
    const existing = this.db
      .select()
      .from(schema.vaultFolder)
      .where(eq(schema.vaultFolder.id, id))
      .get()
    if (existing) {
      if (
        expectedRevision !== undefined &&
        expectedRevision !== existing.revision
      )
        return { conflict: true as const, folder: existing }
      const folder = this.db
        .update(schema.vaultFolder)
        .set({ name, revision: existing.revision + 1, updatedAt: now })
        .where(
          and(
            eq(schema.vaultFolder.id, id),
            eq(schema.vaultFolder.revision, existing.revision)
          )
        )
        .returning()
        .get()
      return folder
        ? { conflict: false as const, folder }
        : { conflict: true as const, folder: existing }
    }
    if (expectedRevision !== undefined)
      return { conflict: true as const, folder: null }
    const folder = this.db
      .insert(schema.vaultFolder)
      .values({ id, name, revision: 1, createdAt: now, updatedAt: now })
      .returning()
      .get()
    return { conflict: false as const, folder }
  }

  async deleteVaultFolder(id: string) {
    return !!this.db
      .delete(schema.vaultFolder)
      .where(eq(schema.vaultFolder.id, id))
      .returning({ id: schema.vaultFolder.id })
      .get()
  }
}
