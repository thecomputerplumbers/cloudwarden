import { readdir, writeFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"

/**
 * Workers Static Assets serves every file with `max-age=0, must-revalidate`
 * unless `_headers` says otherwise, so each page load re-checks every script
 * with the server. Files whose names carry a content hash never change, so
 * they can be cached for a year. Everything else (index.html, locales, images,
 * manifests) keeps the default and is revalidated.
 */

export const IMMUTABLE = "public, max-age=31536000, immutable"
/** Cloudflare reads at most 100 rules from `_headers`. */
const MAX_RULES = 100

/** A webpack content hash in the name: `main.a46e2355765814789865.js`, `cca56971e438d22818d6.json`. */
export const isHashed = (name) => /(^|\.)[0-9a-f]{16,}\./.test(name)

// vinext's generated static output uses Vite's eight-character content hashes.
const isViteHashed = (name) =>
  /[.-][A-Za-z0-9_-]{8}\.(?:js|css|woff2?|ttf|svg|png|wasm)$/.test(name)

/**
 * The `_headers` text for a list of asset paths relative to the assets root,
 * with `/` separators. A directory whose files are all hashed gets one rule;
 * other hashed files get a rule each. Vite puts its hashed output in `assets/` or `_next/static/` subdirectories.
 */
export function assetHeaders(paths) {
  const byDirectory = new Map()
  for (const path of paths) {
    const slash = path.indexOf("/")
    // Bitwarden's web client sits under legacy/, so its directories group one level down.
    const legacyDir = path.startsWith("legacy/") ? path.indexOf("/", 7) : -1
    const top = path.startsWith("_next/static/")
      ? path.slice(0, path.lastIndexOf("/"))
      : path.startsWith("legacy/")
        ? legacyDir === -1
          ? "legacy"
          : path.slice(0, legacyDir)
        : slash === -1
          ? ""
          : path.slice(0, slash)
    if (!byDirectory.has(top)) byDirectory.set(top, [])
    byDirectory.get(top).push(path)
  }
  const rules = []
  for (const [top, files] of [...byDirectory].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const hashed = files.filter((path) => {
      const name = path.slice(path.lastIndexOf("/") + 1)
      return (
        isHashed(name) || (top.startsWith("_next/static") && isViteHashed(name))
      )
    })
    if (top !== "" && (top === "assets" || hashed.length === files.length))
      rules.push(`/${top}/*`)
    else for (const path of hashed.sort()) rules.push(`/${path}`)
  }
  if (rules.length > MAX_RULES)
    throw new Error(
      `_headers would need ${rules.length} rules; Cloudflare reads only ${MAX_RULES}`
    )
  return rules
    .map((rule) => `${rule}\n  Cache-Control: ${IMMUTABLE}\n`)
    .join("")
}

async function walk(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(path)))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

/** Writes `_headers` for everything under `root`. */
export async function writeAssetHeaders(root) {
  const paths = (await walk(root))
    .map((path) => relative(root, path).split(sep).join("/"))
    .filter((path) => path !== "_headers")
  const text = assetHeaders(paths)
  await writeFile(join(root, "_headers"), text)
  return {
    rules: text.split("\n").filter((line) => line.startsWith("/")).length,
  }
}
