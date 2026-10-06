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
