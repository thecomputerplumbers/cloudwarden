import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { readJson, root, targetConfig } from "./project-lib.mjs"

// These are the only key shapes written by the vault. Reject unexpected keys
// before turning object names into local paths.
export function safeKey(key) {
  const id = "[0-9a-f-]{36}"
  return (
    (typeof key === "string" &&
      key.length <= 1024 &&
      new RegExp(`^(?:${id}|org/${id})/${id}/${id}$`).test(key)) ||
    (typeof key === "string" &&
      /^sends\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f]{64}$/.test(key))
  )
}

function command(args, { capture = false } = {}) {
  const result = spawnSync("aws", args, {
    cwd: root,
    encoding: capture ? "utf8" : undefined,
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, AWS_DEFAULT_REGION: "auto" },
  })
  if (result.status !== 0) throw new Error("AWS CLI R2 operation failed")
  return result.stdout
}

async function hashFile(path) {
  const { createReadStream } = await import("node:fs")
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function listObjects(bucket, endpoint) {
  const objects = []
  let token
  do {
    const page = JSON.parse(
      command(
        [
          "s3api",
          "list-objects-v2",
          "--bucket",
          bucket,
          "--endpoint-url",
          endpoint,
          "--max-keys",
          "1000",
          "--no-paginate",
          "--output",
          "json",
          ...(token ? ["--continuation-token", token] : []),
        ],
        { capture: true }
      )
    )
    for (const object of page.Contents ?? []) {
      if (!safeKey(object.Key) || !Number.isSafeInteger(object.Size))
        throw new Error(`Unexpected R2 key or size: ${object.Key}`)
      objects.push({
        key: object.Key,
        size: object.Size,
        modified: object.LastModified,
        etag: object.ETag,
      })
    }
    if (page.IsTruncated && !page.NextContinuationToken)
      throw new Error("R2 listing ended without a continuation token")
    token = page.NextContinuationToken
  } while (token)
  objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  if (
    objects.some(
      (object, index) => index && object.key === objects[index - 1].key
    )
  )
    throw new Error("R2 listing contains duplicate keys")
  return objects
}

export async function verifySnapshot(directory) {
  const manifest = readJson(join(directory, "manifest.json"))
  if (
    manifest.format !== "cloudwarden-r2-snapshot-v1" ||
    !Array.isArray(manifest.objects)
  )
    throw new Error("Invalid Cloudwarden R2 snapshot manifest")
  let previous = ""
  for (const object of manifest.objects) {
    if (
      !safeKey(object.key) ||
      object.key <= previous ||
      !Number.isSafeInteger(object.size) ||
      !/^[a-f0-9]{64}$/.test(object.sha256)
    )
      throw new Error("Invalid snapshot object entry")
    const path = join(directory, "objects", object.key)
    if (
      !lstatSync(path).isFile() ||
      statSync(path).size !== object.size ||
      (await hashFile(path)) !== object.sha256
    )
      throw new Error(`Snapshot object failed verification: ${object.key}`)
    previous = object.key
  }
  return manifest
}

export async function createSnapshot(environment, destination) {
  if (!["staging", "production"].includes(environment))
    throw new Error("Choose staging or production")
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
    throw new Error(
      "Set scoped AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for R2"
    )
  const config = targetConfig(environment)
  const bucket = config.r2_buckets.find(
    (binding) => binding.binding === "VAULT_ATTACHMENTS"
  )?.bucket_name
  if (!bucket || !/^[a-f0-9]{32}$/.test(config.account_id))
    throw new Error("Configure the R2 bucket and Cloudflare account ID")
  const finalPath = resolve(destination)
  if (existsSync(finalPath))
    throw new Error("Snapshot destination already exists")
  const tempPath = `${finalPath}.partial-${process.pid}`
  if (existsSync(tempPath))
    throw new Error("Temporary snapshot path already exists")
  const endpoint = `https://${config.account_id}.r2.cloudflarestorage.com`
  mkdirSync(dirname(finalPath), { recursive: true })
  mkdirSync(tempPath, { mode: 0o700 })
  try {
    const before = await listObjects(bucket, endpoint)
    const objects = []
    for (const object of before) {
      const path = join(tempPath, "objects", object.key)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      command([
        "s3api",
        "get-object",
        "--bucket",
        bucket,
        "--key",
        object.key,
        "--endpoint-url",
        endpoint,
        path,
      ])
      if (statSync(path).size !== object.size)
        throw new Error(`R2 object changed during download: ${object.key}`)
      objects.push({
        key: object.key,
        size: object.size,
        sha256: await hashFile(path),
      })
    }
    const after = await listObjects(bucket, endpoint)
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error(
        "R2 listing changed during snapshot; retry during a quiet period"
      )
    const manifest = {
      format: "cloudwarden-r2-snapshot-v1",
      environment,
      bucket,
      accountId: config.account_id,
      capturedAt: new Date().toISOString(),
      objects,
    }
    writeFileSync(
      join(tempPath, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        mode: 0o600,
      }
    )
    await verifySnapshot(tempPath)
    renameSync(tempPath, finalPath)
    return manifest
  } catch (error) {
    rmSync(tempPath, { recursive: true, force: true })
    throw error
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [action, destination, extra] = process.argv.slice(2)
  try {
    if (!destination || extra)
      throw new Error(
        "Usage: r2-snapshot.mjs staging|production|verify DIRECTORY"
      )
    if (action === "verify") {
      const manifest = await verifySnapshot(resolve(destination))
      console.log(
        `Verified ${manifest.objects.length} objects in ${destination}`
      )
    } else {
      const manifest = await createSnapshot(action, destination)
      console.log(`Saved ${manifest.objects.length} objects to ${destination}`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
