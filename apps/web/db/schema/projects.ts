import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { organization } from "./auth"
export const project = sqliteTable(
  "project",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("project_org_id_idx").on(table.organizationId, table.id)]
)
