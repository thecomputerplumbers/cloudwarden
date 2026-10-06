import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { parse } from "jsonc-parser"
import { root } from "./project-lib.mjs"

const config = parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
)
if (config.routes?.length || config.workers_dev !== true)
  throw new Error(
    "One-click deployment must use workers.dev and no custom routes"
  )
if (!config.d1_databases?.some((binding) => binding.binding === "DB"))
  throw new Error("One-click D1 binding is missing")

function run(args) {
  const result = spawnSync(
    "pnpm",
    ["--filter", "web", "exec", "wrangler", ...args],
    {
      cwd: root,
      stdio: "inherit",
    }
  )
  if (result.status !== 0) throw new Error(`wrangler ${args[0]} failed`)
}

run([
  "d1",
  "migrations",
  "apply",
  "DB",
  "--remote",
  "--config",
  "../../wrangler.jsonc",
])
run(["deploy", "--config", "../../wrangler.jsonc"])
