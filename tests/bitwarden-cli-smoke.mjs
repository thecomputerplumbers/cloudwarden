import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const server = process.env.BW_TEST_SERVER
const email = process.env.BW_TEST_EMAIL
const password = process.env.BW_TEST_PASSWORD
const cliPath = process.env.BW_CLI_PATH
if (
  !server ||
  new URL(server).protocol !== "https:" ||
  !email ||
  !password ||
  !cliPath
)
  throw new Error(
    "Set BW_TEST_SERVER (HTTPS), BW_TEST_EMAIL, BW_TEST_PASSWORD, and BW_CLI_PATH for a disposable account"
  )

const profile = mkdtempSync(join(tmpdir(), "cloudwarden-native-cli-"))
const environment = {
  ...process.env,
  BITWARDENCLI_APPDATA_DIR: join(profile, "cli"),
}
const binary = resolve(cliPath)
let session = ""
let itemId = ""
let folderId = ""

function run(args) {
  const result = spawnSync(process.execPath, [binary, ...args], {
    env: environment,
    encoding: "utf8",
    maxBuffer: 5_000_000,
  })
  if (result.status !== 0)
    throw new Error(`Bitwarden CLI ${args[0]} failed (exit ${result.status})`)
  return result.stdout.trim()
}

function encoded(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64")
}

try {
  run(["config", "server", server])
  session = run([
    "login",
    email,
    "--passwordenv",
    "BW_TEST_PASSWORD",
    "--raw",
    "--nointeraction",
  ])
  assert.ok(session.length > 30)
  const withSession = (args) => run([...args, "--session", session])
  withSession(["sync"])

  const folderTemplate = JSON.parse(withSession(["get", "template", "folder"]))
  folderTemplate.name = `Cloudwarden CLI ${crypto.randomUUID()}`
  const folder = JSON.parse(
    withSession(["create", "folder", encoded(folderTemplate)])
  )
  folderId = folder.id

  const itemTemplate = JSON.parse(withSession(["get", "template", "item"]))
  itemTemplate.type = 1
  itemTemplate.name = `Cloudwarden CLI ${crypto.randomUUID()}`
  itemTemplate.folderId = folder.id
  itemTemplate.login = { username: "cli-user", password: "local-cli-secret" }
  const created = JSON.parse(
    withSession(["create", "item", encoded(itemTemplate)])
  )
  itemId = created.id
  assert.equal(created.name, itemTemplate.name)
  withSession(["sync"])
  const item = JSON.parse(withSession(["get", "item", created.id]))
  assert.equal(item.login.username, "cli-user")

  item.name = `${item.name} edited`
  item.login.username = "cli-edited-user"
  const edited = JSON.parse(
    withSession(["edit", "item", item.id, encoded(item)])
  )
  assert.equal(edited.name, item.name)

  const source = join(profile, "attachment.txt")
  const destination = join(profile, "downloaded.txt")
  const bytes = `Cloudwarden CLI attachment ${crypto.randomUUID()}`
  writeFileSync(source, bytes)
  withSession(["create", "attachment", "--file", source, "--itemid", item.id])
  withSession(["sync"])
  const attached = JSON.parse(withSession(["get", "item", item.id]))
  assert.equal(attached.attachments?.length, 1)
  withSession([
    "get",
    "attachment",
    attached.attachments[0].id,
    "--itemid",
    item.id,
    "--output",
    destination,
  ])
  assert.equal(readFileSync(destination, "utf8"), bytes)

  withSession(["delete", "item", item.id])
  withSession(["restore", "item", item.id])
  withSession(["delete", "item", item.id, "--permanent"])
  itemId = ""
  withSession(["delete", "folder", folder.id])
  folderId = ""
  withSession(["sync"])
  assert.equal(
    JSON.parse(withSession(["list", "items"])).some(
      (candidate) => candidate.id === item.id
    ),
    false
  )
  console.log(
    "Bitwarden CLI login, sync, item, attachment, Trash, and deletion passed"
  )
} finally {
  if (session) {
    if (itemId) {
      try {
        run(["delete", "item", itemId, "--permanent", "--session", session])
      } catch {
        console.error("Could not remove the disposable CLI item")
      }
    }
    if (folderId) {
      try {
        run(["delete", "folder", folderId, "--session", session])
      } catch {
        console.error("Could not remove the disposable CLI folder")
      }
    }
    try {
      run(["logout"])
    } catch {
      console.error("Bitwarden CLI logout failed")
    }
  }
  rmSync(profile, { recursive: true, force: true })
}
