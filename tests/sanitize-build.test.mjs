import assert from "node:assert/strict"
import { test } from "node:test"
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sanitizeBuild } from "../apps/web/scripts/sanitize-build.mjs"

test("build cleanup removes copied env files and catches an inlined local secret", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cloudwarden-build-sanitize-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, "source"),
    output = join(root, "dist"),
    server = join(output, "server"),
    secret = "local-test-signing-secret-2026"
  mkdirSync(source)
  mkdirSync(server, { recursive: true })
  writeFileSync(join(source, ".dev.vars"), `BETTER_AUTH_SECRET=${secret}\n`)
  writeFileSync(join(server, ".dev.vars"), `BETTER_AUTH_SECRET=${secret}\n`)
  writeFileSync(join(server, "bundle.js"), `export const leaked = '${secret}'`)
  await assert.rejects(
    () => sanitizeBuild(source, output),
    /BETTER_AUTH_SECRET/
  )
  assert.throws(() => readFileSync(join(server, ".dev.vars")))
  writeFileSync(join(server, "bundle.js"), "export const safe = true")
  assert.deepEqual(await sanitizeBuild(source, output), {
    removed: 0,
    secretNamesChecked: 1,
  })
})
