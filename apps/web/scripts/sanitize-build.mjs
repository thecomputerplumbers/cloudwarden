import { readdir, readFile, rm } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

function localVars(name) {
  return (
    (name === ".env" ||
      name.startsWith(".env.") ||
      name === ".dev.vars" ||
      name.startsWith(".dev.vars.")) &&
    !name.endsWith(".example")
  )
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

async function localSecrets(source) {
  const secrets = new Map()
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || !localVars(entry.name)) continue
    const content = await readFile(join(source, entry.name), "utf8")
    for (const line of content.split(/\r?\n/)) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
      if (!match || !/(SECRET|TOKEN|KEY|PASSWORD|PRIVATE)/.test(match[1]))
        continue
      const value = match[2].replace(/^(["'])(.*)\1$/, "$2")
      if (value.length >= 12) secrets.set(match[1], value)
    }
  }
  return secrets
}

export async function sanitizeBuild(source, output) {
  const secrets = await localSecrets(source)
  let removed = 0
  for (const path of await walk(output)) {
    if (!localVars(basename(path))) continue
    await rm(path)
    removed++
  }
  for (const path of await walk(output)) {
    const bytes = await readFile(path)
    for (const [name, value] of secrets) {
      if (bytes.includes(Buffer.from(value)))
        throw new Error(`Build artifact contains local ${name}: ${path}`)
    }
  }
  return { removed, secretNamesChecked: secrets.size }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const source = resolve(import.meta.dirname, "..")
  const output = join(source, "dist")
  const result = await sanitizeBuild(source, output)
  console.log(
    `Removed ${result.removed} local environment files from build output; checked ${result.secretNamesChecked} secret values`
  )
}
