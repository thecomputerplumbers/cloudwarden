import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * This app's own tables.
 *
 * Each file under `worker/schema/` is one module of the schema; they are
 * listed individually in `drizzle.config.ts` so a package can contribute
 * tables without this file knowing about them.
 */

export const setting = sqliteTable("setting", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
})
