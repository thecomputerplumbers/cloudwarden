import assert from "node:assert/strict"
import { test } from "node:test"
import {
  csvRows,
  ExportPasswordNeeded,
  exportCsv,
  exportJson,
  exportProtectedJson,
  parseImport,
} from "../apps/web/vault/transfer.ts"

const folders = [{ id: "f1", name: "Work" }]
const item = (overrides) => ({
  id: crypto.randomUUID(),
  kind: "login",
  organizationId: null,
  folderId: null,
  collectionIds: [],
  favorite: false,
  deleted: false,
  revisionDate: "2026-10-19T00:00:00.000Z",
  canEdit: true,
  canViewPassword: true,
  name: "Item",
  notes: null,
  login: null,
  card: null,
  identity: null,
  sshKey: null,
  fields: [],
  attachments: [],
  error: null,
  complete: true,
  raw: {},
  ...overrides,
})
const items = [
  item({
    name: 'Router, "admin"',
    folderId: "f1",
    favorite: true,
    notes: "line one\nline two",
    login: {
      username: "admin",
      password: 'p,a"ss',
      totp: "JBSWY3DPEHPK3PXP",
      uris: [
        { uri: "https://router.example", match: null },
        { uri: "https://192.168.1.1", match: 3 },
      ],
    },
    fields: [{ name: "PIN", value: "1234", type: 1 }],
  }),
  item({ kind: "note", name: "Wifi", notes: "secret" }),
  item({
    kind: "card",
    name: "Visa",
    card: { cardholderName: "A B", number: "4111111111111111", code: "123" },
  }),
  item({ kind: "unknown", name: "Future type" }),
]

test("a JSON export imports back as the same items and folders", async () => {
  const result = await parseImport(exportJson(items, folders))
  assert.equal(result.items.length, 3)
  assert.equal(result.skipped, 0)
  const [login, note, card] = result.items
  assert.equal(login.folder, "Work")
  assert.equal(login.draft.name, 'Router, "admin"')
  assert.equal(login.draft.favorite, true)
  assert.equal(login.draft.login.password, 'p,a"ss')
  assert.deepEqual(login.draft.login.uris, [
    { uri: "https://router.example", match: null },
    { uri: "https://192.168.1.1", match: 3 },
  ])
  assert.deepEqual(login.draft.fields, [
    { name: "PIN", value: "1234", type: 1 },
  ])
  assert.equal(note.draft.kind, "note")
  assert.equal(note.folder, null)
  assert.equal(card.draft.card.number, "4111111111111111")
})

test("a password-protected export needs its password, and only that password", async () => {
  const file = await exportProtectedJson(items, folders, "file password 1")
  const parsed = JSON.parse(file)
  assert.equal(parsed.encrypted, true)
  assert.equal(parsed.passwordProtected, true)
  assert.match(parsed.data, /^2\./)
  assert.ok(!file.includes("router.example"))
  await assert.rejects(parseImport(file), ExportPasswordNeeded)
  await assert.rejects(parseImport(file, "wrong"), /doesn't open/)
  const result = await parseImport(file, "file password 1")
  assert.equal(result.items.length, 3)
  assert.equal(result.items[0].draft.login.username, "admin")
})

test("account-encrypted exports are explained rather than misread", async () => {
  await assert.rejects(
    parseImport(JSON.stringify({ encrypted: true, items: [] })),
    /another account's key/
  )
})

test("CSV export quotes what needs it and imports back", async () => {
  const csv = exportCsv(items, folders)
  const [header, ...rows] = csvRows(csv)
  assert.equal(
    header.join(","),
    "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp"
  )
  assert.equal(rows.length, 2, "cards are left out of CSV, as in Bitwarden")
  assert.equal(rows[0][3], 'Router, "admin"')
  assert.equal(rows[0][4], "line one\nline two")
  const result = await parseImport(csv)
  assert.equal(result.items.length, 2)
  const login = result.items[0]
  assert.equal(login.folder, "Work")
  assert.equal(login.draft.favorite, true)
  assert.equal(login.draft.login.password, 'p,a"ss')
  assert.deepEqual(
    login.draft.login.uris.map((entry) => entry.uri),
    ["https://router.example", "https://192.168.1.1"]
  )
  assert.deepEqual(login.draft.fields, [
    { name: "PIN", value: "1234", type: 0 },
  ])
})

test("a Bitwarden CSV with Windows line endings and other kinds", async () => {
  const csv =
    "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\r\n" +
    ",,login,Mail,,,0,https://mail.example,me,pw,\r\n" +
    ",,card,Ignored,,,0,,,,\r\n"
  const result = await parseImport(csv)
  assert.equal(result.items.length, 1)
  assert.equal(result.skipped, 1)
  assert.equal(result.items[0].draft.login.password, "pw")
})

test("files that aren't Bitwarden exports are refused", async () => {
  await assert.rejects(parseImport("title,url\nx,y"), /doesn't look like/)
  await assert.rejects(parseImport("{not json"), /valid JSON/)
})
