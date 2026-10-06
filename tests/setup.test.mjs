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
import {
  artifactMatchesTarget,
  readJson,
  targetConfig,
  wranglerArgs,
} from "../scripts/project-lib.mjs"
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
  assert.equal(config.workers_dev, false)
  assert.equal(config.env.staging.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.equal(config.env.staging.preview_urls, false)
  assert.deepEqual(config.routes, [
    { pattern: "app.example.test", custom_domain: true },
  ])
  assert.deepEqual(config.env.staging.routes, [
    { pattern: "staging.example.test", custom_domain: true },
  ])
  assert.deepEqual(wranglerArgs("staging", config), ["--env", "staging"])
  assert.deepEqual(wranglerArgs("production", config), [])
  assert.notEqual(
    config.d1_databases[0].database_id,
    config.env.staging.d1_databases[0].database_id
  )
  assert.equal(
    config.env.staging.durable_objects.bindings[0].name,
    "APP_DATABASE"
  )
  assert.equal(config.env.staging.send_email[0].name, "EMAIL")
  assert.deepEqual(config.send_email[0].allowed_sender_addresses, [
    options.emailFrom,
  ])
  assert.deepEqual(config.env.staging.send_email[0].allowed_sender_addresses, [
    options.emailFrom,
  ])
  assert.equal(config.r2_buckets[0].bucket_name, "example-studio-attachments")
  assert.equal(
    config.env.staging.r2_buckets[0].bucket_name,
    "example-studio-attachments-staging"
  )
  assert.equal(
    readJson(join(root, "apps/web/config/product.json")).name,
    options.name
  )
  assert.ok(secret.includes("APP_URL=http://localhost:3000"))
  assert.ok(secret.includes(`EMAIL_FROM=${options.emailFrom}`))
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
  assert.throws(() => wranglerArgs("staging", {}), /staging/i)
})

test("release artifact must match the selected account, origin, and storage", (t) => {
  const root = fixture(t)
  initialize(root, options)
  const config = readJson(join(root, "apps/web/wrangler.jsonc"))
  const staging = targetConfig("staging", config)
  assert.equal(artifactMatchesTarget(staging, staging), true)
  for (const artifact of [
    { ...staging, name: config.name },
    { ...staging, account_id: "b".repeat(32) },
    { ...staging, workers_dev: true },
    { ...staging, vars: { ...staging.vars, APP_URL: config.vars.APP_URL } },
    { ...staging, routes: config.routes },
    { ...staging, d1_databases: config.d1_databases },
    { ...staging, r2_buckets: config.r2_buckets },
    { ...staging, send_email: [] },
    {
      ...staging,
      send_email: [
        { name: "EMAIL", allowed_sender_addresses: ["bad@example.test"] },
      ],
    },
    { ...staging, durable_objects: { bindings: [] } },
  ])
    assert.equal(artifactMatchesTarget(artifact, staging), false)
})

test("workers.dev origins do not create custom domain routes", (t) => {
  const root = fixture(t)
  initialize(root, {
    ...options,
    origin: "https://example-studio.account.workers.dev",
    stagingOrigin: "https://example-studio-staging.account.workers.dev",
  })
  const config = readJson(join(root, "apps/web/wrangler.jsonc"))
  assert.deepEqual(config.routes, [])
  assert.deepEqual(config.env.staging.routes, [])
  assert.equal(config.workers_dev, true)
  assert.equal(config.env.staging.workers_dev, true)
})
