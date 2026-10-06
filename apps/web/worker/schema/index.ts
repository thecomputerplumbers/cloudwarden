/**
 * The Durable Object's schema, in one namespace.
 *
 * `drizzle.do.config.ts` lists the modules separately — it must not also read
 * this barrel, or drizzle-kit would discover every table twice.
 */

export * from "./app"
export * from "./vault"
