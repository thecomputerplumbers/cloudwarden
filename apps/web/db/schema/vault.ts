import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

// Bitwarden credentials are separate from the starter's browser sessions. The
// client supplies a derived master-password hash; the server stores only a
// second, salted hash of that value.
export const vaultUser = sqliteTable(
  "vault_user",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordSalt: text("password_salt").notNull(),
    key: text("key").notNull(),
    privateKey: text("private_key"),
    publicKey: text("public_key"),
    kdf: integer("kdf").notNull(),
    kdfIterations: integer("kdf_iterations").notNull(),
    kdfMemory: integer("kdf_memory"),
    kdfParallelism: integer("kdf_parallelism"),
    securityStamp: text("security_stamp").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("vault_user_email_unique").on(table.email)]
)

export const vaultSession = sqliteTable(
  "vault_session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => vaultUser.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    deviceType: text("device_type").notNull().default("unknown"),
    clientId: text("client_id").notNull().default("unknown"),
    accessHash: text("access_hash").notNull(),
    refreshHash: text("refresh_hash").notNull(),
    accessExpiresAt: integer("access_expires_at", {
      mode: "timestamp_ms",
    }).notNull(),
    refreshExpiresAt: integer("refresh_expires_at", {
      mode: "timestamp_ms",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("vault_session_access_unique").on(table.accessHash),
    uniqueIndex("vault_session_refresh_unique").on(table.refreshHash),
  ]
)

export const vaultTotp = sqliteTable("vault_totp", {
  userId: text("user_id")
    .primaryKey()
    .references(() => vaultUser.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  lastUsedStep: integer("last_used_step").notNull().default(0),
  recoveryCode: text("recovery_code").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
})

// Public Send URLs resolve to the owner's Durable Object through this index.
// The encrypted content and access counter remain in that object.
export const vaultSendLocator = sqliteTable("vault_send_locator", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => vaultUser.id, { onDelete: "cascade" }),
})
