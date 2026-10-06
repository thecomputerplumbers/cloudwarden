import { spawnSync } from "node:child_process"
import { root } from "./project-lib.mjs"

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

const prepare = spawnSync(process.execPath, ["scripts/prepare-oneclick.mjs"], {
  cwd: root,
  stdio: "inherit",
})
if (prepare.status !== 0) throw new Error("One-click Worker preparation failed")
run([
  "d1",
  "migrations",
  "apply",
  "DB",
  "--remote",
  "--config",
  "../../wrangler.jsonc",
])
run(["deploy", "--config", "dist/server/wrangler-oneclick.json"])
