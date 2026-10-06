import assert from "node:assert/strict"
import { test } from "node:test"
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initialize } from "../scripts/init-project.mjs"
import { readJson, targetConfig } from "../scripts/project-lib.mjs"
const options = {
  name: "Example Studio",
  slug: "example-studio",
  origin: "https://app.example.test",
  stagingOrigin: "https://staging.example.test",
  accountId: "a".repeat(32),
  emailFrom: "hello@example.test",
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "starter-init-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, "apps/web/config"), { recursive: true })
  for (const path of [
    "package.json",
    "apps/web/config/product.json",
    "apps/web/wrangler.jsonc",
  ])
    copyFileSync(new URL(`../${path}`, import.meta.url), join(root, path))
  return root
}
test("new-project setup isolates environments and preserves existing local secrets", (t) => {
  const root = fixture(t)
  initialize(root, options)
  const config = readJson(join(root, "apps/web/wrangler.jsonc")),
    secret = readFileSync(join(root, "apps/web/.dev.vars"), "utf8")
  assert.equal(config.name, options.slug)
  assert.equal(config.env.staging.name, `${options.slug}-staging`)
  assert.notEqual(
    config.d1_databases[0].database_id,
    config.env.staging.d1_databases[0].database_id
  )
  assert.equal(
    config.env.staging.durable_objects.bindings[0].name,
    "APP_DATABASE"
  )
  assert.equal(config.env.staging.send_email[0].name, "EMAIL")
  assert.equal(
    readJson(join(root, "apps/web/config/product.json")).name,
    options.name
  )
  assert.ok(secret.includes("APP_URL=http://localhost:3000"))
  assert.match(secret, /BETTER_AUTH_SECRET=.{40,}/)
  initialize(root, options)
  assert.equal(readFileSync(join(root, "apps/web/.dev.vars"), "utf8"), secret)
})
test("setup rejects unsafe targets before changing files", (t) => {
  const root = fixture(t),
    before = readFileSync(join(root, "package.json"), "utf8")
  for (const changes of [
    { slug: "../other" },
    { origin: "https://example.test/path" },
    { emailFrom: "mail\n@example.test" },
    { stagingOrigin: options.origin },
    { productionDbId: "bad" },
  ])
    assert.throws(() => initialize(root, { ...options, ...changes }))
  assert.equal(readFileSync(join(root, "package.json"), "utf8"), before)
  assert.throws(() => targetConfig("staging", {}), /staging/i)
})
