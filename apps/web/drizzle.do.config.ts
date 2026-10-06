import { defineConfig } from "drizzle-kit"

/**
 * The Durable Object's own SQLite.
 *
 * `durable-sqlite` emits one folder per migration, which `drizzle/migrations.js`
 * imports and the object replays on construction. D1 is separate —
 * see `drizzle.config.ts`.
 */
export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: ["./worker/schema/app.ts", "./worker/schema/vault.ts"],
  out: "./drizzle",
})
