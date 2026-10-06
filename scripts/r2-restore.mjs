import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { targetConfig } from "./project-lib.mjs"
import {
  command,
  hashFile,
  listObjects,
  verifySnapshot,
} from "./r2-snapshot.mjs"

export function restoreInput(args) {
  const [environment, directory, flag, extra] = args
  if (
    !["staging", "production"].includes(environment) ||
    !directory ||
    (flag !== undefined && flag !== "--apply") ||
    extra !== undefined
  )
    throw new Error(
      "Usage: pnpm r2:restore staging|production SNAPSHOT_DIRECTORY [--apply]"
    )
  return {
    environment,
    directory: resolve(directory),
    apply: flag === "--apply",
  }
}

export async function restoreSnapshot(args, { fetcher = fetch } = {}) {
  const input = restoreInput(args)
  const manifest = await verifySnapshot(input.directory)
  const config = targetConfig(input.environment)
  const bucket = config.r2_buckets.find(
    (binding) => binding.binding === "VAULT_ATTACHMENTS"
  )?.bucket_name
  if (
    !bucket ||
    !/^[a-f0-9]{32}$/.test(config.account_id) ||
    manifest.environment !== input.environment ||
    manifest.bucket !== bucket ||
    manifest.accountId !== config.account_id
  )
    throw new Error("Snapshot does not match the selected R2 target")
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
    throw new Error(
      "Set scoped AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for R2"
    )
  const endpoint = `https://${config.account_id}.r2.cloudflarestorage.com`
  const before = await listObjects(bucket, endpoint)
  const expected = new Map(
    manifest.objects.map((object) => [object.key, object])
  )
  const extraKeys = before.filter((object) => !expected.has(object.key))
  const summary = {
    bucket,
    snapshotObjects: manifest.objects.length,
    existingObjects: before.length,
    extraObjects: extraKeys.length,
  }
  if (!input.apply) return summary
  if (extraKeys.length)
    throw new Error("Target bucket contains objects outside the snapshot")
  const maintenance = await fetcher(`${config.vars.APP_URL}/api/config`, {
    signal: AbortSignal.timeout(10_000),
  })
  const state = await maintenance.json().catch(() => null)
  if (maintenance.status !== 503 || state?.maintenance !== true)
    throw new Error("Target Worker must be in maintenance mode")

  for (const object of manifest.objects)
    command([
      "s3api",
      "put-object",
      "--bucket",
      bucket,
      "--key",
      object.key,
      "--body",
      join(input.directory, "objects", object.key),
      "--endpoint-url",
      endpoint,
    ])

  const after = await listObjects(bucket, endpoint)
  if (
    after.length !== manifest.objects.length ||
    after.some(
      (object, index) =>
        object.key !== manifest.objects[index].key ||
        object.size !== manifest.objects[index].size
    )
  )
    throw new Error("Restored R2 listing does not match the snapshot")

  const temp = mkdtempSync(join(tmpdir(), "cloudwarden-r2-restore-"))
  try {
    const downloaded = join(temp, "object")
    for (const object of manifest.objects) {
      command([
        "s3api",
        "get-object",
        "--bucket",
        bucket,
        "--key",
        object.key,
        "--endpoint-url",
        endpoint,
        downloaded,
      ])
      if (
        statSync(downloaded).size !== object.size ||
        (await hashFile(downloaded)) !== object.sha256
      )
        throw new Error(`Restored R2 object failed verification: ${object.key}`)
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
  return {
    ...summary,
    restoredObjects: manifest.objects.length,
    verified: true,
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = await restoreSnapshot(process.argv.slice(2))
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
