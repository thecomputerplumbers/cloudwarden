/**
 * The D1 schema in one namespace.
 *
 * `drizzle.config.ts` lists the modules separately — it must not also read
 * this barrel, or drizzle-kit would discover every table twice.
 */

export * from "./auth"
export * from "./billing"

export * from "./projects"
export * from "./vault"
export * from "./vault-emergency"
export * from "./vault-passkey"
