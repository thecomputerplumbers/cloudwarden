import { readFile, stat } from "node:fs/promises"
import { join, resolve } from "node:path"

// Use the installed Vite build's manifest, following static imports only.
// Include the route's hydrated client boundaries as well as the browser entry.
const root = resolve(import.meta.dirname, "../dist/client")
const manifest = JSON.parse(
  await readFile(join(root, ".vite/manifest.json"), "utf8")
)
const roots = [
  "virtual:vinext-app-browser-entry",
  "vault/ui/vault-app.tsx",
  "components/theme-provider.tsx",
  "app/error.tsx",
  ...Object.keys(manifest).filter((key) =>
    /\/vinext\/dist\/shims\/(?:link|layout-segment-context)\.js$/.test(key)
  ),
]
const startup = new Set()
function visit(key) {
  if (startup.has(key)) return
  const chunk = manifest[key]
  if (!chunk) throw new Error(`Missing native vault build entry: ${key}`)
  startup.add(key)
  for (const dependency of chunk.imports ?? []) visit(dependency)
}
for (const entry of roots) visit(entry)

const deferred = [
  "vault/ui/unlocked-vault.tsx",
  "vault/ui/item-editor.tsx",
  "vault/ui/secrets/secrets-app.tsx",
  ...Object.keys(manifest).filter((key) => key.includes("/hash-wasm/")),
]
for (const key of deferred) {
  if (!manifest[key]?.isDynamicEntry || startup.has(key))
    throw new Error(`Native vault feature must load on demand: ${key}`)
}
const files = [...new Set([...startup].map((key) => manifest[key].file))]
const sizes = await Promise.all(
  files.map(async (file) => (await stat(join(root, file))).size)
)
const bytes = sizes.reduce((total, size) => total + size, 0)
const budget = 600_000
if (bytes > budget)
  throw new Error(
    `Native vault startup JavaScript exceeds ${budget} bytes: ${bytes}`
  )
console.log(
  `Native vault startup: ${bytes} bytes in ${files.length} JS files (budget ${budget}); feature chunks deferred`
)
