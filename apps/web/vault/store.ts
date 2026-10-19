"use client"

import { useSyncExternalStore } from "react"
import * as api from "./api.ts"
import {
  newAccount,
  unlockAccount,
  type AccountKeys,
} from "./crypto/account.ts"
import {
  decryptCipher,
  encryptDraft,
  type ItemDraft,
  type VaultItem,
} from "./crypto/cipher.ts"
import {
  DecryptionError,
  decryptOptional,
  encryptBytes,
  encryptString,
} from "./crypto/enc-string.ts"
import {
  decryptSummaries,
  stop as stopDecryptor,
  warmDecryptor,
} from "./decryptor.ts"
import {
  hashMasterPassword,
  makeMasterKey,
  normalizeEmail,
  stretchMasterKey,
  type KdfConfig,
} from "./crypto/kdf.ts"
import { keyBytes } from "./crypto/keys.ts"
import type { ImportedItem } from "./transfer.ts"

/**
 * The native vault's state. Keys and decrypted items exist only in this
 * module's memory. Session storage keeps the email, KDF settings and refresh
 * token, so a reload lands on Unlock (master password only) rather than a
 * full sign-in, the way Bitwarden's own clients behave.
 */

import { PERSONAL_VAULT as PERSONAL } from "./filter.ts"
export { PERSONAL }

// One collator for every sort: localeCompare with options builds a new one per comparison.
const byName = new Intl.Collator(undefined, { sensitivity: "base" })

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

/** The signed-in account's key derivation settings. */
export function currentKdf() {
  if (!secrets) throw new Error("The vault is locked")
  return secrets.kdf
}

/** The hash the server checks when an action asks for the master password again. */
export async function masterPasswordHash(password: string) {
  return hashMasterPassword(
    await makeMasterKey(password, state.email!, currentKdf()),
    password
  )
}

/**
 * Changes the master password, the key derivation settings, or both. The
 * user key stays the same, so nothing in the vault is re-encrypted; only its
 * wrapping changes. The server keeps this session and ends every other one.
 */
export async function changeMasterPassword(input: {
  current: string
  next: string
  /** Left as it is when undefined. */
  hint?: string | null
  kdf?: KdfConfig
}) {
  const email = state.email!
  const kdf = input.kdf ?? currentKdf()
  const [currentHash, masterKey] = await Promise.all([
    masterPasswordHash(input.current),
    makeMasterKey(input.next, email, kdf),
  ])
  const nextHash = await hashMasterPassword(masterKey, input.next)
  const key = await encryptBytes(
    keyBytes(secrets!.keys.userKey),
    await stretchMasterKey(masterKey)
  )
  const access = await token()
  if (input.kdf) {
    const settings = {
      kdfType: kdf.kdf,
      iterations: kdf.iterations,
      memory: kdf.kdf === 1 ? kdf.memory : null,
      parallelism: kdf.kdf === 1 ? kdf.parallelism : null,
    }
    await api.changeKdf(access, {
      masterPasswordHash: currentHash,
      masterPasswordHint: input.hint,
      authenticationData: {
        kdf: settings,
        masterPasswordAuthenticationHash: nextHash,
        salt: email,
      },
      unlockData: { kdf: settings, masterKeyWrappedUserKey: key, salt: email },
    })
  } else
    await api.changePassword(access, {
      masterPasswordHash: currentHash,
      newMasterPasswordHash: nextHash,
      masterPasswordHint: input.hint,
      key,
    })
  if (!secrets) return
  secrets.kdf = kdf
  persist({ email, kdf, refreshToken: secrets.refreshToken })
}

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

/** Bitwarden's default for new accounts. */
const NEW_ACCOUNT_KDF: KdfConfig = { kdf: 0, iterations: 600_000 }

/**
 * Creates an account, then signs in to it. Registration needs either the
 * token from a sign-up link or an organization invitation.
 */
export async function createAccount(input: {
  email: string
  name: string
  password: string
  hint: string
  emailVerificationToken?: string
  invite?: { memberId: string; token: string }
}) {
  const email = normalizeEmail(input.email)
  const account = await newAccount(email, input.password, NEW_ACCOUNT_KDF)
  await api.register({
    email,
    name: input.name || null,
    masterPasswordHash: account.masterPasswordHash,
    masterPasswordHint: input.hint || null,
    key: account.key,
    keys: account.keys,
    kdf: NEW_ACCOUNT_KDF.kdf,
    kdfIterations: NEW_ACCOUNT_KDF.iterations,
    ...(input.emailVerificationToken
      ? { emailVerificationToken: input.emailVerificationToken }
      : {}),
    ...(input.invite
      ? {
          orgInviteToken: input.invite.token,
          organizationUserId: input.invite.memberId,
        }
      : {}),
  })
  // The account exists now; a failed sign-in shows on the sign-in screen.
  await signIn({ email, password: input.password }).catch(() => {})
}

/** Accepts an organization invitation for the signed-in account. An admin still confirms it before the organization's items appear. */
export async function acceptInvite(invite: {
  orgId: string
  memberId: string
  token: string
}) {
  await api.acceptInvite(
    await token(),
    invite.orgId,
    invite.memberId,
    invite.token
  )
  await resync()
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
    // The session refresh is a round trip and key derivation is local work: run both at once.
    const [tokens, masterKey] = await Promise.all([
      api.refresh(saved.refreshToken).then((fresh) => {
        // Keep the rotated refresh token even if the password turns out wrong.
        persist({ ...saved, refreshToken: fresh.refresh_token })
        return fresh
      }),
      makeMasterKey(password, saved.email, saved.kdf),
    ])
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
  warmDecryptor()
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
  const items = (await decryptSummaries(data.ciphers, keys)).sort((a, b) =>
    byName.compare(a.name, b.name)
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
  stopDecryptor()
  set({
    ...initial,
    status: persisted() ? "locked" : "signed-out",
    email: state.email,
  })
}

export function signOut() {
  secrets = null
  stopDecryptor()
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
    items: [...others, item].sort((a, b) => byName.compare(a.name, b.name)),
  })
}

/**
 * An item decrypted in full. The vault opens with summaries; an item's
 * secrets are decrypted the first time it is opened, then kept in the store.
 */
export async function loadItem(item: VaultItem) {
  if (item.complete) return item
  if (!secrets) throw new Error("The vault is locked")
  const full = await decryptCipher(item.raw, secrets.keys)
  // A sync may have replaced the item meanwhile; only fill in the same revision.
  set({
    items: state.items.map((entry) =>
      entry.id === full.id && entry.raw === item.raw ? full : entry
    ),
  })
  return full
}

/** Creates an item, or updates `previous`. Returns the saved item. */
export async function saveItem(draft: ItemDraft, previous?: VaultItem) {
  if (!secrets) throw new Error("The vault is locked")
  // Password history compares against the previous password.
  if (previous) previous = await loadItem(previous)
  const body = await encryptDraft(draft, secrets.keys, previous)
  const raw = previous
    ? await api.updateCipher(await token(), previous.id, body)
    : await api.createCipher(await token(), body, draft.collectionIds)
  const item = await decryptCipher(raw, secrets.keys)
  replace(item)
  return item
}

export async function toggleFavorite(item: VaultItem) {
  item = await loadItem(item)
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

/** The personal vault in full, for an export: every item decrypted, and its folders. */
export async function personalVault() {
  if (!secrets) throw new Error("The vault is locked")
  const keys = secrets.keys
  const items = await Promise.all(
    state.items
      .filter((item) => !item.organizationId && !item.deleted)
      .map((item) =>
        item.complete ? item : decryptCipher(item.raw, keys, true)
      )
  )
  return { items, folders: state.folders }
}

const IMPORT_BATCH = 1000

/**
 * Imports items into the personal vault, creating the folders they name
 * that don't exist yet. Every item is encrypted here, with its own key.
 */
export async function importItems(items: ImportedItem[]) {
  if (!secrets) throw new Error("The vault is locked")
  const keys = secrets.keys
  const access = await token()
  const folderIds = new Map(state.folders.map((f) => [f.name, f.id]))
  for (const name of new Set(items.map((item) => item.folder))) {
    if (!name || folderIds.has(name)) continue
    const created = await api.createFolder(
      access,
      await encryptString(name, keys.userKey)
    )
    folderIds.set(name, created.id)
  }
  const names = [...folderIds.keys()]
  const folderIndex = new Map(names.map((name, index) => [name, index]))
  // Each folder already exists; its encrypted name only matters if it was deleted meanwhile.
  const folders = await Promise.all(
    names.map(async (name) => ({
      id: folderIds.get(name)!,
      name: await encryptString(name, keys.userKey),
    }))
  )
  for (let start = 0; start < items.length; start += IMPORT_BATCH) {
    const batch = items.slice(start, start + IMPORT_BATCH)
    const ciphers = await Promise.all(
      batch.map((item) => encryptDraft(item.draft, keys))
    )
    await api.importVault(await token(), {
      ciphers,
      folders,
      folderRelationships: batch.flatMap((item, key) =>
        item.folder ? [{ key, value: folderIndex.get(item.folder)! }] : []
      ),
    })
  }
  await resync()
}
