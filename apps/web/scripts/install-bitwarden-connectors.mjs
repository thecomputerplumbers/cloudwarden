import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { writeAssetHeaders } from "./asset-headers.mjs"

const version = "2026.7.0"
const checksum =
  "002e972bf0d0487ec0324b06d916de33e29de4c29bffd92ee3b843084c300570"
const archiveName = `bw_web_v${version}.tar.gz`
const source = `https://github.com/dani-garcia/bw_web_builds/releases/download/v${version}/${archiveName}`
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cache = join(root, ".cache", archiveName)
const client = join(root, "dist", "client")

/**
 * The native vault replaces Bitwarden's web client. What remains are the small
 * connector pages that Bitwarden's apps and browser extensions open on the
 * server's origin for SSO, WebAuthn and Duo two-step login, and what they load.
 * They are served from the site root, where the apps expect them.
 */
const CONNECTOR_IMAGES = [
  "apple-touch-icon.png",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "safari-pinned-tab.svg",
  "logo-dark@2x.png",
  "u2fkey-mobile.jpg",
]
const keep = (relative) =>
  /^[a-z-]+-connector\.html$/.test(relative) ||
  /^styles\.[0-9a-f]{20}\.(css|js)$/.test(relative) ||
  // The connectors' web app manifest, and the FIDO app ID for security keys.
  /^[0-9a-f]{20}\.json$/.test(relative) ||
  relative === "app-id.json" ||
  relative === "connectors" ||
  relative.startsWith("connectors/") ||
  // The connectors translate their text from locales/<language>/messages.json.
  relative === "locales" ||
  relative.startsWith("locales/") ||
  relative === "images" ||
  CONNECTOR_IMAGES.some((name) => relative === `images/${name}`)

async function verifiedArchive() {
  let data
  try {
    data = await readFile(cache)
  } catch {
    const response = await fetch(source)
    if (!response.ok)
      throw new Error(`Web vault download failed: ${response.status}`)
    data = Buffer.from(await response.arrayBuffer())
  }
  if (createHash("sha256").update(data).digest("hex") !== checksum)
    throw new Error("Web vault checksum mismatch")
  await mkdir(dirname(cache), { recursive: true })
  await writeFile(cache, data)
  return cache
}

const archive = await verifiedArchive()
const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" })
if (listing.status !== 0) throw new Error("Could not inspect web vault archive")
const names = listing.stdout.trim().split("\n")
if (
  names.some(
    (name) => !name.startsWith("web-vault/") || name.split("/").includes("..")
  )
)
  throw new Error("Unexpected web vault archive path")

const temporary = await mkdtemp(join(tmpdir(), "cloudwarden-web-vault-"))
try {
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", temporary], {
    stdio: "inherit",
  })
  if (extracted.status !== 0) throw new Error("Could not extract web vault")
  const webVault = join(temporary, "web-vault")
  await cp(webVault, client, {
    recursive: true,
    filter: async (path) => {
      if (path === webVault) return true
      if (path.endsWith(".map")) return false
      if (!keep(relative(webVault, path).split(sep).join("/"))) return false
      const info = await stat(path)
      if (info.isFile() && info.size > 25 * 1024 * 1024)
        throw new Error(
          `Web vault asset exceeds Cloudflare's size limit: ${path}`
        )
      return true
    },
  })
  await writeFile(
    join(client, "bitwarden-connectors-source.txt"),
    `Bitwarden connector pages from the Vaultwarden web vault v${version}\nSource: https://github.com/dani-garcia/bw_web_builds/tree/v${version}\nLicense: GPL-3.0\nArchive SHA-256: ${checksum}\n`
  )
  const { rules } = await writeAssetHeaders(client)
  console.log(
    `Installed Bitwarden's connector pages from web vault v${version} (${rules} immutable cache rules)`
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
