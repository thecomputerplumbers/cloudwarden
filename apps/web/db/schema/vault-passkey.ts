import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

import { vaultUser } from "./vault"

// Login passkeys are discoverable credentials that sign a user in without a
// master password. They are a separate set from the provider 7 second-factor
// keys in `vault_webauthn_credential`.
export const vaultPasskeyCredential = sqliteTable(
  "vault_passkey_credential",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => vaultUser.id, { onDelete: "cascade" }),
    slot: integer("slot").notNull(),
    name: text("name").notNull(),
    credentialId: text("credential_id").notNull(),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull(),
    transports: text("transports").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    supportsPrf: integer("supports_prf", { mode: "boolean" }).notNull(),
    encryptedUserKey: text("encrypted_user_key"),
    encryptedPublicKey: text("encrypted_public_key"),
    encryptedPrivateKey: text("encrypted_private_key"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("vault_passkey_user_slot_unique").on(table.userId, table.slot),
    uniqueIndex("vault_passkey_credential_id_unique").on(table.credentialId),
  ]
)

// `id` is the SHA-256 of the opaque token returned with the options, so a
// database read does not reveal a usable token. Login challenges are issued
// before the user is known and have no `userId`.
export const vaultPasskeyChallenge = sqliteTable(
  "vault_passkey_challenge",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => vaultUser.id, {
      onDelete: "cascade",
    }),
    scope: text("scope").notNull(),
    challenge: text("challenge").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("vault_passkey_challenge_expires_idx").on(table.expiresAt),
    index("vault_passkey_challenge_user_idx").on(table.userId, table.scope),
  ]
)
