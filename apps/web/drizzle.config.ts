import { defineConfig } from "drizzle-kit"

/**
 * D1: auth and billing.
 *
 * Plain SQL output, applied with `wrangler d1 migrations apply` rather than
 * drizzle-kit's own runner, so the migration state lives where Cloudflare
 * expects it. The Durable Object has its own config — `drizzle.do.config.ts`.
 *
 * One entry per schema module; do not point this at `db/schema/index.ts` as
 * well, or every table is discovered twice through the barrel.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: [
    "./db/schema/auth.ts",
    "./db/schema/billing.ts",
    "./db/schema/projects.ts",
  ],
  out: "./migrations",
})
