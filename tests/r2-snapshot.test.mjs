import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  createSnapshot,
  safeKey,
  verifySnapshot,
} from "../scripts/r2-snapshot.mjs"

const key =
  "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/33333333-3333-3333-3333-333333333333"

test("R2 snapshot rejects paths outside vault object keys", () => {
  assert.equal(safeKey(key), true)
  assert.equal(safeKey(`org/${key}`), true)
  assert.equal(
    safeKey(
      "sends/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/" +
        "a".repeat(64)
    ),
    true
  )
  for (const unsafe of [
    "../secret",
    `${key}/../../secret`,
    "/tmp/object",
    "org//object",
  ])
    assert.equal(safeKey(unsafe), false)
})

test("R2 snapshot captures and verifies encrypted object bytes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cloudwarden-r2-test-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = join(directory, "source")
  const bytes = Buffer.from("client-encrypted-attachment")
  writeFileSync(source, bytes)
  const aws = join(directory, "aws")
  writeFileSync(
    aws,
    `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
if (args[1] === "list-objects-v2") {
  process.stdout.write(JSON.stringify({Contents:[{Key:process.env.FAKE_R2_KEY,Size:Number(process.env.FAKE_R2_SIZE),LastModified:"2026-10-06T00:00:00Z",ETag:'"abc"'}],IsTruncated:false}))
} else if (args[1] === "get-object") {
  fs.copyFileSync(process.env.FAKE_R2_SOURCE, args.at(-1))
} else process.exit(2)
`
  )
  chmodSync(aws, 0o700)
  const previous = {
    PATH: process.env.PATH,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    FAKE_R2_SOURCE: process.env.FAKE_R2_SOURCE,
    FAKE_R2_KEY: process.env.FAKE_R2_KEY,
    FAKE_R2_SIZE: process.env.FAKE_R2_SIZE,
  }
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  process.env.PATH = `${directory}:${process.env.PATH}`
  process.env.AWS_ACCESS_KEY_ID = "local-test"
  process.env.AWS_SECRET_ACCESS_KEY = "local-test"
  process.env.FAKE_R2_SOURCE = source
  process.env.FAKE_R2_KEY = key
  process.env.FAKE_R2_SIZE = String(bytes.length)
  const destination = join(directory, "snapshot")
  const manifest = await createSnapshot("staging", destination)
  assert.equal(manifest.objects.length, 1)
  assert.equal(
    manifest.objects[0].sha256,
    createHash("sha256").update(bytes).digest("hex")
  )
  assert.deepEqual(await verifySnapshot(destination), manifest)
  writeFileSync(join(destination, "objects", key), "tampered")
  await assert.rejects(() => verifySnapshot(destination), /verification/)
  assert.match(
    readFileSync(join(destination, "manifest.json"), "utf8"),
    /cloudwarden-r2-snapshot-v1/
  )
})

test("R2 snapshot verification rejects symlinked object directories", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cloudwarden-r2-symlink-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const snapshot = join(directory, "snapshot")
  const outside = join(directory, "outside")
  mkdirSync(snapshot)
  mkdirSync(dirname(join(outside, key)), { recursive: true })
  const bytes = Buffer.from("attachment outside snapshot")
  writeFileSync(join(outside, key), bytes)
  symlinkSync(outside, join(snapshot, "objects"))
  writeFileSync(
    join(snapshot, "manifest.json"),
    JSON.stringify({
      format: "cloudwarden-r2-snapshot-v1",
      objects: [
        {
          key,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    })
  )
  await assert.rejects(() => verifySnapshot(snapshot), /verification/)
})
