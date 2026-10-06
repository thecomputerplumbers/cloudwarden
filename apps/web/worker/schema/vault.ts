import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

// One AppDatabase instance is selected by each vault user ID. A user's
// encrypted items and folders are serialized in that user's Durable Object.
export const vaultCipher = sqliteTable("vault_cipher", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
  revision: integer("revision").notNull(),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
})

export const vaultFolder = sqliteTable("vault_folder", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  revision: integer("revision").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
})

export const vaultAttachment = sqliteTable("vault_attachment", {
  id: text("id").primaryKey(),
  cipherId: text("cipher_id").notNull(),
  fileName: text("file_name").notNull(),
  key: text("key"),
  size: integer("size").notNull(),
  uploaded: integer("uploaded", { mode: "boolean" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
})

export const vaultAttachmentToken = sqliteTable("vault_attachment_token", {
  hash: text("hash").primaryKey(),
  attachmentId: text("attachment_id").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
})

export const vaultSend = sqliteTable("vault_send", {
  id: text("id").primaryKey(),
  payload: text("payload").notNull(),
  passwordHash: text("password_hash"),
  passwordSalt: text("password_salt"),
  accessCount: integer("access_count").notNull().default(0),
  maxAccessCount: integer("max_access_count"),
  expirationAt: integer("expiration_at", { mode: "timestamp_ms" }),
  deletionAt: integer("deletion_at", { mode: "timestamp_ms" }).notNull(),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  uploaded: integer("uploaded", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
})

export const vaultSendToken = sqliteTable("vault_send_token", {
  hash: text("hash").primaryKey(),
  sendId: text("send_id").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
})

export const vaultSendDownloadToken = sqliteTable("vault_send_download_token", {
  hash: text("hash").primaryKey(),
  sendId: text("send_id").notNull(),
  fileId: text("file_id").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
})
