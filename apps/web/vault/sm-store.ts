"use client"

import { useSyncExternalStore } from "react"
import { createAccessToken } from "./crypto/secrets.ts"
import {
  decryptOptional,
  decryptString,
  encryptOptional,
  encryptString,
} from "./crypto/enc-string.ts"
import * as sm from "./sm-api.ts"
import {
  organizationKey,
  sessionToken,
  subscribe as subscribeVault,
  getState as vaultState,
} from "./store.ts"

const collator = new Intl.Collator(undefined, { sensitivity: "base" })

/**
 * Secrets Manager state for one organization at a time. Decrypted names and
 * values live only here, in memory, and go when the vault locks or the
 * organization changes.
 */

export interface Project {
  id: string
  name: string
  revisionDate: string
}

export interface Secret {
  id: string
  projectId: string
  key: string
  value: string
  note: string | null
  revisionDate: string
}

export interface AccessTokenInfo {
  id: string
  name: string
  expiresAt: string | null
  lastUsedDate: string | null
  creationDate: string
}

export interface MachineAccount {
  id: string
  name: string
  revisionDate: string
  access: { projectId: string; write: boolean }[]
  tokens: AccessTokenInfo[]
}

export interface SmState {
  orgId: string | null
  loading: boolean
  error: string | null
  projects: Project[]
  secrets: Secret[]
  machineAccounts: MachineAccount[]
}

const empty: SmState = {
  orgId: null,
  loading: false,
  error: null,
  projects: [],
  secrets: [],
  machineAccounts: [],
}
let state: SmState = empty
const listeners = new Set<() => void>()
const set = (patch: Partial<SmState>) => {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}
export const useSecrets = () =>
  useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => state,
    () => empty
  )

export const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const byName = <T extends { name: string }>(a: T, b: T) =>
  collator.compare(a.name, b.name)

async function decryptAccount(
  raw: sm.RawMachineAccount,
  orgId: string
): Promise<MachineAccount> {
  const key = organizationKey(orgId)
  return {
    id: raw.id,
    name:
      (await decryptOptional(raw.name, key).catch(() => null)) ??
      "Machine account",
    revisionDate: raw.revisionDate,
    access: raw.access,
    tokens: await Promise.all(
      raw.tokens.map(async (token) => ({
        ...token,
        name:
          (await decryptOptional(token.name, key).catch(() => null)) ??
          "Access token",
      }))
    ),
  }
}

async function decryptSecret(
  raw: sm.RawSecret,
  orgId: string
): Promise<Secret> {
  const key = organizationKey(orgId)
  return {
    id: raw.id,
    projectId: raw.projectId,
    key: await decryptString(raw.key, key),
    value: await decryptString(raw.value, key),
    note: await decryptOptional(raw.note, key),
    revisionDate: raw.revisionDate,
  }
}

/** Loads one organization's projects, secrets, and machine accounts. */
export async function load(orgId: string) {
  set({ ...empty, orgId, loading: true })
  try {
    const raw = await sm.overview(await sessionToken(), orgId)
    const key = organizationKey(orgId)
    const projects = await Promise.all(
      raw.projects.map(async (project) => ({
        id: project.id,
        name:
          (await decryptOptional(project.name, key).catch(() => null)) ??
          "Project",
        revisionDate: project.revisionDate,
      }))
    )
    const secrets = await Promise.all(
      raw.secrets.map((secret) => decryptSecret(secret, orgId))
    )
    const machineAccounts = await Promise.all(
      raw.machineAccounts.map((account) => decryptAccount(account, orgId))
    )
    if (state.orgId !== orgId) return
    set({
      loading: false,
      projects: projects.sort(byName),
      secrets: secrets.sort((a, b) => a.key.localeCompare(b.key)),
      machineAccounts: machineAccounts.sort(byName),
    })
  } catch (error) {
    if (state.orgId === orgId) set({ loading: false, error: message(error) })
  }
}

export const reset = () => set(empty)

// Decrypted secrets must not outlive the keys: clear them whenever the vault locks or signs out.
subscribeVault(() => {
  if (vaultState().status !== "unlocked" && state !== empty) reset()
})

function currentOrg() {
  if (!state.orgId) throw new Error("Choose an organization first")
  return state.orgId
}

const enc = (orgId: string, text: string) =>
  encryptString(text, organizationKey(orgId))

export async function saveProject(name: string, id?: string) {
  const orgId = currentOrg()
  const token = await sessionToken()
  const encrypted = await enc(orgId, name)
  const raw = id
    ? await sm.renameProject(token, orgId, id, encrypted)
    : await sm.createProject(token, orgId, {
        id: crypto.randomUUID(),
        name: encrypted,
      })
  const project = { id: raw.id, name, revisionDate: raw.revisionDate }
  set({
    projects: [
      ...state.projects.filter((entry) => entry.id !== raw.id),
      project,
    ].sort(byName),
  })
  return project
}

export async function removeProject(id: string) {
  const orgId = currentOrg()
  await sm.deleteProject(await sessionToken(), orgId, id)
  set({
    projects: state.projects.filter((entry) => entry.id !== id),
    machineAccounts: state.machineAccounts.map((account) => ({
      ...account,
      access: account.access.filter((grant) => grant.projectId !== id),
    })),
  })
}

export async function saveSecret(
  input: { projectId: string; key: string; value: string; note: string | null },
  id?: string
) {
  const orgId = currentOrg()
  const token = await sessionToken()
  const key = organizationKey(orgId)
  const body = {
    projectId: input.projectId,
    key: await encryptString(input.key, key),
    value: await encryptString(input.value, key),
    note: await encryptOptional(input.note, key),
  }
  const raw = id
    ? await sm.updateSecret(token, orgId, id, body)
    : await sm.createSecret(token, orgId, { id: crypto.randomUUID(), ...body })
  const secret = await decryptSecret(raw, orgId)
  set({
    secrets: [
      ...state.secrets.filter((entry) => entry.id !== raw.id),
      secret,
    ].sort((a, b) => a.key.localeCompare(b.key)),
  })
  return secret
}

export async function removeSecret(id: string) {
  const orgId = currentOrg()
  await sm.deleteSecret(await sessionToken(), orgId, id)
  set({ secrets: state.secrets.filter((entry) => entry.id !== id) })
}

const replaceAccount = async (raw: sm.RawMachineAccount, orgId: string) => {
  const account = await decryptAccount(raw, orgId)
  set({
    machineAccounts: [
      ...state.machineAccounts.filter((entry) => entry.id !== raw.id),
      account,
    ].sort(byName),
  })
  return account
}

export async function saveMachineAccount(name: string, id?: string) {
  const orgId = currentOrg()
  const token = await sessionToken()
  const encrypted = await enc(orgId, name)
  const raw = id
    ? await sm.renameMachineAccount(token, orgId, id, encrypted)
    : await sm.createMachineAccount(token, orgId, {
        id: crypto.randomUUID(),
        name: encrypted,
      })
  return replaceAccount(raw, orgId)
}

export async function removeMachineAccount(id: string) {
  const orgId = currentOrg()
  await sm.deleteMachineAccount(await sessionToken(), orgId, id)
  set({
    machineAccounts: state.machineAccounts.filter((entry) => entry.id !== id),
  })
}

export async function saveGrants(
  id: string,
  grants: { projectId: string; write: boolean }[]
) {
  const orgId = currentOrg()
  return replaceAccount(
    await sm.setGrants(await sessionToken(), orgId, id, grants),
    orgId
  )
}

/** Creates an access token. Returns the token string, which is shown once and never stored. */
export async function newAccessToken(
  accountId: string,
  name: string,
  expiresAt: string | null
) {
  const orgId = currentOrg()
  const created = await createAccessToken(orgId, organizationKey(orgId))
  await sm.createToken(await sessionToken(), orgId, accountId, {
    ...created.request,
    name: await enc(orgId, name),
    expiresAt,
  })
  const account = state.machineAccounts.find((entry) => entry.id === accountId)
  if (account)
    set({
      machineAccounts: state.machineAccounts.map((entry) =>
        entry.id === accountId
          ? {
              ...entry,
              tokens: [
                ...entry.tokens,
                {
                  id: created.request.id,
                  name,
                  expiresAt,
                  lastUsedDate: null,
                  creationDate: new Date().toISOString(),
                },
              ],
            }
          : entry
      ),
    })
  return created.token
}

export async function revokeAccessToken(accountId: string, tokenId: string) {
  const orgId = currentOrg()
  await sm.revokeToken(await sessionToken(), orgId, accountId, tokenId)
  set({
    machineAccounts: state.machineAccounts.map((entry) =>
      entry.id === accountId
        ? {
            ...entry,
            tokens: entry.tokens.filter((token) => token.id !== tokenId),
          }
        : entry
    ),
  })
}
