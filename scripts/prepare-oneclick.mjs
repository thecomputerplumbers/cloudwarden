import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { parse } from "jsonc-parser"
import { root } from "./project-lib.mjs"

const config = parse(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"))
if (config.routes?.length || config.workers_dev !== true)
  throw new Error(
    "One-click deployment must use workers.dev and no custom routes"
  )
const database = config.d1_databases?.find(
  (binding) => binding.binding === "DB"
)
if (!database || !/^[0-9a-f-]{36}$/i.test(database.database_id))
  throw new Error("Cloudflare must provision the one-click D1 database first")
if (
  !config.r2_buckets?.some((binding) => binding.binding === "VAULT_ATTACHMENTS")
)
  throw new Error("One-click attachment bucket is missing")

// vinext emits a deployment config beside its server bundle. Keep its relative
// module and asset paths, then apply the resources provisioned by the button.
const artifactPath = resolve(root, "apps/web/dist/server/wrangler.json")
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"))
if (artifact.main !== "index.js" || artifact.no_bundle !== true)
  throw new Error("Unexpected vinext Worker artifact")
const buildId = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim()
if (!/^[a-f0-9]{40}$/.test(buildId)) throw new Error("Missing Git build ID")

artifact.name = config.name
artifact.workers_dev = true
artifact.preview_urls = false
delete artifact.routes
delete artifact.account_id
artifact.vars = { ...config.vars, BUILD_ID: buildId }
artifact.d1_databases = artifact.d1_databases.map((binding) =>
  binding.binding === "DB"
    ? {
        ...binding,
        database_name: database.database_name,
        database_id: database.database_id,
      }
    : binding
)
artifact.r2_buckets = config.r2_buckets
artifact.durable_objects = config.durable_objects
artifact.exports = config.exports
artifact.send_email = config.send_email
artifact.triggers = config.triggers

writeFileSync(
  resolve(root, "apps/web/dist/server/wrangler-oneclick.json"),
  JSON.stringify(artifact, null, 2)
)
