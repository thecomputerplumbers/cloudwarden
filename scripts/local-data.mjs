import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { hashPassword } from "../packages/auth/node_modules/better-auth/dist/crypto/index.mjs"
import { root, readJson } from "./project-lib.mjs"
const action = process.argv[2]
if (
  !["seed", "reset"].includes(action) ||
  process.argv.slice(3).some((arg) => arg !== "--yes")
)
  throw new Error("Usage: pnpm db:seed | pnpm db:reset --yes (local only)")
function run(args) {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "web",
      "exec",
      "wrangler",
      "--config",
      "wrangler.jsonc",
      ...args,
    ],
    { cwd: root, stdio: "inherit", env: { ...process.env, CLOUDFLARE_ENV: "" } }
  )
  if (result.status !== 0) throw new Error("Local database command failed")
}
if (action === "reset") {
  if (!process.argv.includes("--yes"))
    throw new Error(
      "This removes local D1 and Durable Object state. Stop dev, then run pnpm db:reset --yes"
    )
  const state = resolve(root, "apps/web/.wrangler/state")
  if (existsSync(state)) rmSync(state, { recursive: true })
  run(["d1", "migrations", "apply", "DB", "--local"])
  console.log("Local state reset. Run pnpm db:seed to restore demo data.")
} else {
  const config = readJson(resolve(root, "apps/web/wrangler.jsonc"))
  if (config.send_email?.some((binding) => binding.remote))
    throw new Error("Fixtures require local email simulation")
  run(["d1", "migrations", "apply", "DB", "--local"])
  const hash = await hashPassword("Local-demo-only-2026!"),
    now = Date.now(),
    sql = []
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
  for (let org = 1; org <= 2; org++) {
    const id = `demo-org-${org}`
    sql.push(
      `INSERT OR IGNORE INTO organization (id,name,slug,created_at) VALUES (${quote(id)},${quote(org === 1 ? "Acme Studio" : "Northwind Team")},${quote(id)},${now});`
    )
    for (const role of ["owner", "admin", "member"]) {
      const userId = `demo-${role}-${org}`,
        email = `${role}${org === 1 ? "" : "2"}@example.test`
      sql.push(
        `INSERT OR IGNORE INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (${quote(userId)},${quote(`Demo ${role}`)},${quote(email)},1,${now},${now});`,
        `INSERT OR IGNORE INTO account (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES (${quote(userId)},${quote(userId)},'credential',${quote(userId)},${quote(hash)},${now},${now});`,
        `INSERT OR IGNORE INTO member (id,organization_id,user_id,role,created_at) VALUES (${quote(userId)},${quote(id)},${quote(userId)},${quote(role)},${now});`
      )
    }
    for (let i = 1; i <= 25; i++) {
      const projectId = `00000000-0000-4000-8000-${String(org * 100 + i).padStart(12, "0")}`
      sql.push(
        `INSERT OR IGNORE INTO project (id,organization_id,name,description,status,version,created_at,updated_at) VALUES (${quote(projectId)},${quote(id)},${quote(`Project ${String(i).padStart(2, "0")}`)},'A sample project for local development.',${quote(i % 5 === 0 ? "archived" : "active")},1,${now},${now});`
      )
    }
  }
  const folder = mkdtempSync(join(tmpdir(), "starter-seed-")),
    file = join(folder, "seed.sql")
  try {
    writeFileSync(file, sql.join("\n"), { mode: 0o600 })
    run(["d1", "execute", "DB", "--local", "--file", file])
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
  console.log(
    "Local demo: owner@example.test, admin@example.test, member@example.test (add 2 before @ for the second organization). Password: Local-demo-only-2026!"
  )
}
