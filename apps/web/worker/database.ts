import { DurableObject } from "cloudflare:workers"
import { and, eq, like, lt } from "drizzle-orm"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"

import migrations from "../drizzle/migrations.js"
import * as schema from "./schema"

type VaultShare = {
  orgId: string
  collectionIds: string[]
  payload: string
  attachments: {
    id: string
    fileName: string
    key: string
    size: number
  }[]
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let different = 0
  for (let i = 0; i < a.length; i++)
    different |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return different === 0
}

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

  private assertVaultActive() {
    const deleted = this.db
      .select({ key: schema.setting.key })
      .from(schema.setting)
      .where(eq(schema.setting.key, "vault:deleted"))
      .get()
    if (deleted) throw new Error("Vault has been deleted")
  }

  async clearPersonalVault() {
    this.db.transaction((tx) => {
      tx.insert(schema.setting)
        .values({ key: "vault:deleted", value: "true", updatedAt: new Date() })
        .onConflictDoNothing()
        .run()
      tx.delete(schema.vaultAttachmentToken).run()
      tx.delete(schema.vaultAttachment).run()
      tx.delete(schema.vaultSendDownloadToken).run()
      tx.delete(schema.vaultSendToken).run()
      tx.delete(schema.vaultSend).run()
      tx.delete(schema.vaultCipher).run()
      tx.delete(schema.vaultFolder).run()
      tx.delete(schema.setting)
        .where(like(schema.setting.key, "vault:share:%"))
        .run()
    })
  }

  // The caller selects this object by the authenticated user's ID. All vault
  // mutations below are synchronous SQLite operations with no intervening
  // await, so a read/check/write cannot interleave with another request.
  async listVault() {
    this.assertVaultActive()
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

  async importVault(
    folders: { id: string | null; name: string }[],
    ciphers: { payload: string; folderIndex: number | null }[]
  ) {
    this.assertVaultActive()
    const now = new Date()
    const folderIds: string[] = []
    this.db.transaction((tx) => {
      for (const folder of folders) {
        const existing = folder.id
          ? tx
              .select({ id: schema.vaultFolder.id })
              .from(schema.vaultFolder)
              .where(eq(schema.vaultFolder.id, folder.id))
              .get()
          : null
        const id = existing?.id ?? crypto.randomUUID()
        folderIds.push(id)
        if (!existing)
          tx.insert(schema.vaultFolder)
            .values({
              id,
              name: folder.name,
              revision: 1,
              createdAt: now,
              updatedAt: now,
            })
            .run()
      }
      for (const cipher of ciphers) {
        const payload = JSON.parse(cipher.payload) as Record<string, unknown>
        payload.folderId =
          cipher.folderIndex === null ? null : folderIds[cipher.folderIndex]!
        tx.insert(schema.vaultCipher)
          .values({
            id: crypto.randomUUID(),
            payload: JSON.stringify(payload),
            revision: 1,
            createdAt: now,
            updatedAt: now,
          })
          .run()
      }
    })
  }

  async vaultRevision() {
    this.assertVaultActive()
    const ciphers = this.db.select().from(schema.vaultCipher).all()
    const folders = this.db.select().from(schema.vaultFolder).all()
    const sends = this.db.select().from(schema.vaultSend).all()
    let latest = 0
    for (const cipher of ciphers)
      latest = Math.max(latest, cipher.updatedAt.getTime())
    for (const folder of folders)
      latest = Math.max(latest, folder.updatedAt.getTime())
    for (const send of sends)
      latest = Math.max(latest, send.updatedAt.getTime())
    return latest
  }

  async listVaultSends() {
    this.assertVaultActive()
    return this.db.select().from(schema.vaultSend).all()
  }

  async getVaultSend(id: string) {
    this.assertVaultActive()
    return (
      this.db
        .select()
        .from(schema.vaultSend)
        .where(eq(schema.vaultSend.id, id))
        .get() ?? null
    )
  }

  async getVaultSendPasswordSalt(id: string) {
    this.assertVaultActive()
    return (
      this.db
        .select({ salt: schema.vaultSend.passwordSalt })
        .from(schema.vaultSend)
        .where(eq(schema.vaultSend.id, id))
        .get()?.salt ?? null
    )
  }

  async putVaultSend(
    id: string,
    input: {
      payload: string
      maxAccessCount: number | null
      expirationAt: Date | null
      deletionAt: Date
      disabled: boolean
      password: { hash: string; salt: string } | null | undefined
      uploaded?: boolean
    }
  ) {
    this.assertVaultActive()
    const existing = this.db
      .select()
      .from(schema.vaultSend)
      .where(eq(schema.vaultSend.id, id))
      .get()
    const now = new Date()
    const values = {
      payload: input.payload,
      maxAccessCount: input.maxAccessCount,
      expirationAt: input.expirationAt,
      deletionAt: input.deletionAt,
      disabled: input.disabled,
      uploaded: input.uploaded ?? existing?.uploaded ?? true,
      passwordHash:
        input.password === undefined
          ? (existing?.passwordHash ?? null)
          : (input.password?.hash ?? null),
      passwordSalt:
        input.password === undefined
          ? (existing?.passwordSalt ?? null)
          : (input.password?.salt ?? null),
      updatedAt: now,
    }
    if (existing)
      return this.db
        .update(schema.vaultSend)
        .set(values)
        .where(eq(schema.vaultSend.id, id))
        .returning()
        .get()
    return this.db
      .insert(schema.vaultSend)
      .values({ id, ...values, createdAt: now })
      .returning()
      .get()
  }

  async removeVaultSendPassword(id: string) {
    this.assertVaultActive()
    return (
      this.db
        .update(schema.vaultSend)
        .set({ passwordHash: null, passwordSalt: null, updatedAt: new Date() })
        .where(eq(schema.vaultSend.id, id))
        .returning()
        .get() ?? null
    )
  }

  async deleteVaultSend(id: string) {
    this.assertVaultActive()
    return this.db.transaction((tx) => {
      tx.delete(schema.vaultSendToken)
        .where(eq(schema.vaultSendToken.sendId, id))
        .run()
      tx.delete(schema.vaultSendDownloadToken)
        .where(eq(schema.vaultSendDownloadToken.sendId, id))
        .run()
      return !!tx
        .delete(schema.vaultSend)
        .where(eq(schema.vaultSend.id, id))
        .returning({ id: schema.vaultSend.id })
        .get()
    })
  }

  async issueVaultSendAccess(
    id: string,
    passwordHash: string | null,
    tokenHash: string
  ) {
    this.assertVaultActive()
    const send = this.db
      .select()
      .from(schema.vaultSend)
      .where(eq(schema.vaultSend.id, id))
      .get()
    if (!send || !this.vaultSendAccessible(send)) return "unavailable" as const
    if (!send.uploaded) return "unavailable" as const
    if (send.maxAccessCount !== null && send.accessCount >= send.maxAccessCount)
      return "unavailable" as const
    if (send.passwordHash) {
      if (!passwordHash) return "password_required" as const
      if (!constantTimeEqual(send.passwordHash, passwordHash))
        return "password_invalid" as const
    }
    const now = new Date()
    this.db.transaction((tx) => {
      tx.update(schema.vaultSend)
        .set({ accessCount: send.accessCount + 1, updatedAt: now })
        .where(eq(schema.vaultSend.id, id))
        .run()
      tx.delete(schema.vaultSendToken)
        .where(lt(schema.vaultSendToken.expiresAt, now))
        .run()
      tx.insert(schema.vaultSendToken)
        .values({
          hash: tokenHash,
          sendId: id,
          expiresAt: new Date(now.getTime() + 120_000),
        })
        .run()
    })
    return "ok" as const
  }

  async accessVaultSend(id: string, tokenHash: string) {
    this.assertVaultActive()
    const token = this.db
      .select()
      .from(schema.vaultSendToken)
      .where(eq(schema.vaultSendToken.hash, tokenHash))
      .get()
    if (
      !token ||
      token.sendId !== id ||
      token.expiresAt.getTime() <= Date.now()
    )
      return null
    const send = this.db
      .select()
      .from(schema.vaultSend)
      .where(eq(schema.vaultSend.id, id))
      .get()
    return send && send.uploaded && this.vaultSendAccessible(send) ? send : null
  }

  async completeVaultSendFile(
    id: string,
    fileId: string,
    size: number,
    name: string
  ) {
    this.assertVaultActive()
    const send = this.db
      .select()
      .from(schema.vaultSend)
      .where(eq(schema.vaultSend.id, id))
      .get()
    if (!send || send.uploaded) return false
    const data = JSON.parse(send.payload) as {
      type?: number
      file?: { id?: string; size?: number; fileName?: string }
    }
    if (
      data.type !== 1 ||
      data.file?.id !== fileId ||
      data.file.size !== size ||
      data.file.fileName !== name
    )
      return false
    this.db
      .update(schema.vaultSend)
      .set({ uploaded: true, updatedAt: new Date() })
      .where(eq(schema.vaultSend.id, id))
      .run()
    return true
  }

  async issueVaultSendDownload(id: string, fileId: string, hash: string) {
    this.assertVaultActive()
    const send = this.db
      .select()
      .from(schema.vaultSend)
      .where(eq(schema.vaultSend.id, id))
      .get()
    if (!send || !send.uploaded || !this.vaultSendAccessible(send)) return false
    const data = JSON.parse(send.payload) as {
      type?: number
      file?: { id?: string }
    }
    if (data.type !== 1 || data.file?.id !== fileId) return false
    this.db
      .insert(schema.vaultSendDownloadToken)
      .values({
        hash,
        sendId: id,
        fileId,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      })
      .run()
    return true
  }

  async validateVaultSendDownload(id: string, fileId: string, hash: string) {
    this.assertVaultActive()
    const token = this.db
      .select()
      .from(schema.vaultSendDownloadToken)
      .where(eq(schema.vaultSendDownloadToken.hash, hash))
      .get()
    if (
      !token ||
      token.sendId !== id ||
      token.fileId !== fileId ||
      token.expiresAt.getTime() <= Date.now()
    )
      return false
    const send = this.db
      .select()
      .from(schema.vaultSend)
      .where(eq(schema.vaultSend.id, id))
      .get()
    return !!send && send.uploaded && this.vaultSendAccessible(send)
  }

  private vaultSendAccessible(send: typeof schema.vaultSend.$inferSelect) {
    const now = Date.now()
    return (
      !send.disabled &&
      send.deletionAt.getTime() > now &&
      (send.expirationAt === null || send.expirationAt.getTime() > now)
    )
  }

  async getVaultCipher(id: string) {
    this.assertVaultActive()
    return (
      this.db
        .select()
        .from(schema.vaultCipher)
        .where(eq(schema.vaultCipher.id, id))
        .get() ?? null
    )
  }

  private vaultShareKey(id: string) {
    return `vault:share:${id}`
  }

  private assertCipherNotSharing(id: string) {
    if (
      this.db
        .select({ key: schema.setting.key })
        .from(schema.setting)
        .where(eq(schema.setting.key, this.vaultShareKey(id)))
        .get()
    )
      throw new Error("Cipher transfer is in progress")
  }

  async prepareVaultShare(
    id: string,
    input: {
      orgId: string
      collectionIds: string[]
      payload: string
      attachmentKeys: Record<string, { fileName: string; key: string }>
      lastKnownRevisionDate?: string
    }
  ) {
    this.assertVaultActive()
    if (input.payload.length > 1_000_000) return "invalid" as const
    const source = this.db
      .select()
      .from(schema.vaultCipher)
      .where(eq(schema.vaultCipher.id, id))
      .get()
    if (!source || source.deletedAt) return "missing" as const
    if (
      input.lastKnownRevisionDate &&
      (Number.isNaN(Date.parse(input.lastKnownRevisionDate)) ||
        source.updatedAt.getTime() - Date.parse(input.lastKnownRevisionDate) >
          1000)
    )
      return "conflict" as const
    const attachments = this.db
      .select()
      .from(schema.vaultAttachment)
      .where(eq(schema.vaultAttachment.cipherId, id))
      .all()
    if (attachments.some((attachment) => !attachment.uploaded))
      return "busy" as const
    const sharedAttachments: VaultShare["attachments"] = []
    for (const attachment of attachments) {
      const rotated = input.attachmentKeys[attachment.id]
      if (!rotated?.fileName || !rotated.key) return "invalid" as const
      sharedAttachments.push({
        id: attachment.id,
        fileName: rotated.fileName,
        key: rotated.key,
        size: attachment.size,
      })
    }
    const snapshot: VaultShare = {
      orgId: input.orgId,
      collectionIds: input.collectionIds,
      payload: input.payload,
      attachments: sharedAttachments,
    }
    const stored = this.db
      .insert(schema.setting)
      .values({
        key: this.vaultShareKey(id),
        value: JSON.stringify(snapshot),
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ key: schema.setting.key })
      .get()
    return stored ? ("prepared" as const) : ("busy" as const)
  }

  async getVaultShare(id: string): Promise<VaultShare | null> {
    const stored = this.db
      .select({ value: schema.setting.value })
      .from(schema.setting)
      .where(eq(schema.setting.key, this.vaultShareKey(id)))
      .get()
    return stored ? (JSON.parse(stored.value) as VaultShare) : null
  }

  async finishVaultShare(id: string) {
    this.assertVaultActive()
    this.db.transaction((tx) => {
      const share = tx
        .select({ key: schema.setting.key })
        .from(schema.setting)
        .where(eq(schema.setting.key, this.vaultShareKey(id)))
        .get()
      if (!share) throw new Error("Cipher transfer is unavailable")
      const attachments = tx
        .select({ id: schema.vaultAttachment.id })
        .from(schema.vaultAttachment)
        .where(eq(schema.vaultAttachment.cipherId, id))
        .all()
      for (const attachment of attachments)
        tx.delete(schema.vaultAttachmentToken)
          .where(eq(schema.vaultAttachmentToken.attachmentId, attachment.id))
          .run()
      tx.delete(schema.vaultAttachment)
        .where(eq(schema.vaultAttachment.cipherId, id))
        .run()
      tx.delete(schema.vaultCipher).where(eq(schema.vaultCipher.id, id)).run()
    })
  }

  async clearVaultShare(id: string) {
    this.db
      .delete(schema.setting)
      .where(eq(schema.setting.key, this.vaultShareKey(id)))
      .run()
  }

  async stageSharedCipher(
    id: string,
    payload: string,
    attachments: VaultShare["attachments"]
  ) {
    this.assertVaultActive()
    if (!id || payload.length > 1_000_000) throw new Error("Invalid cipher")
    const now = new Date()
    this.db.transaction((tx) => {
      tx.insert(schema.vaultCipher)
        .values({ id, payload, revision: 1, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .run()
      for (const attachment of attachments)
        tx.insert(schema.vaultAttachment)
          .values({
            ...attachment,
            cipherId: id,
            uploaded: true,
            createdAt: now,
          })
          .onConflictDoNothing()
          .run()
    })
  }

  async removeUnpublishedSharedCipher(id: string) {
    this.db.transaction((tx) => {
      tx.delete(schema.vaultAttachment)
        .where(eq(schema.vaultAttachment.cipherId, id))
        .run()
      tx.delete(schema.vaultCipher).where(eq(schema.vaultCipher.id, id)).run()
    })
  }

  async putVaultCipher(
    id: string,
    payload: string,
    expectedRevision?: number,
    lastKnownRevisionDate?: string
  ) {
    this.assertVaultActive()
    this.assertCipherNotSharing(id)
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
    this.assertVaultActive()
    this.assertCipherNotSharing(id)
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
    this.assertVaultActive()
    this.assertCipherNotSharing(id)
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
    this.assertVaultActive()
    return (
      this.db
        .select()
        .from(schema.vaultFolder)
        .where(eq(schema.vaultFolder.id, id))
        .get() ?? null
    )
  }

  async putVaultFolder(id: string, name: string, expectedRevision?: number) {
    this.assertVaultActive()
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
    this.assertVaultActive()
    for (const cipher of this.db.select().from(schema.vaultCipher).all()) {
      const payload = JSON.parse(cipher.payload) as Record<string, unknown>
      const folderKey = Object.keys(payload).find(
        (key) => key.toLowerCase() === "folderid"
      )
      if (folderKey && payload[folderKey] === id)
        this.assertCipherNotSharing(cipher.id)
    }
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
    this.assertVaultActive()
    this.assertCipherNotSharing(input.cipherId)
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
    this.assertVaultActive()
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
    this.assertVaultActive()
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
    this.assertVaultActive()
    this.assertCipherNotSharing(cipherId)
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
    this.assertVaultActive()
    this.assertCipherNotSharing(cipherId)
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

  async issueVaultAttachmentToken(
    id: string,
    cipherId: string,
    userId: string
  ) {
    this.assertVaultActive()
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
        userId,
        expiresAt: new Date(Date.now() + 5 * 60_000),
      })
      .run()
    return token
  }

  async validateVaultAttachmentToken(
    id: string,
    cipherId: string,
    token: string,
    userId: string
  ) {
    this.assertVaultActive()
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
      grant.userId === userId &&
      grant.expiresAt.getTime() > Date.now()
    )
  }
}
