import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { targetConfig } from "../scripts/project-lib.mjs"
import { restoreInput, restoreSnapshot } from "../scripts/r2-restore.mjs"

const key =
  "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/33333333-3333-3333-3333-333333333333"

test("R2 restore requires an explicit apply flag", () => {
  assert.throws(() => restoreInput(["staging", "snapshot", "--overwrite"]))
  assert.throws(() => restoreInput(["staging"]))
  assert.equal(restoreInput(["staging", "snapshot"]).apply, false)
  assert.equal(restoreInput(["staging", "snapshot", "--apply"]).apply, true)
})

test("R2 restore verifies target, maintenance, uploaded bytes, and extra keys", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cloudwarden-r2-restore-test-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const statePath = join(directory, "remote.json")
  writeFileSync(statePath, "{}")
  const aws = join(directory, "aws")
  writeFileSync(
    aws,
    `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync(process.env.FAKE_R2_STATE, "utf8"))
const option = (name) => args[args.indexOf(name) + 1]
if (args[1] === "list-objects-v2") {
  const Contents = Object.entries(state).map(([Key, value]) => ({
    Key, Size: Buffer.from(value, "base64").length,
    LastModified: "2026-10-06T00:00:00Z", ETag: '"test"'
  }))
  process.stdout.write(JSON.stringify({Contents, IsTruncated: false}))
} else if (args[1] === "put-object") {
  const bytes = fs.readFileSync(option("--body"))
  state[option("--key")] = (process.env.FAKE_R2_CORRUPT
    ? Buffer.alloc(bytes.length) : bytes).toString("base64")
  fs.writeFileSync(process.env.FAKE_R2_STATE, JSON.stringify(state))
} else if (args[1] === "get-object") {
  fs.writeFileSync(args.at(-1), Buffer.from(state[option("--key")], "base64"))
} else process.exit(2)
`
  )
  chmodSync(aws, 0o700)
  const previous = Object.fromEntries(
    [
      "PATH",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "FAKE_R2_STATE",
      "FAKE_R2_CORRUPT",
    ].map((name) => [name, process.env[name]])
  )
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  process.env.PATH = `${directory}:${process.env.PATH}`
  process.env.AWS_ACCESS_KEY_ID = "local-test"
  process.env.AWS_SECRET_ACCESS_KEY = "local-test"
  process.env.FAKE_R2_STATE = statePath

  const snapshot = join(directory, "snapshot")
  mkdirSync(dirname(join(snapshot, "objects", key)), { recursive: true })
  const bytes = Buffer.from("client-encrypted-attachment")
  writeFileSync(join(snapshot, "objects", key), bytes)
  const config = targetConfig("staging")
  const manifest = {
    format: "cloudwarden-r2-snapshot-v1",
    environment: "staging",
    bucket: config.r2_buckets.find(
      (binding) => binding.binding === "VAULT_ATTACHMENTS"
    ).bucket_name,
    accountId: config.account_id,
    capturedAt: "2026-10-06T00:00:00Z",
    objects: [
      {
        key,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  }
  writeFileSync(join(snapshot, "manifest.json"), JSON.stringify(manifest))
  let fetches = 0
  const fetcher = async () => {
    fetches++
    return Response.json({ maintenance: true }, { status: 503 })
  }
  assert.deepEqual(await restoreSnapshot(["staging", snapshot], { fetcher }), {
    bucket: manifest.bucket,
    snapshotObjects: 1,
    existingObjects: 0,
    extraObjects: 0,
  })
  assert.equal(fetches, 0)
  await assert.rejects(
    () =>
      restoreSnapshot(["staging", snapshot, "--apply"], {
        fetcher: async () => Response.json({ maintenance: false }),
      }),
    /maintenance mode/
  )
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), {})
  const result = await restoreSnapshot(["staging", snapshot, "--apply"], {
    fetcher,
  })
  assert.equal(result.restoredObjects, 1)
  assert.equal(result.verified, true)
  assert.equal(fetches, 1)
  assert.deepEqual(
    Buffer.from(JSON.parse(readFileSync(statePath, "utf8"))[key], "base64"),
    bytes
  )

  process.env.FAKE_R2_CORRUPT = "true"
  await assert.rejects(
    () => restoreSnapshot(["staging", snapshot, "--apply"], { fetcher }),
    /failed verification/
  )
  delete process.env.FAKE_R2_CORRUPT
  writeFileSync(
    statePath,
    JSON.stringify({
      ...JSON.parse(readFileSync(statePath, "utf8")),
      ["sends/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/" +
      "a".repeat(64)]: "",
    })
  )
  await assert.rejects(
    () => restoreSnapshot(["staging", snapshot, "--apply"], { fetcher }),
    /outside the snapshot/
  )
  writeFileSync(
    join(snapshot, "manifest.json"),
    JSON.stringify({ ...manifest, bucket: "wrong-bucket" })
  )
  await assert.rejects(
    () => restoreSnapshot(["staging", snapshot, "--apply"], { fetcher }),
    /does not match/
  )
})
