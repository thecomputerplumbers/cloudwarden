import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { parse, modify, applyEdits } from "jsonc-parser"
export const root = resolve(import.meta.dirname, "..")
export function readJson(path) {
  const errors = []
  const value = parse(readFileSync(path, "utf8"), errors, {
    allowTrailingComma: true,
  })
  if (errors.length) throw new Error(`Invalid JSON configuration: ${path}`)
  return value
}
export function editJson(path, changes) {
  let source = readFileSync(path, "utf8")
  for (const [keys, value] of changes)
    source = applyEdits(
      source,
      modify(keys.length ? source : "{}", keys, value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
    )
  writeFileSync(path, source + (source.endsWith("\n") ? "" : "\n"))
}
export function targetConfig(
  environment,
  config = readJson(resolve(root, "apps/web/wrangler.jsonc"))
) {
  if (!["local", "staging", "production"].includes(environment))
    throw new Error("Choose local, staging or production")
  if (environment === "staging" && !config.env?.staging)
    throw new Error("Configure the staging environment with pnpm project:init")
  return environment === "staging"
    ? { ...config, ...config.env?.staging }
    : config
}
export function wranglerArgs(
  environment,
  config = readJson(resolve(root, "apps/web/wrangler.jsonc"))
) {
  if (environment === "staging" && !config.env?.staging)
    throw new Error("Configure the staging environment with pnpm project:init")
  return environment === "staging" ? ["--env", "staging"] : []
}
export function artifactMatchesTarget(built, config) {
  const binding = (items, name) =>
    items?.find((item) => item.binding === name || item.name === name)
  return (
    built.name === config.name &&
    built.account_id === config.account_id &&
    built.workers_dev === config.workers_dev &&
    built.preview_urls === config.preview_urls &&
    built.vars?.APP_URL === config.vars?.APP_URL &&
    built.vars?.EMAIL_FROM === config.vars?.EMAIL_FROM &&
    JSON.stringify(built.routes ?? []) ===
      JSON.stringify(config.routes ?? []) &&
    binding(built.d1_databases, "DB")?.database_id ===
      binding(config.d1_databases, "DB")?.database_id &&
    binding(built.r2_buckets, "VAULT_ATTACHMENTS")?.bucket_name ===
      binding(config.r2_buckets, "VAULT_ATTACHMENTS")?.bucket_name &&
    JSON.stringify(
      binding(built.send_email, "EMAIL")?.allowed_sender_addresses ?? []
    ) ===
      JSON.stringify(
        binding(config.send_email, "EMAIL")?.allowed_sender_addresses ?? []
      ) &&
    Boolean(binding(built.send_email, "EMAIL")) &&
    Boolean(binding(built.durable_objects?.bindings, "APP_DATABASE"))
  )
}
export function validOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.origin !== value)
    throw new Error("Use an HTTPS origin without a path or trailing slash")
  return value
}
