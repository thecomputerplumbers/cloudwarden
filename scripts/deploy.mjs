import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  artifactMatchesTarget,
  root,
  targetConfig,
  wranglerArgs,
} from "./project-lib.mjs"
const environment = process.argv[2]
if (!["staging", "production"].includes(environment))
  throw new Error("Usage: pnpm run deploy staging|production")
const config = targetConfig(environment)
function run(command, args, env = { ...process.env, CLOUDFLARE_ENV: "" }) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env })
  if (result.status !== 0) throw new Error(`${command} failed`)
}
// All validation and the environment-specific build happen before any remote write.
run(process.execPath, ["scripts/doctor.mjs", environment])
run("pnpm", ["lint"])
run("pnpm", ["format:check"])
run("pnpm", ["typecheck"])
run("pnpm", ["test"])
run("pnpm", ["test:worker"])
const buildId = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim()
if (!/^[a-f0-9]{40}$/.test(buildId))
  throw new Error("Deploy from a committed Git checkout")
if (
  spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim()
)
  throw new Error(
    "Commit changes before deployment so the health marker identifies the deployed code"
  )
run("pnpm", ["--filter", "web", "build"], {
  ...process.env,
  CLOUDFLARE_ENV: environment === "staging" ? "staging" : "",
})
const artifact = resolve(root, "apps/web/dist/server/wrangler.json"),
  built = JSON.parse(readFileSync(artifact, "utf8"))
if (!artifactMatchesTarget(built, config))
  throw new Error("Built Worker does not match the selected environment")
built.vars = { ...built.vars, BUILD_ID: buildId }
writeFileSync(artifact, JSON.stringify(built, null, 2))
run("pnpm", [
  "--filter",
  "web",
  "exec",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "DB",
  "--remote",
  "--config",
  "wrangler.jsonc",
  ...wranglerArgs(environment),
])
// Deploy the already-built artifact; never rebuild against a different environment.
run("pnpm", [
  "--filter",
  "web",
  "exec",
  "wrangler",
  "deploy",
  "--config",
  "dist/server/wrangler.json",
])
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    const response = await fetch(`${config.vars.APP_URL}/api/health`, {
        signal: AbortSignal.timeout(10000),
        cache: "no-store",
      }),
      health = await response.json()
    if (response.ok && health.ok && health.buildId === buildId) {
      const [api, webVault] = await Promise.all([
        fetch(`${config.vars.APP_URL}/api/config`, {
          signal: AbortSignal.timeout(10000),
          cache: "no-store",
        }),
        fetch(config.vars.APP_URL, {
          signal: AbortSignal.timeout(10000),
          cache: "no-store",
        }),
      ])
      const apiConfig = await api.json()
      const html = await webVault.text()
      if (
        api.ok &&
        apiConfig.environment?.identity === `${config.vars.APP_URL}/identity` &&
        webVault.ok &&
        html.includes("<title page-title>Vaultwarden Web</title>")
      ) {
        console.log(
          `Verified ${environment}: ${config.vars.APP_URL} (${buildId})`
        )
        process.exit(0)
      }
    }
  } catch {
    /* Wait for propagation. */
  }
  await delay(5000)
}
throw new Error(
  "Deployment uploaded, but independent health/build verification failed. Inspect the Worker before promoting or retrying."
)
