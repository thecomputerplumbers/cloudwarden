import { DurableObject } from "cloudflare:workers"
import { and, eq, lt } from "drizzle-orm"
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
      attachments: this.db
        .select()
        .from(schema.vaultAttachment)
        .where(eq(schema.vaultAttachment.uploaded, true))
        .all(),
    }
  }

  async vaultRevision() {
    const ciphers = this.db.select().from(schema.vaultCipher).all()
    const folders = this.db.select().from(schema.vaultFolder).all()
    let latest = 0
    for (const cipher of ciphers)
      latest = Math.max(latest, cipher.updatedAt.getTime())
    for (const folder of folders)
      latest = Math.max(latest, folder.updatedAt.getTime())
    return latest
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

  async putVaultCipher(
    id: string,
    payload: string,
    expectedRevision?: number,
    lastKnownRevisionDate?: string
  ) {
    if (!id || payload.length > 1_000_000) throw new Error("Invalid cipher")
    const now = new Date()
    const existing = this.db
      .select()
      .from(schema.vaultCipher)
      .where(eq(schema.vaultCipher.id, id))
      .get()
    if (existing) {
      if (lastKnownRevisionDate) {
        const knownTime = Date.parse(lastKnownRevisionDate)
        if (
          !Number.isFinite(knownTime) ||
          existing.updatedAt.getTime() - knownTime > 1000
        )
          return { conflict: true as const, cipher: existing }
      }
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

  async restoreVaultCipher(id: string) {
    const existing = this.db
      .select()
      .from(schema.vaultCipher)
      .where(eq(schema.vaultCipher.id, id))
      .get()
    if (!existing) return null
    return (
      this.db
        .update(schema.vaultCipher)
        .set({
          revision: existing.revision + 1,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.vaultCipher.id, id))
        .returning()
        .get() ?? null
    )
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
    const deleted = !!this.db
      .delete(schema.vaultFolder)
      .where(eq(schema.vaultFolder.id, id))
      .returning({ id: schema.vaultFolder.id })
      .get()
    if (!deleted) return false
    for (const cipher of this.db.select().from(schema.vaultCipher).all()) {
      const payload = JSON.parse(cipher.payload) as Record<string, unknown>
      const folderKey = Object.keys(payload).find(
        (key) => key.toLowerCase() === "folderid"
      )
      if (folderKey && payload[folderKey] === id) {
        payload[folderKey] = null
        this.db
          .update(schema.vaultCipher)
          .set({
            payload: JSON.stringify(payload),
            revision: cipher.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(schema.vaultCipher.id, cipher.id))
          .run()
      }
    }
    return true
  }

  async createVaultAttachment(input: {
    id: string
    cipherId: string
    fileName: string
    key: string | null
    size: number
  }) {
    if (
      !input.fileName ||
      input.fileName.length > 10_000 ||
      !Number.isSafeInteger(input.size) ||
      input.size < 0 ||
      input.size > 20_000_000
    )
      throw new Error("Invalid attachment")
    if (!(await this.getVaultCipher(input.cipherId)))
      throw new Error("Cipher not found")
    return this.db
      .insert(schema.vaultAttachment)
      .values({ ...input, uploaded: false, createdAt: new Date() })
      .returning()
      .get()
  }

  async getVaultAttachment(id: string, cipherId: string) {
    return (
      this.db
        .select()
        .from(schema.vaultAttachment)
        .where(
          and(
            eq(schema.vaultAttachment.id, id),
            eq(schema.vaultAttachment.cipherId, cipherId)
          )
        )
        .get() ?? null
    )
  }

  async listVaultAttachments(cipherId: string) {
    return this.db
      .select()
      .from(schema.vaultAttachment)
      .where(
        and(
          eq(schema.vaultAttachment.cipherId, cipherId),
          eq(schema.vaultAttachment.uploaded, true)
        )
      )
      .all()
  }

  async completeVaultAttachment(id: string, cipherId: string) {
    return !!this.db
      .update(schema.vaultAttachment)
      .set({ uploaded: true })
      .where(
        and(
          eq(schema.vaultAttachment.id, id),
          eq(schema.vaultAttachment.cipherId, cipherId),
          eq(schema.vaultAttachment.uploaded, false)
        )
      )
      .returning({ id: schema.vaultAttachment.id })
      .get()
  }

  async deleteVaultAttachment(id: string, cipherId: string) {
    this.db
      .delete(schema.vaultAttachmentToken)
      .where(eq(schema.vaultAttachmentToken.attachmentId, id))
      .run()
    return !!this.db
      .delete(schema.vaultAttachment)
      .where(
        and(
          eq(schema.vaultAttachment.id, id),
          eq(schema.vaultAttachment.cipherId, cipherId)
        )
      )
      .returning({ id: schema.vaultAttachment.id })
      .get()
  }

  async issueVaultAttachmentToken(id: string, cipherId: string) {
    const attachment = await this.getVaultAttachment(id, cipherId)
    if (!attachment?.uploaded) return null
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const token = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(token)
    )
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
    this.db
      .delete(schema.vaultAttachmentToken)
      .where(lt(schema.vaultAttachmentToken.expiresAt, new Date()))
      .run()
    this.db
      .insert(schema.vaultAttachmentToken)
      .values({
        hash,
        attachmentId: id,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      })
      .run()
    return token
  }

  async validateVaultAttachmentToken(
    id: string,
    cipherId: string,
    token: string
  ) {
    if (!/^[-_A-Za-z0-9]{43}$/.test(token)) return false
    const attachment = await this.getVaultAttachment(id, cipherId)
    if (!attachment?.uploaded) return false
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(token)
    )
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
    const grant = this.db
      .select()
      .from(schema.vaultAttachmentToken)
      .where(eq(schema.vaultAttachmentToken.hash, hash))
      .get()
    return (
      !!grant &&
      grant.attachmentId === id &&
      grant.expiresAt.getTime() > Date.now()
    )
  }
}
