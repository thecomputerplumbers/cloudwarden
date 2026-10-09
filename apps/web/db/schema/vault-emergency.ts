import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

import { vaultUser } from "./vault"

// An emergency access grant names its grantee by email until the invitation
// is accepted. The grantor's user key, wrapped for the grantee, is stored only
// once the grantor confirms.
export const vaultEmergencyAccess = sqliteTable(
  "vault_emergency_access",
  {
    id: text("id").primaryKey(),
    grantorId: text("grantor_id")
      .notNull()
      .references(() => vaultUser.id, { onDelete: "cascade" }),
    granteeId: text("grantee_id").references(() => vaultUser.id, {
      onDelete: "cascade",
    }),
    email: text("email"),
    keyEncrypted: text("key_encrypted"),
    type: integer("type").notNull(),
    status: integer("status").notNull(),
    waitTimeDays: integer("wait_time_days").notNull(),
    recoveryInitiatedAt: integer("recovery_initiated_at", {
      mode: "timestamp_ms",
    }),
    lastNotificationAt: integer("last_notification_at", {
      mode: "timestamp_ms",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("vault_emergency_access_grantor_email_unique").on(
      table.grantorId,
      table.email
    ),
    uniqueIndex("vault_emergency_access_grantor_grantee_unique").on(
      table.grantorId,
      table.granteeId
    ),
    index("vault_emergency_access_grantee_idx").on(table.granteeId),
    index("vault_emergency_access_status_idx").on(table.status),
  ]
)
