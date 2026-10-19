"use client"

import { useSyncExternalStore } from "react"
import { importPublicKey } from "./crypto/account.ts"
import {
  decryptString,
  encryptRsa,
  encryptString,
} from "./crypto/enc-string.ts"
import { keyBytes } from "./crypto/keys.ts"
import * as org from "./org-api.ts"
import {
  organizationKey,
  resync,
  sessionToken,
  subscribe as subscribeVault,
  getState as vaultState,
} from "./store.ts"

/**
 * Administration state for one organization at a time: its members, groups
 * and collections. Collection names are decrypted here, in memory, and go
 * when the vault locks.
 */

export type Grant = org.Grant

export interface Member {
  id: string
  userId: string
  email: string
  name: string | null
  role: number
  status: number
  twoFactor: boolean
  collections: Grant[]
  groups: string[]
}

export interface Group {
  id: string
  name: string
  collections: Grant[]
  members: string[]
}

export interface Collection {
  id: string
  name: string
  members: Grant[]
  groups: Grant[]
}

export interface OrgState {
  orgId: string | null
  loading: boolean
  error: string | null
  members: Member[]
  groups: Group[]
  collections: Collection[]
}

const empty: OrgState = {
  orgId: null,
  loading: false,
  error: null,
  members: [],
  groups: [],
  collections: [],
}
let state: OrgState = empty
const listeners = new Set<() => void>()
const set = (patch: Partial<OrgState>) => {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

export const useOrg = () =>
  useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => state,
    () => empty
  )

export const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const collator = new Intl.Collator(undefined, { sensitivity: "base" })

async function fetchAll(orgId: string) {
  const token = await sessionToken()
  const key = organizationKey(orgId)
  const [members, groups, collections] = await Promise.all([
    org.members(token, orgId),
    org.groups(token, orgId),
    org.collections(token, orgId),
  ])
  return {
    members: members.data
      .map((raw): Member => ({
        id: raw.id,
        userId: raw.userId,
        email: raw.email,
        name: raw.name,
        role: raw.type,
        status: raw.status,
        twoFactor: raw.twoFactorEnabled,
        collections: raw.collections,
        groups: raw.groups,
      }))
      .sort((a, b) => collator.compare(a.name || a.email, b.name || b.email)),
    groups: groups.data
      .map((raw): Group => ({
        id: raw.id,
        name: raw.name,
        collections: raw.collections,
        members: raw.users,
      }))
      .sort((a, b) => collator.compare(a.name, b.name)),
    collections: (
      await Promise.all(
        collections.data.map(async (raw): Promise<Collection> => ({
          id: raw.id,
          name: await decryptString(raw.name, key).catch(() => "Collection"),
          members: raw.users,
          groups: raw.groups,
        }))
      )
    ).sort((a, b) => collator.compare(a.name, b.name)),
  }
}

/** Loads one organization's members, groups and collections. */
export async function load(orgId: string) {
  set({ ...empty, orgId, loading: true })
  await refresh(orgId)
}

/** Reads the current organization again, keeping what is shown until it arrives. */
export const reload = () => (state.orgId ? refresh(state.orgId) : undefined)

async function refresh(orgId = currentOrg()) {
  try {
    const next = await fetchAll(orgId)
    if (state.orgId === orgId) set({ ...next, loading: false, error: null })
  } catch (error) {
    if (state.orgId === orgId) set({ loading: false, error: message(error) })
  }
}

export const reset = () => set(empty)

// Decrypted names must not outlive the keys.
subscribeVault(() => {
  if (vaultState().status !== "unlocked" && state !== empty) reset()
})

function currentOrg() {
  if (!state.orgId) throw new Error("Choose an organization first")
  return state.orgId
}

/** Runs a change against the current organization, then reads it again. */
async function change(
  action: (token: string, orgId: string) => Promise<unknown>
) {
  const orgId = currentOrg()
  await action(await sessionToken(), orgId)
  await refresh(orgId)
}

export const invite = (input: {
  emails: string[]
  role: number
  collections: Grant[]
  groups: string[]
}) =>
  change((token, orgId) =>
    org.invite(token, orgId, {
      emails: input.emails,
      type: input.role,
      collections: input.collections,
      groups: input.groups,
    })
  )

export const reinvite = (member: Member) =>
  change((token, orgId) => org.reinvite(token, orgId, member.id))

export const updateMember = (
  member: Member,
  input: { role: number; collections: Grant[]; groups: string[] }
) =>
  change((token, orgId) =>
    org.updateMember(token, orgId, member.id, {
      type: input.role,
      // Owners and admins reach every collection.
      collections: input.role === org.ROLES.user ? input.collections : [],
      groups: input.groups,
    })
  )

/**
 * Confirms an accepted member by sharing the organization key with them,
 * encrypted to their public key. Only then can they read its items.
 */
export const confirm = (member: Member) =>
  change(async (token, orgId) => {
    const { publicKey } = await org.userPublicKey(token, member.userId)
    const key = await encryptRsa(
      keyBytes(organizationKey(orgId)),
      await importPublicKey(publicKey)
    )
    await org.confirmMember(token, orgId, member.id, key)
  })

export const removeMember = (member: Member) =>
  change((token, orgId) => org.removeMember(token, orgId, member.id))

export const saveGroup = (
  input: { name: string; collections: Grant[]; members: string[] },
  id?: string
) =>
  change((token, orgId) =>
    org.saveGroup(
      token,
      orgId,
      {
        name: input.name,
        collections: input.collections,
        users: input.members,
      },
      id
    )
  )

export const removeGroup = (group: Group) =>
  change((token, orgId) => org.removeGroup(token, orgId, group.id))

export async function saveCollection(
  input: { name: string; members: Grant[]; groups: Grant[] },
  id?: string
) {
  await change(async (token, orgId) =>
    org.saveCollection(
      token,
      orgId,
      {
        name: await encryptString(input.name, organizationKey(orgId)),
        users: input.members,
        groups: input.groups,
      },
      id
    )
  )
  // The vault's own collection list shows the new name.
  await resync()
}

export async function removeCollection(collection: Collection) {
  await change((token, orgId) =>
    org.removeCollection(token, orgId, collection.id)
  )
  await resync()
}
