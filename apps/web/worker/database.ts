import { issueAttachmentToken, verifyAttachmentToken } from "./attachment-token"
import { DurableObject } from "cloudflare:workers"
import { and, eq, gte, like, lt } from "drizzle-orm"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { migrate } from "drizzle-orm/durable-sqlite/migrator"

import migrations from "../drizzle/migrations.js"
import * as schema from "./schema"
import { attachmentBody, renderCipherOpen, serveCipher } from "./cipher-render"
import {
  notificationFrame,
  notificationPing,
  type VaultNotification,
} from "./bitwarden-notifications"
import { MAX_FILE_BYTES } from "./file-limits"

type VaultShare = {
  orgId: string
  collectionIds: string[]
  payload: string
  userId: string
  archivedDate: string | null
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

  async fetch(request: Request) {
    const url = new URL(request.url)
    const path = url.pathname
    if (
      (path !== "/notifications/hub" &&
        path !== "/notifications/anonymous-hub") ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    )
      return new Response("Not found", { status: 404 })
    const maximum = path === "/notifications/anonymous-hub" ? 25 : 100
    if (this.ctx.getWebSockets().length >= maximum)
      return new Response("Too many connections", { status: 429 })
    const expiresAt = Number(url.searchParams.get("expiresAt"))
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + 60 * 60_000
    )
      return new Response("Invalid connection lifetime", { status: 400 })
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({
      kind: path === "/notifications/hub" ? "user" : "anonymous",
      expiresAt,
      sessionId: request.headers.get("X-Cloudwarden-Session-Id"),
    })
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 15_000)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === "string") {
      try {
        const initial = JSON.parse(
          message.endsWith(String.fromCharCode(30))
            ? message.slice(0, -1)
            : message
        ) as {
          protocol?: string
          version?: number
        }
        if (initial.protocol === "messagepack" && initial.version === 1) {
          socket.send(new Uint8Array([0x7b, 0x7d, 0x1e]))
          return
        }
      } catch {
        // Ignore unsupported SignalR messages.
      }
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    socket.close(code, reason)
  }

  async alarm() {
    if (this.env.MAINTENANCE_MODE === "true") {
      for (const socket of this.ctx.getWebSockets())
        socket.close(1012, "Vault maintenance")
      const hasPendingDeletes = !!this.db
        .select({ key: schema.setting.key })
        .from(schema.setting)
        .where(like(schema.setting.key, "vault:delete:cipher:%"))
        .limit(1)
        .get()
      if (hasPendingDeletes)
        await this.ctx.storage.setAlarm(Date.now() + 60_000)
      return
    }
    const sockets = this.ctx.getWebSockets()
    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment() as {
        expiresAt?: number
      } | null
      if (!attachment?.expiresAt || attachment.expiresAt <= Date.now()) {
        socket.close(1000, "Session expired")
        continue
      }
      try {
        socket.send(notificationPing)
      } catch {
        socket.close(1011, "Send failed")
      }
    }
    const pendingDeletes = this.db
      .select()
      .from(schema.setting)
      .where(like(schema.setting.key, "vault:delete:cipher:%"))
      .limit(10)
      .all()
    for (const pending of pendingDeletes) {
      try {
        const found = await this.env.VAULT_ATTACHMENTS.list({
          prefix: pending.value,
          limit: 1000,
        })
        if (found.objects.length)
          await this.env.VAULT_ATTACHMENTS.delete(
            found.objects.map((object) => object.key)
          )
        if (!found.truncated)
          this.db
            .delete(schema.setting)
            .where(eq(schema.setting.key, pending.key))
            .run()
      } catch {
        console.error("Cipher attachment cleanup will retry")
      }
    }
    const hasPendingDeletes = !!this.db
      .select({ key: schema.setting.key })
      .from(schema.setting)
      .where(like(schema.setting.key, "vault:delete:cipher:%"))
      .limit(1)
      .get()
    if (this.ctx.getWebSockets().length || hasPendingDeletes)
      await this.ctx.storage.setAlarm(Date.now() + 15_000)
  }

  async publishVaultNotification(event: VaultNotification) {
    const frame = notificationFrame(event)
    const kind = event.anonymous ? "anonymous" : "user"
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as {
        kind?: string
        expiresAt?: number
        sessionId?: string | null
      } | null
      if (attachment?.kind !== kind) continue
      if (!attachment.expiresAt || attachment.expiresAt <= Date.now()) {
        socket.close(1000, "Session expired")
        continue
      }
      if (
        kind === "user" &&
        event.type !== 11 &&
        (!attachment.sessionId ||
          !event.activeSessionIds?.includes(attachment.sessionId))
      ) {
        socket.close(1000, "Session revoked")
        continue
      }
      try {
        socket.send(frame)
      } catch {
        socket.close(1011, "Send failed")
      }
      if (event.type === 11) socket.close(1000, "Signed out")
    }
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
    this.db
      .select({ id: schema.vaultCipher.id })
      .from(schema.vaultCipher)
      .limit(1)
      .all()
    this.db
      .select({ id: schema.vaultAttachment.id })
      .from(schema.vaultAttachment)
      .limit(1)
      .all()
    return { ok: true as const }
  }

  async recoveryBookmarksAt(timestamp: number) {
    if (!Number.isSafeInteger(timestamp) || timestamp > Date.now())
      throw new Error("Invalid recovery timestamp")
    return {
      current: await this.ctx.storage.getCurrentBookmark(),
      target: await this.ctx.storage.getBookmarkForTime(timestamp),
    }
  }

  async scheduleRecoveryBookmark(bookmark: string) {
    if (!/^[a-zA-Z0-9-]{16,128}$/.test(bookmark))
      throw new Error("Invalid recovery bookmark")
    return this.ctx.storage.onNextSessionRestoreBookmark(bookmark)
  }

  async restartForRecovery() {
    this.ctx.abort("Cloudwarden point-in-time recovery")
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

  private assertVaultExists() {
    const deleted = this.db
      .select({ key: schema.setting.key })
      .from(schema.setting)
      .where(eq(schema.setting.key, "vault:deleted"))
      .get()
    if (deleted) throw new Error("Vault has been deleted")
  }

  private assertVaultActive() {
    this.assertVaultExists()
    const lock = this.db
      .select({ value: schema.setting.value })
      .from(schema.setting)
      .where(eq(schema.setting.key, "vault:rotation-lock"))
      .get()
    if (lock && Number(lock.value) > Date.now())
      throw new Error("Vault key rotation is in progress")
  }

  private rotationHeldBy(token: string) {
    const held = this.db
      .select({ value: schema.setting.value })
      .from(schema.setting)
      .where(eq(schema.setting.key, "vault:rotation"))
      .get()
    return !!token && held?.value === token
  }

  private lockVaultForRotation() {
    const now = new Date()
    const value = String(now.getTime() + 60_000)
    this.db
      .insert(schema.setting)
      .values({ key: "vault:rotation-lock", value, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.setting.key,
        set: { value, updatedAt: now },
      })
      .run()
  }

  // D1 admits one rotation per account at a time, so a stage left behind
  // here belongs to an attempt that never reached D1 and can be discarded.
  async beginVaultRotation(token: string) {
    this.assertVaultExists()
    const now = new Date()
    this.db.transaction((tx) => {
      tx.delete(schema.vaultRotationStage).run()
      tx.insert(schema.setting)
        .values({ key: "vault:rotation", value: token, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.setting.key,
          set: { value: token, updatedAt: now },
        })
        .run()
    })
    this.lockVaultForRotation()
  }

  async stageVaultRotation(
    token: string,
    items: {
      kind: "cipher" | "folder" | "send" | "attachment"
      id: string
      payload: string
    }[]
  ) {
    this.assertVaultExists()
    if (!this.rotationHeldBy(token)) return false
    try {
      this.db.transaction((tx) => {
        for (const item of items)
          tx.insert(schema.vaultRotationStage).values(item).run()
      })
    } catch {
      // A repeated ID would otherwise let one item shadow another.
      return false
    }
    return true
  }

  async sealVaultRotation(token: string) {
    this.assertVaultExists()
    if (!this.rotationHeldBy(token)) return "expired" as const
    if (
      this.db
        .select({ key: schema.setting.key })
        .from(schema.setting)
        .where(like(schema.setting.key, "vault:share:%"))
        .get()
    )
      return "sharing" as const
    const staged = new Map<string, Set<string>>()
    for (const row of this.db
      .select({
        kind: schema.vaultRotationStage.kind,
        id: schema.vaultRotationStage.id,
      })
      .from(schema.vaultRotationStage)
      .all()) {
      const ids = staged.get(row.kind) ?? new Set<string>()
      ids.add(row.id)
      staged.set(row.kind, ids)
    }
    const complete = (kind: string, existing: { id: string }[]) => {
      const ids = staged.get(kind) ?? new Set<string>()
      return (
        ids.size === existing.length && existing.every((row) => ids.has(row.id))
      )
    }
    const attachments = this.db
      .select({
        id: schema.vaultAttachment.id,
        key: schema.vaultAttachment.key,
      })
      .from(schema.vaultAttachment)
      .where(eq(schema.vaultAttachment.uploaded, true))
      .all()
    // An attachment without its own key is encrypted under the user key
    // itself and cannot be carried across a rotation.
    if (attachments.some((attachment) => !attachment.key))
      return "legacy-attachments" as const
    if (
      !complete(
        "cipher",
        this.db
          .select({ id: schema.vaultCipher.id })
          .from(schema.vaultCipher)
          .all()
      ) ||
      !complete(
        "folder",
        this.db
          .select({ id: schema.vaultFolder.id })
          .from(schema.vaultFolder)
          .all()
      ) ||
      !complete(
        "send",
        this.db.select({ id: schema.vaultSend.id }).from(schema.vaultSend).all()
      ) ||
      !complete("attachment", attachments)
    )
      return "incomplete" as const
    this.lockVaultForRotation()
    return "ready" as const
  }

  async abortVaultRotation(token: string) {
    if (!this.rotationHeldBy(token)) return
    this.db.transaction((tx) => {
      tx.delete(schema.vaultRotationStage).run()
      tx.delete(schema.setting)
        .where(eq(schema.setting.key, "vault:rotation"))
        .run()
      tx.delete(schema.setting)
        .where(eq(schema.setting.key, "vault:rotation-lock"))
        .run()
    })
  }

  // Safe to repeat: once applied, the token no longer matches.
  async commitVaultRotation(token: string) {
    this.assertVaultExists()
    if (!this.rotationHeldBy(token)) return false
    const now = new Date()
    this.db.transaction((tx) => {
      for (const item of tx.select().from(schema.vaultRotationStage).all()) {
        if (item.kind === "cipher") {
          const existing = tx
            .select({ revision: schema.vaultCipher.revision })
            .from(schema.vaultCipher)
            .where(eq(schema.vaultCipher.id, item.id))
            .get()
          if (existing)
            tx.update(schema.vaultCipher)
              .set({
                payload: item.payload,
                revision: existing.revision + 1,
                updatedAt: now,
              })
              .where(eq(schema.vaultCipher.id, item.id))
              .run()
        } else if (item.kind === "folder") {
          const existing = tx
            .select({ revision: schema.vaultFolder.revision })
            .from(schema.vaultFolder)
            .where(eq(schema.vaultFolder.id, item.id))
            .get()
          if (existing)
            tx.update(schema.vaultFolder)
              .set({
                name: item.payload,
                revision: existing.revision + 1,
                updatedAt: now,
              })
              .where(eq(schema.vaultFolder.id, item.id))
              .run()
        } else if (item.kind === "send") {
          const existing = tx
            .select({ payload: schema.vaultSend.payload })
            .from(schema.vaultSend)
            .where(eq(schema.vaultSend.id, item.id))
            .get()
          if (existing)
            tx.update(schema.vaultSend)
              .set({
                payload: JSON.stringify({
                  ...(JSON.parse(existing.payload) as Record<string, unknown>),
                  ...(JSON.parse(item.payload) as Record<string, unknown>),
                }),
                updatedAt: now,
              })
              .where(eq(schema.vaultSend.id, item.id))
              .run()
        } else if (item.kind === "attachment") {
          const next = JSON.parse(item.payload) as {
            fileName: string
            key: string
          }
          tx.update(schema.vaultAttachment)
            .set({ fileName: next.fileName, key: next.key })
            .where(eq(schema.vaultAttachment.id, item.id))
            .run()
        }
      }
      tx.delete(schema.vaultRotationStage).run()
      tx.delete(schema.setting)
        .where(eq(schema.setting.key, "vault:rotation"))
        .run()
      tx.delete(schema.setting)
        .where(eq(schema.setting.key, "vault:rotation-lock"))
        .run()
    })
    return true
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
      tx.delete(schema.setting)
        .where(
          and(
            gte(schema.setting.key, "vault:send-otp:"),
            lt(schema.setting.key, "vault:send-otp;")
          )
        )
        .run()
      tx.delete(schema.vaultSend).run()
      tx.delete(schema.vaultCipherPreference).run()
      tx.delete(schema.vaultCipherArchive).run()
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
    ciphers: {
      payload: string
      folderIndex: number | null
      archivedDate: string | null
    }[],
    userId: string
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
        const id = crypto.randomUUID()
        tx.insert(schema.vaultCipher)
          .values({
            id,
            payload: JSON.stringify(payload),
            revision: 1,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        if (cipher.archivedDate)
          tx.insert(schema.vaultCipherArchive)
            .values({
              cipherId: id,
              userId,
              archivedAt: new Date(cipher.archivedDate),
            })
            .run()
      }
    })
  }

  // The newest change in this vault, as epoch ms. Clients poll it to decide
  // whether to sync, so it reads only timestamps, never the payloads.
  async vaultRevision() {
    this.assertVaultActive()
    const row = this.ctx.storage.sql
      .exec<{ latest: number }>(
        `SELECT max(
          coalesce((SELECT max(updated_at) FROM vault_cipher), 0),
          coalesce((SELECT max(updated_at) FROM vault_folder), 0),
          coalesce((SELECT max(updated_at) FROM vault_send), 0),
          coalesce((SELECT max(updated_at) FROM setting WHERE key IN (
            'vault:archive-revision', 'vault:preference-revision', 'vault:purge-revision'
          )), 0)
        ) AS latest`
      )
      .one()
    return row.latest
  }

  async getVaultCipherPreference(id: string) {
    this.assertVaultActive()
    return (
      this.db
        .select()
        .from(schema.vaultCipherPreference)
        .where(eq(schema.vaultCipherPreference.cipherId, id))
        .get() ?? null
    )
  }

  async setVaultCipherPreference(
    id: string,
    folderId?: string | null,
    favorite?: boolean
  ) {
    this.assertVaultActive()
    return this.db.transaction((tx) => {
      const current = tx
        .select()
        .from(schema.vaultCipherPreference)
        .where(eq(schema.vaultCipherPreference.cipherId, id))
        .get()
      const selectedFolder =
        folderId === undefined ? (current?.folderId ?? null) : folderId
      const selectedFavorite =
        favorite === undefined ? (current?.favorite ?? false) : favorite
      if (
        selectedFolder &&
        !tx
          .select({ id: schema.vaultFolder.id })
          .from(schema.vaultFolder)
          .where(eq(schema.vaultFolder.id, selectedFolder))
          .get()
      )
        return false
      const previous = tx
        .select({ updatedAt: schema.setting.updatedAt })
        .from(schema.setting)
        .where(eq(schema.setting.key, "vault:preference-revision"))
        .get()
      const now = new Date(
        Math.max(Date.now(), (previous?.updatedAt.getTime() ?? 0) + 1)
      )
      tx.insert(schema.vaultCipherPreference)
        .values({
          cipherId: id,
          folderId: selectedFolder,
          favorite: selectedFavorite,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.vaultCipherPreference.cipherId,
          set: {
            folderId: selectedFolder,
            favorite: selectedFavorite,
            updatedAt: now,
          },
        })
        .run()
      tx.insert(schema.setting)
        .values({
          key: "vault:preference-revision",
          value: "1",
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.setting.key,
          set: { updatedAt: now },
        })
        .run()
      return true
    })
  }

  async getVaultCipherArchivedAt(id: string, userId: string) {
    this.assertVaultActive()
    return (
      this.db
        .select({ archivedAt: schema.vaultCipherArchive.archivedAt })
        .from(schema.vaultCipherArchive)
        .where(
          and(
            eq(schema.vaultCipherArchive.cipherId, id),
            eq(schema.vaultCipherArchive.userId, userId)
          )
        )
        .get()?.archivedAt ?? null
    )
  }

  async setVaultCipherArchived(id: string, userId: string, archived: boolean) {
    this.assertVaultActive()
    this.assertCipherNotSharing(id)
    const cipher = this.db
      .select()
      .from(schema.vaultCipher)
      .where(eq(schema.vaultCipher.id, id))
      .get()
    if (!cipher || cipher.deletedAt) return null
    const now = new Date()
    this.db.transaction((tx) => {
      if (archived)
        tx.insert(schema.vaultCipherArchive)
          .values({ cipherId: id, userId, archivedAt: now })
          .onConflictDoUpdate({
            target: [
              schema.vaultCipherArchive.cipherId,
              schema.vaultCipherArchive.userId,
            ],
            set: { archivedAt: now },
          })
          .run()
      else
        tx.delete(schema.vaultCipherArchive)
          .where(
            and(
              eq(schema.vaultCipherArchive.cipherId, id),
              eq(schema.vaultCipherArchive.userId, userId)
            )
          )
          .run()
      tx.insert(schema.setting)
        .values({ key: "vault:archive-revision", value: "1", updatedAt: now })
        .onConflictDoUpdate({
          target: schema.setting.key,
          set: { updatedAt: now },
        })
        .run()
    })
    return cipher
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

  async getVaultSendAuthentication(id: string) {
    this.assertVaultActive()
    const send = this.db
      .select()
      .from(schema.vaultSend)
      .where(eq(schema.vaultSend.id, id))
      .get()
    if (
      !send ||
      !send.uploaded ||
      !this.vaultSendAccessible(send) ||
      (send.maxAccessCount !== null && send.accessCount >= send.maxAccessCount)
    )
      return null
    const data = JSON.parse(send.payload) as { authType?: number }
    return {
      authType: data.authType === 0 ? 0 : send.passwordHash ? 1 : 2,
      salt: send.passwordSalt,
    }
  }

  private vaultSendEmailAllowed(
    send: typeof schema.vaultSend.$inferSelect,
    email: string
  ) {
    const data = JSON.parse(send.payload) as {
      authType?: number
      emails?: string
    }
    return (
      data.authType === 0 &&
      !!email &&
      !!data.emails?.split(",").includes(email)
    )
  }

  async prepareVaultSendOtp(id: string, email: string, hash: string) {
    this.assertVaultActive()
    const send = this.db
      .select()
      .from(schema.vaultSend)
      .where(eq(schema.vaultSend.id, id))
      .get()
    if (
      !send ||
      !send.uploaded ||
      !this.vaultSendAccessible(send) ||
      (send.maxAccessCount !== null &&
        send.accessCount >= send.maxAccessCount) ||
      !this.vaultSendEmailAllowed(send, email)
    )
      return false
    const now = Date.now()
    this.db
      .delete(schema.setting)
      .where(
        and(
          like(schema.setting.key, "vault:send-otp:%"),
          lt(schema.setting.updatedAt, new Date(now - 10 * 60_000))
        )
      )
      .run()
    const key = `vault:send-otp:${id}:${email}`
    const existing = this.db
      .select()
      .from(schema.setting)
      .where(eq(schema.setting.key, key))
      .get()
    if (existing && now - existing.updatedAt.getTime() < 30_000) return false
    this.db
      .insert(schema.setting)
      .values({
        key,
        value: JSON.stringify({
          hash,
          expiresAt: now + 10 * 60_000,
          attempts: 0,
        }),
        updatedAt: new Date(now),
      })
      .onConflictDoUpdate({
        target: schema.setting.key,
        set: {
          value: JSON.stringify({
            hash,
            expiresAt: now + 10 * 60_000,
            attempts: 0,
          }),
          updatedAt: new Date(now),
        },
      })
      .run()
    return true
  }

  async cancelVaultSendOtp(id: string, email: string, hash: string) {
    this.assertVaultActive()
    const key = `vault:send-otp:${id}:${email}`
    const row = this.db
      .select()
      .from(schema.setting)
      .where(eq(schema.setting.key, key))
      .get()
    if (row && (JSON.parse(row.value) as { hash: string }).hash === hash)
      this.db.delete(schema.setting).where(eq(schema.setting.key, key)).run()
  }

  async canShareVaultCipher(id: string, userId: string) {
    this.assertVaultActive()
    const cipher = this.db
      .select()
      .from(schema.vaultCipher)
      .where(eq(schema.vaultCipher.id, id))
      .get()
    const archived = this.db
      .select()
      .from(schema.vaultCipherArchive)
      .where(
        and(
          eq(schema.vaultCipherArchive.cipherId, id),
          eq(schema.vaultCipherArchive.userId, userId)
        )
      )
      .get()
    return (
      !!cipher &&
      !cipher.deletedAt &&
      !archived &&
      (JSON.parse(cipher.payload) as { type: number }).type !== 5
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
      return this.db.transaction((tx) => {
        // A previously authenticated recipient must not retain access after
        // the owner changes authentication or the encrypted Send contents.
        tx.delete(schema.vaultSendToken)
          .where(eq(schema.vaultSendToken.sendId, id))
          .run()
        tx.delete(schema.vaultSendDownloadToken)
          .where(eq(schema.vaultSendDownloadToken.sendId, id))
          .run()
        tx.delete(schema.setting)
          .where(
            and(
              gte(schema.setting.key, `vault:send-otp:${id}:`),
              lt(schema.setting.key, `vault:send-otp:${id};`)
            )
          )
          .run()
        return tx
          .update(schema.vaultSend)
          .set(values)
          .where(eq(schema.vaultSend.id, id))
          .returning()
          .get()!
      })
    return this.db
      .insert(schema.vaultSend)
      .values({ id, ...values, createdAt: now })
      .returning()
      .get()
  }

  async removeVaultSendPassword(id: string) {
    this.assertVaultActive()
    return this.db.transaction((tx) => {
      const row = tx
        .select()
        .from(schema.vaultSend)
        .where(eq(schema.vaultSend.id, id))
        .get()
      if (!row) return null
      const data = JSON.parse(row.payload) as Record<string, unknown>
      tx.delete(schema.vaultSendToken)
        .where(eq(schema.vaultSendToken.sendId, id))
        .run()
      tx.delete(schema.vaultSendDownloadToken)
        .where(eq(schema.vaultSendDownloadToken.sendId, id))
        .run()
      tx.delete(schema.setting)
        .where(
          and(
            gte(schema.setting.key, `vault:send-otp:${id}:`),
            lt(schema.setting.key, `vault:send-otp:${id};`)
          )
        )
        .run()
      return tx
        .update(schema.vaultSend)
        .set({
          passwordHash: null,
          passwordSalt: null,
          payload: JSON.stringify({ ...data, authType: 2, emails: null }),
          updatedAt: new Date(),
        })
        .where(eq(schema.vaultSend.id, id))
        .returning()
        .get()!
    })
  }

  async deleteVaultSend(id: string) {
    this.assertVaultActive()
    return this.db.transaction((tx) => {
      tx.delete(schema.setting)
        .where(
          and(
            gte(schema.setting.key, `vault:send-otp:${id}:`),
            lt(schema.setting.key, `vault:send-otp:${id};`)
          )
        )
        .run()
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
    tokenHash: string,
    emailProof?: { email: string; hash: string }
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
    const data = JSON.parse(send.payload) as { authType?: number }
    if (data.authType === 0) {
      if (!emailProof?.email) return "email_required" as const
      if (!this.vaultSendEmailAllowed(send, emailProof.email))
        return "email_and_otp_required" as const
      const key = `vault:send-otp:${id}:${emailProof.email}`
      const row = this.db
        .select()
        .from(schema.setting)
        .where(eq(schema.setting.key, key))
        .get()
      const proof = row
        ? (JSON.parse(row.value) as {
            hash: string
            expiresAt: number
            attempts: number
          })
        : null
      if (!proof || proof.expiresAt <= Date.now() || proof.attempts >= 5)
        return "email_and_otp_required" as const
      if (!constantTimeEqual(proof.hash, emailProof.hash)) {
        this.db
          .update(schema.setting)
          .set({
            value: JSON.stringify({ ...proof, attempts: proof.attempts + 1 }),
          })
          .where(eq(schema.setting.key, key))
          .run()
        return "email_and_otp_required" as const
      }
      this.db.delete(schema.setting).where(eq(schema.setting.key, key)).run()
    }
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
    // An unknown or expired token is told apart from an unavailable Send,
    // so a client knows to ask for a new token.
    if (
      !token ||
      token.sendId !== id ||
      token.expiresAt.getTime() <= Date.now()
    )
      return "invalid_token" as const
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

  async listVaultCiphers(ids: string[]) {
    this.assertVaultActive()
    const wanted = new Set(ids)
    return this.db
      .select()
      .from(schema.vaultCipher)
      .all()
      .filter((cipher) => wanted.has(cipher.id))
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
      userId: string
      archivedDate: string | null
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
      userId: input.userId,
      archivedDate: input.archivedDate,
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
      const source = tx
        .select({ payload: schema.vaultCipher.payload })
        .from(schema.vaultCipher)
        .where(eq(schema.vaultCipher.id, id))
        .get()
      if (source) {
        const data = JSON.parse(source.payload) as Record<string, unknown>
        const folderId = Object.entries(data).find(
          ([key]) => key.toLowerCase() === "folderid"
        )?.[1]
        const favorite =
          Object.entries(data).find(
            ([key]) => key.toLowerCase() === "favorite"
          )?.[1] === true
        if (typeof folderId === "string" || favorite)
          tx.insert(schema.vaultCipherPreference)
            .values({
              cipherId: id,
              folderId: typeof folderId === "string" ? folderId : null,
              favorite,
              updatedAt: new Date(),
            })
            .onConflictDoNothing()
            .run()
      }
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
      tx.delete(schema.vaultCipherArchive)
        .where(eq(schema.vaultCipherArchive.cipherId, id))
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
    attachments: VaultShare["attachments"],
    userId: string,
    archivedDate: string | null
  ) {
    this.assertVaultActive()
    if (!id || payload.length > 1_000_000) throw new Error("Invalid cipher")
    const now = new Date()
    this.db.transaction((tx) => {
      tx.insert(schema.vaultCipher)
        .values({ id, payload, revision: 1, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .run()
      if (archivedDate)
        tx.insert(schema.vaultCipherArchive)
          .values({ cipherId: id, userId, archivedAt: new Date(archivedDate) })
          .onConflictDoUpdate({
            target: [
              schema.vaultCipherArchive.cipherId,
              schema.vaultCipherArchive.userId,
            ],
            set: { archivedAt: new Date(archivedDate) },
          })
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
      tx.delete(schema.vaultCipherArchive)
        .where(eq(schema.vaultCipherArchive.cipherId, id))
        .run()
      tx.delete(schema.vaultCipher).where(eq(schema.vaultCipher.id, id)).run()
    })
  }

  async stageOrgImport(
    ciphers: { id: string; payload: string; archivedDate?: string | null }[],
    userId: string
  ) {
    this.assertVaultActive()
    if (
      ciphers.length > 1000 ||
      ciphers.some((cipher) => !cipher.id || cipher.payload.length > 1_000_000)
    )
      throw new Error("Invalid organization import")
    const now = new Date()
    this.db.transaction((tx) => {
      for (const cipher of ciphers)
        tx.insert(schema.vaultCipher)
          .values({
            id: cipher.id,
            payload: cipher.payload,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .run()
      for (const cipher of ciphers)
        if (cipher.archivedDate)
          tx.insert(schema.vaultCipherArchive)
            .values({
              cipherId: cipher.id,
              userId,
              archivedAt: new Date(cipher.archivedDate),
            })
            .onConflictDoNothing()
            .run()
    })
  }

  async removeUnpublishedOrgImport(ids: string[]) {
    this.db.transaction((tx) => {
      for (const id of ids) {
        tx.delete(schema.vaultAttachment)
          .where(eq(schema.vaultAttachment.cipherId, id))
          .run()
        tx.delete(schema.vaultCipherArchive)
          .where(eq(schema.vaultCipherArchive.cipherId, id))
          .run()
        tx.delete(schema.vaultCipher).where(eq(schema.vaultCipher.id, id)).run()
      }
    })
  }

  async putVaultCipher(
    id: string,
    payload: string,
    expectedRevision?: number,
    lastKnownRevisionDate?: string,
    archive?: { userId: string; archivedDate: string | null }
  ) {
    this.assertVaultActive()
    this.assertCipherNotSharing(id)
    if (!id || payload.length > 1_000_000) throw new Error("Invalid cipher")
    const now = new Date()
    return this.db.transaction((tx) => {
      const existing = tx
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
      } else if (expectedRevision !== undefined) {
        return { conflict: true as const, cipher: null }
      }
      const cipher = existing
        ? tx
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
        : tx
            .insert(schema.vaultCipher)
            .values({
              id,
              payload,
              revision: 1,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get()
      if (!cipher) return { conflict: true as const, cipher: existing ?? null }
      if (archive) {
        if (archive.archivedDate)
          tx.insert(schema.vaultCipherArchive)
            .values({
              cipherId: id,
              userId: archive.userId,
              archivedAt: new Date(archive.archivedDate),
            })
            .onConflictDoUpdate({
              target: [
                schema.vaultCipherArchive.cipherId,
                schema.vaultCipherArchive.userId,
              ],
              set: { archivedAt: new Date(archive.archivedDate) },
            })
            .run()
        else
          tx.delete(schema.vaultCipherArchive)
            .where(
              and(
                eq(schema.vaultCipherArchive.cipherId, id),
                eq(schema.vaultCipherArchive.userId, archive.userId)
              )
            )
            .run()
      }
      return { conflict: false as const, cipher }
    })
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

  async permanentlyDeleteVaultCipher(id: string, objectPrefix: string) {
    this.assertVaultActive()
    this.assertCipherNotSharing(id)
    if (!/^[0-9a-f-]{36}$/i.test(id) || !objectPrefix.endsWith(`/${id}/`))
      throw new Error("Invalid cipher deletion")
    const pendingKey = `vault:delete:cipher:${id}`
    const found = this.db.transaction((tx) => {
      const cipher = tx
        .select({ id: schema.vaultCipher.id })
        .from(schema.vaultCipher)
        .where(eq(schema.vaultCipher.id, id))
        .get()
      if (!cipher) return false
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
      tx.delete(schema.vaultCipherPreference)
        .where(eq(schema.vaultCipherPreference.cipherId, id))
        .run()
      tx.delete(schema.vaultCipherArchive)
        .where(eq(schema.vaultCipherArchive.cipherId, id))
        .run()
      tx.delete(schema.vaultCipher).where(eq(schema.vaultCipher.id, id)).run()
      tx.insert(schema.setting)
        .values({ key: pendingKey, value: objectPrefix, updatedAt: new Date() })
        .onConflictDoNothing()
        .run()
      return true
    })
    if (
      found ||
      this.db
        .select()
        .from(schema.setting)
        .where(eq(schema.setting.key, pendingKey))
        .get()
    )
      await this.scheduleCipherDeletionCleanup()
    return found
  }

  private async scheduleCipherDeletionCleanup() {
    const alarm = await this.ctx.storage.getAlarm()
    if (alarm === null || alarm > Date.now() + 15_000)
      await this.ctx.storage.setAlarm(Date.now() + 1000)
  }

  async purgePersonalVault(userId: string) {
    this.assertVaultActive()
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Invalid vault owner")
    const now = new Date(Math.max(Date.now(), (await this.vaultRevision()) + 1))
    const removed = this.db.transaction((tx) => {
      this.assertVaultActive()
      if (
        tx
          .select({ key: schema.setting.key })
          .from(schema.setting)
          .where(like(schema.setting.key, "vault:share:%"))
          .limit(1)
          .get()
      )
        return null
      const ciphers = tx
        .select({ id: schema.vaultCipher.id })
        .from(schema.vaultCipher)
        .all()
      tx.delete(schema.vaultAttachmentToken).run()
      tx.delete(schema.vaultAttachment).run()
      tx.delete(schema.vaultCipherArchive).run()
      tx.delete(schema.vaultCipher).run()
      tx.delete(schema.vaultFolder).run()
      tx.update(schema.vaultCipherPreference)
        .set({ folderId: null, updatedAt: now })
        .run()
      tx.insert(schema.setting)
        .values({ key: "vault:purge-revision", value: "1", updatedAt: now })
        .onConflictDoUpdate({
          target: schema.setting.key,
          set: { updatedAt: now },
        })
        .run()
      for (const cipher of ciphers)
        tx.insert(schema.setting)
          .values({
            key: `vault:delete:cipher:${cipher.id}`,
            value: `${userId}/${cipher.id}/`,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .run()
      return ciphers.length
    })
    if (removed === null) return { busy: true as const }
    if (removed) await this.scheduleCipherDeletionCleanup()
    return { busy: false as const, removed }
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

  async moveVaultCipherToFolder(id: string, folderId: string | null) {
    this.assertVaultActive()
    this.assertCipherNotSharing(id)
    return this.db.transaction((tx) => {
      if (
        folderId &&
        !tx
          .select({ id: schema.vaultFolder.id })
          .from(schema.vaultFolder)
          .where(eq(schema.vaultFolder.id, folderId))
          .get()
      )
        return false
      const cipher = tx
        .select()
        .from(schema.vaultCipher)
        .where(eq(schema.vaultCipher.id, id))
        .get()
      if (!cipher) return false
      const payload = JSON.parse(cipher.payload) as Record<string, unknown>
      const key = Object.keys(payload).find(
        (field) => field.toLowerCase() === "folderid"
      )
      payload[key ?? "folderId"] = folderId
      tx.update(schema.vaultCipher)
        .set({
          payload: JSON.stringify(payload),
          revision: cipher.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.vaultCipher.id, id))
        .run()
      return true
    })
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
    const previous = this.db
      .select({ updatedAt: schema.setting.updatedAt })
      .from(schema.setting)
      .where(eq(schema.setting.key, "vault:preference-revision"))
      .get()
    const now = new Date(
      Math.max(Date.now(), (previous?.updatedAt.getTime() ?? 0) + 1)
    )
    this.db
      .update(schema.vaultCipherPreference)
      .set({ folderId: null, updatedAt: now })
      .where(eq(schema.vaultCipherPreference.folderId, id))
      .run()
    this.db
      .insert(schema.setting)
      .values({ key: "vault:preference-revision", value: "1", updatedAt: now })
      .onConflictDoUpdate({
        target: schema.setting.key,
        set: { updatedAt: now },
      })
      .run()
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
      input.size > MAX_FILE_BYTES
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
    return this.db.transaction((tx) => {
      const completed = !!tx
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
      if (!completed) return false
      const cipher = tx
        .select({
          revision: schema.vaultCipher.revision,
          updatedAt: schema.vaultCipher.updatedAt,
        })
        .from(schema.vaultCipher)
        .where(eq(schema.vaultCipher.id, cipherId))
        .get()!
      tx.update(schema.vaultCipher)
        .set({
          revision: cipher.revision + 1,
          updatedAt: new Date(
            Math.max(Date.now(), cipher.updatedAt.getTime() + 1)
          ),
        })
        .where(eq(schema.vaultCipher.id, cipherId))
        .run()
      return true
    })
  }

  async deleteVaultAttachment(id: string, cipherId: string) {
    this.assertVaultActive()
    this.assertCipherNotSharing(cipherId)
    return this.db.transaction((tx) => {
      tx.delete(schema.vaultAttachmentToken)
        .where(eq(schema.vaultAttachmentToken.attachmentId, id))
        .run()
      const deleted = !!tx
        .delete(schema.vaultAttachment)
        .where(
          and(
            eq(schema.vaultAttachment.id, id),
            eq(schema.vaultAttachment.cipherId, cipherId)
          )
        )
        .returning({ id: schema.vaultAttachment.id })
        .get()
      if (!deleted) return false
      const cipher = tx
        .select({
          revision: schema.vaultCipher.revision,
          updatedAt: schema.vaultCipher.updatedAt,
        })
        .from(schema.vaultCipher)
        .where(eq(schema.vaultCipher.id, cipherId))
        .get()!
      tx.update(schema.vaultCipher)
        .set({
          revision: cipher.revision + 1,
          updatedAt: new Date(
            Math.max(Date.now(), cipher.updatedAt.getTime() + 1)
          ),
        })
        .where(eq(schema.vaultCipher.id, cipherId))
        .run()
      return true
    })
  }

  async issueVaultAttachmentToken(
    id: string,
    cipherId: string,
    userId: string
  ) {
    this.assertVaultActive()
    const attachment = await this.getVaultAttachment(id, cipherId)
    if (!attachment?.uploaded) return null
    return issueAttachmentToken(
      this.env.BETTER_AUTH_SECRET ?? "",
      id,
      cipherId,
      userId
    )
  }

  /**
   * Everything sync needs from a user's own vault, in one call: folders,
   * Sends, the user's preferences for shared ciphers, and every personal
   * cipher already rendered as JSON (worker/cipher-render.ts).
   */
  async syncVault(userId: string, origin: string) {
    this.assertVaultActive()
    const rows = this.servedCiphers()
    const details = await this.cipherDetails(
      new Set(rows.map((row) => row.id)),
      userId
    )
    return {
      folders: this.db.select().from(schema.vaultFolder).all(),
      sends: this.db.select().from(schema.vaultSend).all(),
      preferences: this.db.select().from(schema.vaultCipherPreference).all(),
      ciphers: rows.map(
        (row) =>
          `${renderCipherOpen(row, row.served, {
            organizationId: null,
            attachments: details.attachmentsFor(row.id, userId, origin),
            collectionIds: [],
            archivedAt: details.archivedAt.get(row.id) ?? null,
            edit: true,
            viewPassword: true,
          })},${row.servedPersonal}}`
      ),
    }
  }

  /**
   * An organization's ciphers that one member may see, rendered as JSON,
   * each open at the end: the caller closes it with the member's own folder
   * and favorite, which live in the member's vault (`viewerPlacement`).
   */
  async syncSharedCiphers(
    userId: string,
    origin: string,
    orgId: string,
    access: [
      string,
      { collectionIds: string[]; edit: boolean; viewPassword: boolean },
    ][]
  ) {
    this.assertVaultActive()
    const allowed = new Map(access)
    const rows = this.servedCiphers().filter((row) => allowed.has(row.id))
    const details = await this.cipherDetails(
      new Set(rows.map((row) => row.id)),
      userId
    )
    return rows.map((row) => {
      const rights = allowed.get(row.id)!
      return {
        id: row.id,
        open: renderCipherOpen(row, row.served, {
          organizationId: orgId,
          attachments: details.attachmentsFor(row.id, userId, origin, orgId),
          collectionIds: rights.collectionIds,
          archivedAt: details.archivedAt.get(row.id) ?? null,
          edit: rights.edit,
          viewPassword: rights.viewPassword,
        }),
      }
    })
  }

  /** All ciphers, with their rendered fields filled in where the cache is empty. */
  private servedCiphers() {
    const rows = this.db.select().from(schema.vaultCipher).all()
    const stale = rows.filter((row) => row.served === null)
    if (stale.length)
      this.db.transaction((tx) => {
        for (const row of stale) {
          const rendered = serveCipher(row.payload)
          row.served = rendered.served
          row.servedPersonal = rendered.servedPersonal
          tx.update(schema.vaultCipher)
            .set(rendered)
            .where(eq(schema.vaultCipher.id, row.id))
            .run()
        }
      })
    return rows as ((typeof rows)[number] & {
      served: string
      servedPersonal: string
    })[]
  }

  /** Attachments (with stateless download tokens) and archive dates for a set of ciphers. */
  private async cipherDetails(ids: Set<string>, userId: string) {
    const { attachments, archived } = await this.listVaultCipherDetails(
      [...ids],
      userId
    )
    const byCipher = new Map<string, typeof attachments>()
    for (const attachment of attachments)
      byCipher.set(attachment.cipherId, [
        ...(byCipher.get(attachment.cipherId) ?? []),
        attachment,
      ])
    return {
      archivedAt: new Map(
        archived.map((row) => [row.cipherId, row.archivedAt])
      ),
      attachmentsFor: (
        cipherId: string,
        viewer: string,
        origin: string,
        orgId?: string
      ) => {
        const list = byCipher.get(cipherId)
        return list?.length
          ? list.map((attachment) =>
              attachmentBody(
                attachment,
                attachment.token,
                viewer,
                origin,
                orgId
              )
            )
          : null
      },
    }
  }

  // One round trip for everything a list of cipher responses needs, so sync
  // costs a fixed number of calls however many ciphers the vault holds.
  async listVaultCipherDetails(cipherIds: string[], userId: string) {
    this.assertVaultActive()
    const ids = new Set(cipherIds)
    const attachments = this.db
      .select()
      .from(schema.vaultAttachment)
      .where(eq(schema.vaultAttachment.uploaded, true))
      .all()
      .filter((attachment) => ids.has(attachment.cipherId))
    const archived = this.db
      .select({
        cipherId: schema.vaultCipherArchive.cipherId,
        archivedAt: schema.vaultCipherArchive.archivedAt,
      })
      .from(schema.vaultCipherArchive)
      .where(eq(schema.vaultCipherArchive.userId, userId))
      .all()
      .filter((row) => ids.has(row.cipherId))
    const tokens = await Promise.all(
      attachments.map((attachment) =>
        issueAttachmentToken(
          this.env.BETTER_AUTH_SECRET ?? "",
          attachment.id,
          attachment.cipherId,
          userId
        )
      )
    )
    return {
      attachments: attachments.map((attachment, index) => ({
        ...attachment,
        token: tokens[index]!,
      })),
      archived,
    }
  }

  async listVaultCipherPreferences(cipherIds: string[]) {
    this.assertVaultActive()
    const ids = new Set(cipherIds)
    return this.db
      .select()
      .from(schema.vaultCipherPreference)
      .all()
      .filter((preference) => ids.has(preference.cipherId))
  }

  async validateVaultAttachmentToken(
    id: string,
    cipherId: string,
    token: string,
    userId: string
  ) {
    this.assertVaultActive()
    // Previously issued URLs remain valid for their original five-minute
    // lifetime across an upgrade. New tokens never insert a grant row.
    if (/^[-_A-Za-z0-9]{43}$/.test(token)) {
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
      if (
        !grant ||
        grant.attachmentId !== id ||
        grant.userId !== userId ||
        grant.expiresAt.getTime() <= Date.now()
      )
        return false
    } else if (
      !(await verifyAttachmentToken(
        this.env.BETTER_AUTH_SECRET ?? "",
        id,
        cipherId,
        userId,
        token
      ))
    )
      return false
    const attachment = await this.getVaultAttachment(id, cipherId)
    return !!attachment?.uploaded
  }
}
