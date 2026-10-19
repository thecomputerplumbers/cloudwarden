"use client"

import { useSyncExternalStore } from "react"
import * as api from "./api.ts"
import { unlockAccount, type AccountKeys } from "./crypto/account.ts"
import {
  decryptCipher,
  encryptDraft,
  type ItemDraft,
  type VaultItem,
} from "./crypto/cipher.ts"
import { DecryptionError, decryptOptional } from "./crypto/enc-string.ts"
import {
  hashMasterPassword,
  makeMasterKey,
  normalizeEmail,
  type KdfConfig,
} from "./crypto/kdf.ts"

/**
 * The native vault's state. Keys and decrypted items exist only in this
 * module's memory. Session storage keeps the email, KDF settings and refresh
 * token, so a reload lands on Unlock (master password only) rather than a
 * full sign-in, the way Bitwarden's own clients behave.
 */

import { PERSONAL_VAULT as PERSONAL } from "./filter.ts"
export { PERSONAL }

export interface Vault {
  /** `PERSONAL` for the account's own vault, else the organization ID. */
  id: string
  name: string
  /** 1 to 8: which `vault-N` color the vault wears. */
  color: number
  /** False when its key could not be unwrapped; its items show as unreadable. */
  readable: boolean
  /** The account is an owner or admin of this organization: it may manage Secrets Manager. */
  admin: boolean
}

export interface Folder {
  id: string
  name: string
}

export interface Collection {
  id: string
  vaultId: string
  name: string
  readOnly: boolean
}

export type Status = "signed-out" | "locked" | "loading" | "unlocked"

export interface VaultState {
  status: Status
  email: string | null
  name: string | null
  vaults: Vault[]
  folders: Folder[]
  collections: Collection[]
  items: VaultItem[]
  /** Vault IDs left out of the view. Saved on the server, per account. */
  excluded: Set<string>
  syncing: boolean
  error: string | null
}

const SESSION_KEY = "cloudwarden.session"

interface Persisted {
  email: string
  kdf: KdfConfig
  refreshToken: string
}

const initial: VaultState = {
  status: "signed-out",
  email: null,
  name: null,
  vaults: [],
  folders: [],
  collections: [],
  items: [],
  excluded: new Set(),
  syncing: false,
  error: null,
}

let state: VaultState = initial
const listeners = new Set<() => void>()
let secrets: {
  keys: AccountKeys
  token: string
  refreshToken: string
  expiresAt: number
  kdf: KdfConfig
} | null = null

function set(patch: Partial<VaultState>) {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export const subscribe = (listener: () => void) => (
  listeners.add(listener),
  () => listeners.delete(listener)
)
export const getState = () => state
export const useVault = () =>
  useSyncExternalStore(subscribe, getState, () => initial)

function persisted(): Persisted | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as Persisted) : null
  } catch {
    return null
  }
}

function persist(value: Persisted | null) {
  try {
    if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value))
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // Without session storage a reload simply means signing in again.
  }
}

/** On load: a saved session means the vault is locked, not signed out. */
export function restore() {
  const saved = persisted()
  if (saved && state.status === "signed-out")
    set({ status: "locked", email: saved.email })
}

async function token() {
  if (!secrets) throw new Error("The vault is locked")
  if (secrets.expiresAt - Date.now() < 60_000) {
    const fresh = await api.refresh(secrets.refreshToken)
    secrets.token = fresh.access_token
    secrets.refreshToken = fresh.refresh_token
    secrets.expiresAt = Date.now() + fresh.expires_in * 1000
    persist({
      email: state.email!,
      kdf: secrets.kdf,
      refreshToken: fresh.refresh_token,
    })
  }
  return secrets.token
}

/** A current vault session token, for other parts of the vault (Secrets Manager) that call the API. */
export const sessionToken = () => token()

/** An organization's key, while the vault is unlocked. Never leaves memory. */
export function organizationKey(orgId: string) {
  const key = secrets?.keys.orgKeys.get(orgId)
  if (!key) throw new Error("This organization's key is not available")
  return key
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** Signs in. Returns the second-factor providers when the account needs one; call again with `twoFactor`. */
export async function signIn(input: {
  email: string
  password: string
  twoFactor?: { provider: number; token: string; remember: boolean }
}): Promise<{ providers: number[] } | null> {
  const email = normalizeEmail(input.email)
  set({ status: "loading", error: null, email })
  try {
    const kdf = await api.prelogin(email)
    const masterKey = await makeMasterKey(input.password, email, kdf)
    const passwordHash = await hashMasterPassword(masterKey, input.password)
    const result = await api.passwordLogin({
      email,
      passwordHash,
      ...(input.twoFactor ? { twoFactor: input.twoFactor } : {}),
    })
    if (api.isChallenge(result)) {
      set({ status: "signed-out" })
      return { providers: result.providers }
    }
    await open(email, kdf, masterKey, result)
    return null
  } catch (error) {
    set({ status: "signed-out", error: message(error) })
    throw error
  }
}

/** Sends an email sign-in code, for accounts whose second factor is email. */
export async function sendEmailCode(email: string, password: string) {
  const normalized = normalizeEmail(email)
  const kdf = await api.prelogin(normalized)
  await api.sendEmailCode(
    normalized,
    await hashMasterPassword(
      await makeMasterKey(password, normalized, kdf),
      password
    )
  )
}

/** Unlocks a saved session with the master password alone. */
export async function unlock(password: string) {
  const saved = persisted()
  if (!saved) return void set({ status: "signed-out" })
  set({ status: "loading", error: null })
  try {
    const tokens = await api.refresh(saved.refreshToken)
    const masterKey = await makeMasterKey(password, saved.email, saved.kdf)
    await open(saved.email, saved.kdf, masterKey, tokens)
  } catch (error) {
    // A MAC failure unwrapping the user key is what a wrong password looks like.
    const wrong = error instanceof DecryptionError
    set({
      status: "locked",
      error: wrong
        ? "That master password does not unlock this vault."
        : message(error),
    })
    throw error
  }
}

async function open(
  email: string,
  kdf: KdfConfig,
  masterKey: Uint8Array,
  tokens: api.TokenResponse
) {
  const access = tokens.access_token
  const [data, selection] = await Promise.all([
    api.sync(access),
    api.getVaultSelection(access).catch(() => ({ excluded: [] })),
  ])
  const keys = await unlockAccount({
    masterKey,
    key: tokens.Key ?? tokens.key ?? data.profile.key,
    privateKey:
      tokens.PrivateKey ?? tokens.privateKey ?? data.profile.privateKey,
    organizations: data.profile.organizations.map((org) => ({
      id: org.id,
      key: org.key,
    })),
  })
  secrets = {
    keys,
    token: access,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    kdf,
  }
  persist({ email, kdf, refreshToken: tokens.refresh_token })
  set({ email, name: data.profile.name, excluded: new Set(selection.excluded) })
  await apply(data, keys)
  set({ status: "unlocked" })
}

async function apply(data: api.SyncResponse, keys: AccountKeys) {
  const vaults: Vault[] = [
    { id: PERSONAL, name: "My vault", color: 1, readable: true, admin: false },
    ...data.profile.organizations
      .filter((org) => org.enabled !== false)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((org, index) => ({
        id: org.id,
        name: org.name,
        color: ((index + 1) % 8) + 1,
        readable: keys.orgKeys.has(org.id),
        admin: org.type <= 1,
      })),
  ]
  const folders = await Promise.all(
    data.folders.map(async (folder) => ({
      id: folder.id,
      name:
        (await decryptOptional(folder.name, keys.userKey).catch(() => null)) ??
        "Folder",
    }))
  )
  const collections = await Promise.all(
    data.collections.map(async (collection) => {
      const key = keys.orgKeys.get(collection.organizationId)
      return {
        id: collection.id,
        vaultId: collection.organizationId,
        name:
          (key &&
            (await decryptOptional(collection.name, key).catch(() => null))) ??
          "Collection",
        readOnly: collection.readOnly,
      }
    })
  )
  const items = (
    await Promise.all(data.ciphers.map((raw) => decryptCipher(raw, keys)))
  ).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  )
  set({
    vaults,
    folders: folders.sort((a, b) => a.name.localeCompare(b.name)),
    collections: collections.sort((a, b) => a.name.localeCompare(b.name)),
    items,
  })
}

/** Re-reads the vault from the server. */
export async function resync() {
  if (!secrets) return
  set({ syncing: true })
  try {
    await apply(await api.sync(await token()), secrets.keys)
    set({ error: null })
  } catch (error) {
    set({ error: message(error) })
  } finally {
    set({ syncing: false })
  }
}

export function lock() {
  secrets = null
  set({
    ...initial,
    status: persisted() ? "locked" : "signed-out",
    email: state.email,
  })
}

export function signOut() {
  secrets = null
  persist(null)
  set({ ...initial })
}

let selectionWrite: Promise<unknown> = Promise.resolve()

/** Shows or hides a vault. Saved for the account, so every browser opens with the same selection. */
export function setExcluded(excluded: Set<string>) {
  const previous = state.excluded
  set({ excluded })
  selectionWrite = selectionWrite.then(async () => {
    try {
      await api.putVaultSelection(await token(), [...excluded])
    } catch (error) {
      set({
        excluded: previous,
        error: `Could not save the vault selection: ${message(error)}`,
      })
    }
  })
}

const replace = (item: VaultItem) => {
  const others = state.items.filter((entry) => entry.id !== item.id)
  set({
    items: [...others, item].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    ),
  })
}

/** Creates an item, or updates `previous`. Returns the saved item. */
export async function saveItem(draft: ItemDraft, previous?: VaultItem) {
  if (!secrets) throw new Error("The vault is locked")
  const body = await encryptDraft(draft, secrets.keys, previous)
  const raw = previous
    ? await api.updateCipher(await token(), previous.id, body)
    : await api.createCipher(await token(), body, draft.collectionIds)
  const item = await decryptCipher(raw, secrets.keys)
  replace(item)
  return item
}

export async function toggleFavorite(item: VaultItem) {
  return saveItem(
    {
      kind: item.kind === "unknown" ? "note" : item.kind,
      name: item.name,
      notes: item.notes,
      favorite: !item.favorite,
      folderId: item.folderId,
      organizationId: item.organizationId,
      collectionIds: item.collectionIds,
      ...(item.login ? { login: item.login } : {}),
      card: item.card,
      identity: item.identity,
      sshKey: item.sshKey,
      fields: item.fields,
    },
    item
  )
}

export async function trash(item: VaultItem) {
  await api.trashCipher(await token(), item.id)
  replace({ ...item, deleted: true })
}

export async function restoreItem(item: VaultItem) {
  if (!secrets) throw new Error("The vault is locked")
  replace(
    await decryptCipher(
      await api.restoreCipher(await token(), item.id),
      secrets.keys
    )
  )
}
