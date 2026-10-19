"use client"

import { useSyncExternalStore } from "react"
import * as api from "./api.ts"
import {
  decryptBytes,
  decryptOptional,
  decryptString,
  encryptBytes,
  encryptFile,
  encryptOptional,
  encryptString,
} from "./crypto/enc-string.ts"
import type { SymmetricKey } from "./crypto/keys.ts"
import {
  newSendMaterial,
  sendKey,
  sendLink,
  sendPasswordHash,
} from "./crypto/send.ts"
import {
  sessionToken,
  subscribe as subscribeVault,
  getState as vaultState,
  userKey,
} from "./store.ts"

/**
 * The account's Sends, decrypted in memory while the vault is unlocked. Each
 * Send's key material is wrapped with the user key; the link carries it in
 * the clear after the `#`.
 */

export interface Send {
  id: string
  accessId: string
  kind: "text" | "file"
  name: string
  notes: string | null
  text: string | null
  hidden: boolean
  fileName: string | null
  fileSize: string | null
  link: string
  hasPassword: boolean
  disabled: boolean
  hideEmail: boolean
  maxAccessCount: number | null
  accessCount: number
  deletionDate: string
  expirationDate: string | null
  /** Email-verified Sends are made in Bitwarden's apps; this vault shows them but can't edit them. */
  emailAuth: boolean
  material: Uint8Array
  key: SymmetricKey
  raw: api.RawSend
}

export interface SendState {
  loading: boolean
  error: string | null
  sends: Send[]
}

const empty: SendState = { loading: false, error: null, sends: [] }
let state = empty
const listeners = new Set<() => void>()
const set = (patch: Partial<SendState>) => {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export const useSends = () =>
  useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => state,
    () => empty
  )

export const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

subscribeVault(() => {
  if (vaultState().status !== "unlocked" && state !== empty) set(empty)
})

async function decryptSend(raw: api.RawSend): Promise<Send> {
  const material = await decryptBytes(raw.key, userKey())
  const key = await sendKey(material)
  return {
    id: raw.id,
    accessId: raw.accessId,
    kind: raw.type === 1 ? "file" : "text",
    name: await decryptString(raw.name, key).catch(() => "Send"),
    notes: await decryptOptional(raw.notes, key).catch(() => null),
    text: raw.text ? await decryptOptional(raw.text.text, key) : null,
    hidden: raw.text?.hidden ?? false,
    fileName: raw.file ? await decryptString(raw.file.fileName, key) : null,
    fileSize: raw.file?.sizeName ?? null,
    link: sendLink(window.location.origin, raw.accessId, material),
    hasPassword: raw.authType === 1,
    disabled: raw.disabled,
    hideEmail: raw.hideEmail,
    maxAccessCount: raw.maxAccessCount,
    accessCount: raw.accessCount,
    deletionDate: raw.deletionDate,
    expirationDate: raw.expirationDate,
    emailAuth: raw.authType === 0,
    material,
    key,
    raw,
  }
}

export async function load() {
  set({ loading: !state.sends.length, error: null })
  try {
    const raw = await api.sends(await sessionToken())
    const sends = await Promise.all(raw.data.map(decryptSend))
    set({
      loading: false,
      sends: sends.sort((a, b) =>
        b.raw.revisionDate.localeCompare(a.raw.revisionDate)
      ),
    })
  } catch (error) {
    set({ loading: false, error: message(error) })
  }
}

export interface SendDraft {
  name: string
  notes: string | null
  text: string | null
  hidden: boolean
  file: File | null
  /** Empty keeps an existing password; null removes it. */
  password: string | null | ""
  deletionDate: Date
  expirationDate: Date | null
  maxAccessCount: number | null
  hideEmail: boolean
  disabled: boolean
}

/** Bitwarden limits a Send file to 500 MB; this server, to 20 MB encrypted. */
export const MAX_FILE = 20_000_000 - 49 - 16

export async function save(draft: SendDraft, existing?: Send) {
  const token = await sessionToken()
  const material = existing?.material ?? newSendMaterial()
  const key = existing?.key ?? (await sendKey(material))
  const kind = existing?.kind ?? (draft.file ? "file" : "text")
  const body: Record<string, unknown> = {
    type: kind === "file" ? 1 : 0,
    name: await encryptString(draft.name, key),
    notes: await encryptOptional(draft.notes, key),
    key: existing?.raw.key ?? (await encryptBytes(material, userKey())),
    deletionDate: draft.deletionDate.toISOString(),
    expirationDate: draft.expirationDate?.toISOString() ?? null,
    maxAccessCount: draft.maxAccessCount,
    hideEmail: draft.hideEmail,
    disabled: draft.disabled,
    ...(kind === "text"
      ? {
          text: {
            text: await encryptOptional(draft.text, key),
            hidden: draft.hidden,
          },
        }
      : {}),
    ...(draft.password
      ? {
          password: await sendPasswordHash(draft.password, material),
          authType: 1,
        }
      : draft.password === null || (!existing && !draft.password)
        ? { authType: 2 }
        : {}),
  }
  if (existing) {
    if (draft.password === null && existing.hasPassword)
      await api.removeSendPassword(token, existing.id)
    await api.updateSend(token, existing.id, body)
  } else if (kind === "file") {
    const plain = new Uint8Array(await draft.file!.arrayBuffer())
    const encrypted = await encryptFile(plain, key)
    const created = await api.createFileSend(token, {
      ...body,
      file: { fileName: await encryptString(draft.file!.name, key) },
      fileLength: encrypted.length,
    })
    try {
      await api.uploadSendFile(token, created.sendResponse, encrypted)
    } catch (error) {
      // A Send without its file is no use to anyone.
      await api.deleteSend(token, created.sendResponse.id).catch(() => {})
      throw error
    }
  } else await api.createSend(token, body)
  await load()
  return state.sends.find((send) => (existing ? send.id === existing.id : true))
}

export async function remove(send: Send) {
  await api.deleteSend(await sessionToken(), send.id)
  set({ sends: state.sends.filter((entry) => entry.id !== send.id) })
}
