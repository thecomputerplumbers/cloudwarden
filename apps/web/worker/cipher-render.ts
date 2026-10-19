// How a stored cipher becomes the JSON clients read. Shared by the Worker
// (single-cipher responses) and the vault Durable Objects (sync), so every
// path produces the same shape.
//
// A cipher's payload is the client's own JSON. The fields that come only from
// the payload are rendered once and cached in `vault_cipher.served`; a SQLite
// trigger clears the cache whenever the payload changes. Sync then builds each
// cipher by joining strings: no JSON.parse per cipher, and none of `field`'s
// case-insensitive key scans.

export type Body = Record<string, unknown>

// Clients send camelCase or PascalCase, so field names match ignoring case and punctuation.
export function field(body: Body, name: string) {
  const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
  const key = Object.keys(body).find(
    (candidate) =>
      candidate.toLowerCase().replaceAll(/[^a-z0-9]/g, "") === normalized
  )
  return key ? body[key] : undefined
}

export function stringField(body: Body, name: string) {
  const value = field(body, name)
  return typeof value === "string" ? value : undefined
}

export function numberField(body: Body, name: string) {
  const value = field(body, name)
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined
}

/** The fields that come from the payload alone, the same for every viewer. */
export function cipherPayloadFields(data: Body) {
  return {
    type: numberField(data, "type"),
    reprompt: numberField(data, "reprompt") ?? 0,
    key: field(data, "key") ?? null,
    name: stringField(data, "name"),
    notes: field(data, "notes") ?? null,
    fields: field(data, "fields") ?? [],
    passwordHistory: field(data, "passwordHistory") ?? [],
    login: field(data, "login") ?? null,
    secureNote: field(data, "secureNote") ?? null,
    card: field(data, "card") ?? null,
    identity: field(data, "identity") ?? null,
    sshKey: field(data, "sshKey") ?? null,
    bankAccount: field(data, "bankAccount") ?? null,
    driversLicense: field(data, "driversLicense") ?? null,
    passport: field(data, "passport") ?? null,
  }
}

/** A personal cipher's folder and favorite, which live in its payload. */
export function personalPlacement(data: Body) {
  return {
    folderId: field(data, "folderId") ?? null,
    favorite: field(data, "favorite") === true,
  }
}

export function attachmentBody(
  attachment: {
    id: string
    cipherId: string
    fileName: string
    key: string | null
    size: number
  },
  token: string,
  userId: string,
  origin: string,
  orgId?: string
) {
  return {
    id: attachment.id,
    url: `${origin}/attachments/${attachment.cipherId}/${attachment.id}?token=${orgId ? `${orgId}:${userId}` : userId}.${token}`,
    fileName: attachment.fileName,
    size: String(attachment.size),
    key: attachment.key,
    object: "attachment",
  }
}

/** An object's members as JSON, without the braces, for joining into a larger object. */
const members = (value: object) => JSON.stringify(value).slice(1, -1)

export interface ServedCipher {
  /** `cipherPayloadFields` as JSON members. */
  served: string
  /** `personalPlacement` as JSON members. */
  servedPersonal: string
}

/** Renders the cached parts of a cipher from its payload. */
export function serveCipher(payload: string): ServedCipher {
  const data = JSON.parse(payload) as Body
  return {
    served: members(cipherPayloadFields(data)),
    servedPersonal: members(personalPlacement(data)),
  }
}

export interface CipherView {
  organizationId: string | null
  /** Rendered attachment objects, or null when there are none. */
  attachments: unknown[] | null
  collectionIds: string[]
  archivedAt: Date | null
  edit: boolean
  viewPassword: boolean
}

/**
 * A cipher as JSON, open at the end: the caller appends the folder and
 * favorite members (from the payload for a personal cipher, from the viewer's
 * preferences for a shared one) and the closing brace.
 */
export function renderCipherOpen(
  row: { id: string; createdAt: Date; updatedAt: Date; deletedAt: Date | null },
  served: string,
  view: CipherView
) {
  return `{${members({
    object: "cipherDetails",
    id: row.id,
    creationDate: row.createdAt.toISOString(),
    revisionDate: row.updatedAt.toISOString(),
    deletedDate: row.deletedAt?.toISOString() ?? null,
    organizationId: view.organizationId,
    attachments: view.attachments,
    organizationUseTotp: true,
    collectionIds: view.collectionIds,
    archivedDate: view.archivedAt?.toISOString() ?? null,
    edit: view.edit,
    viewPassword: view.viewPassword,
    permissions: { delete: view.edit, restore: view.edit },
  })},${served}`
}

/** The members that close a shared cipher for one viewer. */
export function viewerPlacement(
  preference: { folderId: string | null; favorite: boolean } | null | undefined
) {
  return members({
    folderId: preference?.folderId ?? null,
    favorite: preference?.favorite ?? false,
  })
}
