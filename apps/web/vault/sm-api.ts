import { ApiError } from "./api.ts"

/**
 * Secrets Manager admin routes (docs/secrets-manager.md, "Admin routes").
 * Every name, key, value and note is encrypted before it gets here.
 */

export interface RawProject {
  id: string
  organizationId: string
  name: string
  creationDate: string
  revisionDate: string
}

export interface RawSecret {
  id: string
  organizationId: string
  projectId: string
  key: string
  value: string
  note: string | null
  creationDate: string
  revisionDate: string
}

export interface RawToken {
  id: string
  name: string
  expiresAt: string | null
  lastUsedDate: string | null
  creationDate: string
}

export interface RawMachineAccount {
  id: string
  organizationId: string
  name: string
  creationDate: string
  revisionDate: string
  access: { projectId: string; write: boolean }[]
  tokens: RawToken[]
}

export interface RawOverview {
  projects: RawProject[]
  secrets: RawSecret[]
  machineAccounts: RawMachineAccount[]
}

async function request<T>(
  token: string,
  path: string,
  method = "GET",
  body?: unknown
): Promise<T> {
  const response = await fetch(`/api/cloudwarden/sm/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    parsed = null
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      (parsed?.error as string | undefined) ??
        `Request failed (${response.status})`,
      parsed
    )
  return parsed as T
}

const org = (orgId: string) => `orgs/${orgId}`

export const overview = (token: string, orgId: string) =>
  request<RawOverview>(token, org(orgId))

export const createProject = (
  token: string,
  orgId: string,
  body: { id: string; name: string }
) => request<RawProject>(token, `${org(orgId)}/projects`, "POST", body)
export const renameProject = (
  token: string,
  orgId: string,
  id: string,
  name: string
) => request<RawProject>(token, `${org(orgId)}/projects/${id}`, "PUT", { name })
export const deleteProject = (token: string, orgId: string, id: string) =>
  request<null>(token, `${org(orgId)}/projects/${id}`, "DELETE")

export interface SecretBody {
  projectId: string
  key: string
  value: string
  note: string | null
}
export const createSecret = (
  token: string,
  orgId: string,
  body: SecretBody & { id: string }
) => request<RawSecret>(token, `${org(orgId)}/secrets`, "POST", body)
export const updateSecret = (
  token: string,
  orgId: string,
  id: string,
  body: SecretBody
) => request<RawSecret>(token, `${org(orgId)}/secrets/${id}`, "PUT", body)
export const deleteSecret = (token: string, orgId: string, id: string) =>
  request<null>(token, `${org(orgId)}/secrets/${id}`, "DELETE")

export const createMachineAccount = (
  token: string,
  orgId: string,
  body: { id: string; name: string }
) =>
  request<RawMachineAccount>(
    token,
    `${org(orgId)}/machine-accounts`,
    "POST",
    body
  )
export const renameMachineAccount = (
  token: string,
  orgId: string,
  id: string,
  name: string
) =>
  request<RawMachineAccount>(
    token,
    `${org(orgId)}/machine-accounts/${id}`,
    "PUT",
    { name }
  )
export const deleteMachineAccount = (
  token: string,
  orgId: string,
  id: string
) => request<null>(token, `${org(orgId)}/machine-accounts/${id}`, "DELETE")
export const setGrants = (
  token: string,
  orgId: string,
  id: string,
  grants: { projectId: string; write: boolean }[]
) =>
  request<RawMachineAccount>(
    token,
    `${org(orgId)}/machine-accounts/${id}/access`,
    "PUT",
    { grants }
  )
export const createToken = (
  token: string,
  orgId: string,
  id: string,
  body: {
    id: string
    name: string
    secretHash: string
    encryptedPayload: string
    expiresAt: string | null
  }
) =>
  request<RawToken>(
    token,
    `${org(orgId)}/machine-accounts/${id}/tokens`,
    "POST",
    body
  )
export const revokeToken = (
  token: string,
  orgId: string,
  id: string,
  tokenId: string
) =>
  request<null>(
    token,
    `${org(orgId)}/machine-accounts/${id}/tokens/${tokenId}`,
    "DELETE"
  )
