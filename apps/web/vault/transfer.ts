import { randomBytes, toBase64 } from "./crypto/bytes.ts"
import type { ItemDraft, ItemKind, VaultItem } from "./crypto/cipher.ts"
import { decryptString, encryptString } from "./crypto/enc-string.ts"
import { deriveKey, stretchMasterKey, type KdfConfig } from "./crypto/kdf.ts"

/**
 * Bitwarden's export formats, so a vault moves between Cloudwarden, Bitwarden
 * and Vaultwarden: JSON, password-protected JSON, and CSV (logins and notes
 * only, as in Bitwarden).
 */

const TYPES: Record<ItemKind, number> = {
  login: 1,
  note: 2,
  card: 3,
  identity: 4,
  sshKey: 5,
}
const KINDS = Object.fromEntries(
  Object.entries(TYPES).map(([kind, type]) => [type, kind])
) as Record<number, ItemKind>

/** An item to import: a draft for the personal vault, with its folder by name. */
export interface ImportedItem {
  draft: ItemDraft
  folder: string | null
}

export interface ImportResult {
  items: ImportedItem[]
  /** Items of kinds this vault can't hold, left out. */
  skipped: number
}

type JsonItem = {
  type?: number
  name?: string
  notes?: string | null
  favorite?: boolean
  folderId?: string | null
  login?: {
    username?: string | null
    password?: string | null
    totp?: string | null
    uris?: { uri?: string | null; match?: number | null }[] | null
  } | null
  card?: Record<string, string | null> | null
  identity?: Record<string, string | null> | null
  sshKey?: Record<string, string | null> | null
  fields?: { name?: string | null; value?: string | null; type?: number }[]
}

type JsonExport = {
  encrypted?: boolean
  passwordProtected?: boolean
  folders?: { id: string; name: string }[]
  items?: JsonItem[]
}

type ProtectedExport = {
  encrypted: true
  passwordProtected: true
  salt: string
  kdfType: number
  kdfIterations: number
  kdfMemory?: number | null
  kdfParallelism?: number | null
  encKeyValidation_DO_NOT_EDIT: string
  data: string
}

const text = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : null

function fromJsonItem(
  item: JsonItem,
  folders: Map<string, string>
): ImportedItem | null {
  const kind = KINDS[item.type ?? 0]
  if (!kind) return null
  const draft: ItemDraft = {
    kind,
    name: text(item.name) ?? "Untitled",
    notes: text(item.notes),
    favorite: item.favorite === true,
    folderId: null,
    organizationId: null,
    collectionIds: [],
    fields: (item.fields ?? []).map((field) => ({
      name: text(field.name),
      value: text(field.value),
      type: typeof field.type === "number" ? field.type : 0,
    })),
  }
  if (kind === "login")
    draft.login = {
      username: text(item.login?.username),
      password: text(item.login?.password),
      totp: text(item.login?.totp),
      uris: (item.login?.uris ?? [])
        .filter((entry) => text(entry.uri))
        .map((entry) => ({ uri: entry.uri!, match: entry.match ?? null })),
    }
  if (kind === "card") draft.card = { ...item.card }
  if (kind === "identity") draft.identity = { ...item.identity }
  if (kind === "sshKey") draft.sshKey = { ...item.sshKey }
  return {
    draft,
    folder: (item.folderId && folders.get(item.folderId)) ?? null,
  }
}

function fromJson(data: JsonExport): ImportResult {
  const folders = new Map(
    (data.folders ?? []).map((folder) => [folder.id, folder.name])
  )
  const items: ImportedItem[] = []
  let skipped = 0
  for (const item of data.items ?? []) {
    const imported = fromJsonItem(item, folders)
    if (imported) items.push(imported)
    else skipped++
  }
  return { items, skipped }
}

/** The key a password-protected export is encrypted with. */
async function exportKey(password: string, salt: string, kdf: KdfConfig) {
  return stretchMasterKey(await deriveKey(password, salt, kdf))
}

const kdfOf = (data: ProtectedExport): KdfConfig =>
  data.kdfType === 1
    ? {
        kdf: 1,
        iterations: data.kdfIterations,
        memory: data.kdfMemory ?? 64,
        parallelism: data.kdfParallelism ?? 4,
      }
    : { kdf: 0, iterations: data.kdfIterations }

export class ExportPasswordNeeded extends Error {
  constructor() {
    super("This export is protected with a password.")
  }
}

/** Parses a Bitwarden export. A password-protected one needs `password`. */
export async function parseImport(
  content: string,
  password?: string
): Promise<ImportResult> {
  const trimmed = content.trim()
  if (!trimmed.startsWith("{")) return parseCsv(trimmed)
  let data: JsonExport | ProtectedExport
  try {
    data = JSON.parse(trimmed) as JsonExport | ProtectedExport
  } catch {
    throw new Error("That file isn't valid JSON.")
  }
  if (data.encrypted && data.passwordProtected) {
    if (!password) throw new ExportPasswordNeeded()
    const protectedData = data as ProtectedExport
    const key = await exportKey(
      password,
      protectedData.salt,
      kdfOf(protectedData)
    )
    try {
      await decryptString(protectedData.encKeyValidation_DO_NOT_EDIT, key)
    } catch {
      throw new Error("That password doesn't open this export.")
    }
    return fromJson(
      JSON.parse(await decryptString(protectedData.data, key)) as JsonExport
    )
  }
  if (data.encrypted)
    throw new Error(
      "This export is encrypted with another account's key. Export it again as password-protected JSON, or as plain JSON."
    )
  return fromJson(data as JsonExport)
}

// CSV ------------------------------------------------------------------------

const CSV_COLUMNS = [
  "folder",
  "favorite",
  "type",
  "name",
  "notes",
  "fields",
  "reprompt",
  "login_uri",
  "login_username",
  "login_password",
  "login_totp",
] as const

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and newlines. */
export function csvRows(content: string) {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < content.length; i++) {
    const char = content[i]!
    if (quoted) {
      if (char === '"' && content[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ",") {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && content[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else field += char
  }
  if (field !== "" || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((entry) => entry.some((cell) => cell !== ""))
}

function parseCsv(content: string): ImportResult {
  const [header, ...rows] = csvRows(content)
  if (!header || !header.includes("name") || !header.includes("type"))
    throw new Error(
      "That doesn't look like a Bitwarden export. Choose a .json or .csv file exported from Bitwarden, Vaultwarden or Cloudwarden."
    )
  const column = (row: string[], name: (typeof CSV_COLUMNS)[number]) => {
    const index = header.indexOf(name)
    return index < 0 ? null : text(row[index])
  }
  const items: ImportedItem[] = []
  let skipped = 0
  for (const row of rows) {
    const type = column(row, "type")
    const kind: ItemKind | null =
      type === "login" ? "login" : type === "note" ? "note" : null
    if (!kind) {
      skipped++
      continue
    }
    const fields = (column(row, "fields") ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(": ")
        return at < 0
          ? { name: line, value: null, type: 0 }
          : { name: line.slice(0, at), value: line.slice(at + 2), type: 0 }
      })
    const draft: ItemDraft = {
      kind,
      name: column(row, "name") ?? "Untitled",
      notes: column(row, "notes"),
      favorite: column(row, "favorite") === "1",
      folderId: null,
      organizationId: null,
      collectionIds: [],
      fields,
    }
    if (kind === "login")
      draft.login = {
        username: column(row, "login_username"),
        password: column(row, "login_password"),
        totp: column(row, "login_totp"),
        uris: (column(row, "login_uri") ?? "")
          .split(",")
          .map((uri) => uri.trim())
          .filter(Boolean)
          .map((uri) => ({ uri, match: null })),
      }
    items.push({ draft, folder: column(row, "folder") })
  }
  return { items, skipped }
}

// Export ---------------------------------------------------------------------

type Folder = { id: string; name: string }

function toJsonItem(item: VaultItem) {
  return {
    id: item.id,
    organizationId: null,
    folderId: item.folderId,
    type: TYPES[item.kind as ItemKind],
    reprompt: 0,
    name: item.name,
    notes: item.notes,
    favorite: item.favorite,
    fields: item.fields,
    login: item.login
      ? {
          uris: item.login.uris,
          username: item.login.username,
          password: item.login.password,
          totp: item.login.totp,
          fido2Credentials: [],
        }
      : undefined,
    secureNote: item.kind === "note" ? { type: 0 } : undefined,
    card: item.card ?? undefined,
    identity: item.identity ?? undefined,
    sshKey: item.sshKey ?? undefined,
    collectionIds: null,
    revisionDate: item.revisionDate,
  }
}

const exportable = (items: VaultItem[]) =>
  items.filter((item) => item.kind !== "unknown" && !item.error)

/** Bitwarden's plain JSON export. Everything in it is readable: handle it like the passwords it holds. */
export function exportJson(items: VaultItem[], folders: Folder[]) {
  return JSON.stringify(
    {
      encrypted: false,
      folders: folders.map(({ id, name }) => ({ id, name })),
      items: exportable(items).map(toJsonItem),
    },
    null,
    2
  )
}

/** Bitwarden's password-protected JSON export: the plain export, encrypted with a key derived from the password. */
export async function exportProtectedJson(
  items: VaultItem[],
  folders: Folder[],
  password: string
) {
  const kdf: KdfConfig = { kdf: 0, iterations: 600_000 }
  const salt = toBase64(randomBytes(16))
  const key = await exportKey(password, salt, kdf)
  return JSON.stringify(
    {
      encrypted: true,
      passwordProtected: true,
      salt,
      kdfType: kdf.kdf,
      kdfIterations: kdf.iterations,
      kdfMemory: null,
      kdfParallelism: null,
      encKeyValidation_DO_NOT_EDIT: await encryptString(
        crypto.randomUUID(),
        key
      ),
      data: await encryptString(exportJson(items, folders), key),
    },
    null,
    2
  )
}

const csvCell = (value: string | null) =>
  value === null
    ? ""
    : /[",\n\r]/.test(value)
      ? `"${value.replaceAll('"', '""')}"`
      : value

/** Bitwarden's CSV export: logins and secure notes only. */
export function exportCsv(items: VaultItem[], folders: Folder[]) {
  const folderName = new Map(folders.map((folder) => [folder.id, folder.name]))
  const rows = exportable(items)
    .filter((item) => item.kind === "login" || item.kind === "note")
    .map((item) => [
      item.folderId ? (folderName.get(item.folderId) ?? null) : null,
      item.favorite ? "1" : null,
      item.kind,
      item.name,
      item.notes,
      item.fields.map((f) => `${f.name ?? ""}: ${f.value ?? ""}`).join("\n") ||
        null,
      "0",
      item.login?.uris.map((entry) => entry.uri).join(",") || null,
      item.login?.username ?? null,
      item.login?.password ?? null,
      item.login?.totp ?? null,
    ])
  return [
    CSV_COLUMNS.join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ]
    .join("\n")
    .concat("\n")
}
