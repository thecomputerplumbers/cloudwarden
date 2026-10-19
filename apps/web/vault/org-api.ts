import { json, request } from "./api.ts"

/**
 * Organization administration: members, groups and collections, through the
 * same routes Bitwarden's clients use. Collection names arrive encrypted with
 * the organization key; group names are plain text, as in Bitwarden.
 */

/** Bitwarden's member roles. */
export const ROLES = { owner: 0, admin: 1, user: 2 } as const
/** Invited, then accepted by the member, then confirmed by an admin (who shares the organization key). */
export const STATUS = { invited: 0, accepted: 1, confirmed: 2 } as const

export interface Grant {
  id: string
  readOnly: boolean
  hidePasswords: boolean
  manage: boolean
}

export interface RawMember {
  id: string
  userId: string
  email: string
  name: string | null
  type: number
  status: number
  twoFactorEnabled: boolean
  collections: Grant[]
  groups: string[]
}

export interface RawGroup {
  id: string
  name: string
  collections: Grant[]
  users: string[]
}

export interface RawCollection {
  id: string
  name: string
  users: Grant[]
  groups: Grant[]
}

type List<T> = { data: T[] }

const base = (orgId: string) => `/api/organizations/${orgId}`

export const members = (token: string, orgId: string) =>
  request<List<RawMember>>(`${base(orgId)}/users`, { token })

export const invite = (
  token: string,
  orgId: string,
  body: {
    emails: string[]
    type: number
    collections: Grant[]
    groups: string[]
  }
) =>
  request<null>(`${base(orgId)}/users/invite`, {
    ...json({ ...body, accessAll: false }),
    token,
  })

export const reinvite = (token: string, orgId: string, memberId: string) =>
  request<null>(`${base(orgId)}/users/${memberId}/reinvite`, {
    method: "POST",
    token,
  })

export const updateMember = (
  token: string,
  orgId: string,
  memberId: string,
  body: { type: number; collections: Grant[]; groups: string[] }
) =>
  request<null>(`${base(orgId)}/users/${memberId}`, {
    ...json({ ...body, accessAll: false }),
    method: "PUT",
    token,
  })

export const confirmMember = (
  token: string,
  orgId: string,
  memberId: string,
  key: string
) =>
  request<null>(`${base(orgId)}/users/${memberId}/confirm`, {
    ...json({ key }),
    token,
  })

export const removeMember = (token: string, orgId: string, memberId: string) =>
  request<null>(`${base(orgId)}/users/${memberId}`, {
    method: "DELETE",
    token,
  })

export const userPublicKey = (token: string, userId: string) =>
  request<{ publicKey: string }>(`/api/users/${userId}/public-key`, { token })

export const groups = (token: string, orgId: string) =>
  request<List<RawGroup>>(`${base(orgId)}/groups/details`, { token })

export const saveGroup = (
  token: string,
  orgId: string,
  body: { name: string; collections: Grant[]; users: string[] },
  id?: string
) =>
  request<{ id: string }>(`${base(orgId)}/groups${id ? `/${id}` : ""}`, {
    ...json({ ...body, accessAll: false }),
    method: id ? "PUT" : "POST",
    token,
  })

export const removeGroup = (token: string, orgId: string, id: string) =>
  request<null>(`${base(orgId)}/groups/${id}`, { method: "DELETE", token })

export const collections = (token: string, orgId: string) =>
  request<List<RawCollection>>(`${base(orgId)}/collections/details`, {
    token,
  })

export const saveCollection = (
  token: string,
  orgId: string,
  body: { name: string; users: Grant[]; groups: Grant[] },
  id?: string
) =>
  request<{ id: string }>(`${base(orgId)}/collections${id ? `/${id}` : ""}`, {
    ...json(body),
    method: id ? "PUT" : "POST",
    token,
  })

export const removeCollection = (token: string, orgId: string, id: string) =>
  request<null>(`${base(orgId)}/collections/${id}`, {
    method: "DELETE",
    token,
  })
