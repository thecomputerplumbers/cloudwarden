import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core"
import { vaultOrganization } from "./vault"

// Cloudwarden Secrets Manager (docs/secrets-manager.md). Every name and value
// is encrypted in the browser with the organization's key; the server stores
// ciphertext and hashes only. Rows go when their organization does.

export const smProject = sqliteTable(
  "sm_project",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => vaultOrganization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("sm_project_org_idx").on(table.orgId)]
)

export const smSecret = sqliteTable(
  "sm_secret",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => vaultOrganization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => smProject.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("sm_secret_org_idx").on(table.orgId),
    index("sm_secret_project_idx").on(table.projectId),
  ]
)

export const smMachineAccount = sqliteTable(
  "sm_machine_account",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => vaultOrganization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("sm_machine_account_org_idx").on(table.orgId)]
)

/** Which projects a machine account may read, and whether it may also write. */
export const smMachineAccess = sqliteTable(
  "sm_machine_access",
  {
    machineAccountId: text("machine_account_id")
      .notNull()
      .references(() => smMachineAccount.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => smProject.id, { onDelete: "cascade" }),
    write: integer("write", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.machineAccountId, table.projectId] }),
  ]
)

export const smAccessToken = sqliteTable(
  "sm_access_token",
  {
    id: text("id").primaryKey(),
    machineAccountId: text("machine_account_id")
      .notNull()
      .references(() => smMachineAccount.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => vaultOrganization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Lowercase hex SHA-256 of the client secret. The secret itself never reaches the server. */
    secretHash: text("secret_hash").notNull(),
    /** The organization key, encrypted with the token key, which only the token holder can derive. */
    encryptedPayload: text("encrypted_payload").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("sm_access_token_machine_idx").on(table.machineAccountId)]
)
