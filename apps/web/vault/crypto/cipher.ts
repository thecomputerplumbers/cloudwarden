import { buffer, toBase64, utf8 } from "./bytes.ts"
import {
  decryptBytes,
  decryptOptional,
  encryptBytes,
  encryptOptional,
  encryptString,
} from "./enc-string.ts"
import { keyBytes, symmetricKey, type SymmetricKey } from "./keys.ts"
import type { AccountKeys } from "./account.ts"

/** A cipher as the server sends it (Bitwarden's `cipherDetails`). Kept whole so unknown fields survive an edit. */
export type RawCipher = Record<string, unknown> & {
  id: string
  type: number
  organizationId: string | null
  folderId: string | null
  favorite: boolean
  key: string | null
  name: string
  notes: string | null
  revisionDate: string
  deletedDate: string | null
  collectionIds: string[]
  edit: boolean
  viewPassword: boolean
  login?: RawLogin | null
  card?: Record<string, string | null> | null
  identity?: Record<string, string | null> | null
  secureNote?: { type: number } | null
  sshKey?: Record<string, string | null> | null
  fields?:
    | {
        name: string | null
        value: string | null
        type: number
        linkedId: number | null
      }[]
    | null
  attachments?:
    | {
        id: string
        fileName: string
        size: string
        url: string
        key: string | null
      }[]
    | null
}

type RawLogin = {
  username: string | null
  password: string | null
  totp: string | null
  passwordRevisionDate?: string | null
  uris?:
    | {
        uri: string | null
        match: number | null
        uriChecksum?: string | null
      }[]
    | null
} & Record<string, unknown>

export const ITEM_TYPES = {
  login: 1,
  note: 2,
  card: 3,
  identity: 4,
  sshKey: 5,
} as const
export type ItemKind = keyof typeof ITEM_TYPES

const CARD_FIELDS = [
  "cardholderName",
  "brand",
  "number",
  "expMonth",
  "expYear",
  "code",
] as const
const IDENTITY_FIELDS = [
  "title",
  "firstName",
  "middleName",
  "lastName",
  "address1",
  "address2",
  "address3",
  "city",
  "state",
  "postalCode",
  "country",
  "company",
  "email",
  "phone",
  "ssn",
  "username",
  "passportNumber",
  "licenseNumber",
] as const
const SSH_FIELDS = ["privateKey", "publicKey", "keyFingerprint"] as const

export interface VaultItem {
  id: string
  kind: ItemKind | "unknown"
  /** The vault it lives in: null for the personal vault, else the organization. */
  organizationId: string | null
  folderId: string | null
  collectionIds: string[]
  favorite: boolean
  deleted: boolean
  revisionDate: string
  canEdit: boolean
  canViewPassword: boolean
  name: string
  notes: string | null
  login: {
    username: string | null
    password: string | null
    totp: string | null
    uris: { uri: string; match: number | null }[]
  } | null
  card: Partial<Record<(typeof CARD_FIELDS)[number], string | null>> | null
  identity: Partial<
    Record<(typeof IDENTITY_FIELDS)[number], string | null>
  > | null
  sshKey: Partial<Record<(typeof SSH_FIELDS)[number], string | null>> | null
  fields: { name: string | null; value: string | null; type: number }[]
  attachments: { id: string; fileName: string; size: number; url: string }[]
  /** Set when the item could not be decrypted; the rest is empty. */
  error: string | null
  /**
   * False for a summary: only what the list and search show is decrypted
   * (name, notes, username, URIs, and each kind's subtitle fields). Passwords,
   * TOTP secrets, custom fields, the rest of a card, identity, or SSH key, and
   * attachments stay null or empty until the item is decrypted in full.
   */
  complete: boolean
  raw: RawCipher
}

const kindOf = (type: number): VaultItem["kind"] =>
  (Object.entries(ITEM_TYPES).find(([, value]) => value === type)?.[0] as
    | ItemKind
    | undefined) ?? "unknown"

/** The key a cipher's fields are encrypted with: its own key when it has one, else its vault's key. */
export async function cipherKey(
  raw: Pick<RawCipher, "organizationId" | "key">,
  keys: AccountKeys
) {
  const vaultKey = raw.organizationId
    ? keys.orgKeys.get(raw.organizationId)
    : keys.userKey
  if (!vaultKey)
    throw new Error("This item's organization key is not available")
  return raw.key
    ? symmetricKey(await decryptBytes(raw.key, vaultKey))
    : vaultKey
}

async function decryptRecord<K extends string>(
  record: Record<string, string | null> | null | undefined,
  names: readonly K[],
  key: SymmetricKey
) {
  if (!record) return null
  const out: Partial<Record<K, string | null>> = {}
  await Promise.all(
    names.map(async (name) => {
      out[name] = await decryptOptional(record[name], key)
    })
  )
  return out
}

// What a summary decrypts of each kind: the list's subtitle and search fields.
const CARD_SUMMARY = ["brand", "number"] as const
const IDENTITY_SUMMARY = ["firstName", "lastName", "email"] as const
const SSH_SUMMARY = ["keyFingerprint"] as const

/**
 * Decrypts an item. A summary (`full` false) decrypts only what the list and
 * search use, which is most of the work saved when a large vault opens.
 */
export async function decryptCipher(
  raw: RawCipher,
  keys: AccountKeys,
  full = true
): Promise<VaultItem> {
  const base: VaultItem = {
    id: raw.id,
    kind: kindOf(raw.type),
    organizationId: raw.organizationId,
    folderId: raw.folderId,
    collectionIds: raw.collectionIds ?? [],
    favorite: raw.favorite,
    deleted: !!raw.deletedDate,
    revisionDate: raw.revisionDate,
    canEdit: raw.edit ?? true,
    canViewPassword: raw.viewPassword ?? true,
    name: "",
    notes: null,
    login: null,
    card: null,
    identity: null,
    sshKey: null,
    fields: [],
    attachments: [],
    error: null,
    complete: full,
    raw,
  }
  try {
    const key = await cipherKey(raw, keys)
    const secret = (value: string | null | undefined) =>
      full ? decryptOptional(value, key) : null
    const login = raw.login
      ? {
          username: await decryptOptional(raw.login.username, key),
          password: await secret(raw.login.password),
          totp: await secret(raw.login.totp),
          uris: (
            await Promise.all(
              (raw.login.uris ?? []).map(async (entry) => ({
                uri: (await decryptOptional(entry.uri, key)) ?? "",
                match: entry.match,
              }))
            )
          ).filter((entry) => entry.uri),
        }
      : null
    return {
      ...base,
      name: (await decryptOptional(raw.name, key)) ?? "",
      notes: await decryptOptional(raw.notes, key),
      login,
      card: await decryptRecord(
        raw.card,
        full ? CARD_FIELDS : CARD_SUMMARY,
        key
      ),
      identity: await decryptRecord(
        raw.identity,
        full ? IDENTITY_FIELDS : IDENTITY_SUMMARY,
        key
      ),
      sshKey: await decryptRecord(
        raw.sshKey,
        full ? SSH_FIELDS : SSH_SUMMARY,
        key
      ),
      fields: await Promise.all(
        (full ? (raw.fields ?? []) : []).map(async (entry) => ({
          name: await decryptOptional(entry.name, key),
          value: await decryptOptional(entry.value, key),
          type: entry.type,
        }))
      ),
      attachments: await Promise.all(
        (full ? (raw.attachments ?? []) : []).map(async (entry) => ({
          id: entry.id,
          fileName:
            (await decryptOptional(entry.fileName, key)) ?? "attachment",
          size: Number(entry.size),
          url: entry.url,
        }))
      ),
    }
  } catch (error) {
    return {
      ...base,
      name: "Unreadable item",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** What the editor produces: the plain fields of an item, without server bookkeeping. */
export interface ItemDraft {
  kind: ItemKind
  name: string
  notes: string | null
  favorite: boolean
  folderId: string | null
  organizationId: string | null
  collectionIds: string[]
  login?: {
    username: string | null
    password: string | null
    totp: string | null
    uris: { uri: string; match: number | null }[]
  }
  card?: VaultItem["card"]
  identity?: VaultItem["identity"]
  sshKey?: VaultItem["sshKey"]
  fields?: { name: string | null; value: string | null; type: number }[]
}

const sha256Base64 = async (text: string) =>
  toBase64(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(utf8(text))))
  )

async function encryptRecord<K extends string>(
  record: Partial<Record<K, string | null>> | null | undefined,
  names: readonly K[],
  key: SymmetricKey
) {
  if (!record) return null
  const out: Record<string, string | null> = {}
  for (const name of names) out[name] = await encryptOptional(record[name], key)
  return out
}

/** Bitwarden keeps the last five passwords a login had. */
const PASSWORD_HISTORY = 5

/**
 * The request body for creating or updating an item. Only request fields are
 * sent, but an edit keeps what this client does not model: unknown login
 * fields (passkeys, future additions), the reprompt setting, and password
 * history, which gains the old password when it changes. A new item gets its
 * own key, wrapped with its vault's key, as current Bitwarden clients do.
 */
export async function encryptDraft(
  draft: ItemDraft,
  keys: AccountKeys,
  previous?: VaultItem
) {
  const existing = previous?.raw
  if (existing && existing.organizationId !== draft.organizationId)
    throw new Error("Moving an item to another vault is a share, not an edit")
  const vaultKey = draft.organizationId
    ? keys.orgKeys.get(draft.organizationId)
    : keys.userKey
  if (!vaultKey) throw new Error("This organization's key is not available")
  let wrappedKey: string | null
  let key: SymmetricKey
  if (existing) {
    key = await cipherKey(existing, keys)
    wrappedKey = existing.key
  } else {
    key = symmetricKey(crypto.getRandomValues(new Uint8Array(64)))
    wrappedKey = await encryptBytes(keyBytes(key), vaultKey)
  }
  const now = new Date().toISOString()
  const oldPassword = previous?.login?.password ?? null
  const passwordChanged =
    !!draft.login &&
    oldPassword !== null &&
    draft.login.password !== oldPassword
  const history =
    (existing?.passwordHistory as
      | { password: string; lastUsedDate: string }[]
      | null
      | undefined) ?? []
  const passwordHistory = passwordChanged
    ? [
        { password: await encryptString(oldPassword!, key), lastUsedDate: now },
        ...history,
      ].slice(0, PASSWORD_HISTORY)
    : history
  const login = draft.login
    ? {
        ...existing?.login,
        username: await encryptOptional(draft.login.username, key),
        password: await encryptOptional(draft.login.password, key),
        totp: await encryptOptional(draft.login.totp, key),
        passwordRevisionDate: passwordChanged
          ? now
          : (existing?.login?.passwordRevisionDate ?? null),
        uris: await Promise.all(
          draft.login.uris.map(async (entry) => ({
            uri: await encryptString(entry.uri, key),
            match: entry.match,
            uriChecksum: await encryptString(
              await sha256Base64(entry.uri),
              key
            ),
          }))
        ),
      }
    : null
  return {
    type: ITEM_TYPES[draft.kind],
    key: wrappedKey,
    organizationId: draft.organizationId,
    folderId: draft.folderId,
    favorite: draft.favorite,
    reprompt: (existing?.reprompt as number | undefined) ?? 0,
    name: await encryptString(draft.name, key),
    notes: await encryptOptional(draft.notes, key),
    login,
    card:
      draft.kind === "card"
        ? await encryptRecord(draft.card, CARD_FIELDS, key)
        : null,
    identity:
      draft.kind === "identity"
        ? await encryptRecord(draft.identity, IDENTITY_FIELDS, key)
        : null,
    sshKey:
      draft.kind === "sshKey"
        ? await encryptRecord(draft.sshKey, SSH_FIELDS, key)
        : null,
    secureNote: draft.kind === "note" ? { type: 0 } : null,
    fields: await Promise.all(
      (draft.fields ?? []).map(async (entry) => ({
        name: await encryptOptional(entry.name, key),
        value: await encryptOptional(entry.value, key),
        type: entry.type,
        linkedId: null,
      }))
    ),
    passwordHistory,
    lastKnownRevisionDate: existing?.revisionDate ?? null,
  }
}
