import { and, eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import {
  vaultCollection,
  vaultDirectoryGroupGrant,
  vaultGroup,
  vaultGroupCollection,
  vaultGroupMember,
  vaultMembership,
  vaultOrganization,
} from "../db/schema/vault"

export type VaultGroup = typeof vaultGroup.$inferSelect
export type GroupCollectionInput = {
  id: string
  readOnly: boolean
  hidePasswords: boolean
  manage: boolean
}

export function groupResponse(group: VaultGroup) {
  return {
    id: group.id,
    organizationId: group.orgId,
    name: group.name,
    accessAll: group.accessAll,
    externalId: group.externalId,
    object: "group",
  }
}

export async function listVaultGroups(env: CloudflareEnv, orgId: string) {
  return drizzle(env.DB)
    .select()
    .from(vaultGroup)
    .where(eq(vaultGroup.orgId, orgId))
    .all()
}

export async function getVaultGroup(
  env: CloudflareEnv,
  orgId: string,
  groupId: string
) {
  return drizzle(env.DB)
    .select()
    .from(vaultGroup)
    .where(and(eq(vaultGroup.orgId, orgId), eq(vaultGroup.id, groupId)))
    .get()
}

export async function groupMemberIds(env: CloudflareEnv, groupId: string) {
  const rows = await drizzle(env.DB)
    .select({ id: vaultGroupMember.membershipId })
    .from(vaultGroupMember)
    .where(eq(vaultGroupMember.groupId, groupId))
    .all()
  return rows.map((row) => row.id)
}

export async function memberGroupIds(env: CloudflareEnv, memberId: string) {
  const rows = await drizzle(env.DB)
    .select({ id: vaultGroupMember.groupId })
    .from(vaultGroupMember)
    .where(eq(vaultGroupMember.membershipId, memberId))
    .all()
  return rows.map((row) => row.id)
}

export async function groupCollections(env: CloudflareEnv, groupId: string) {
  const rows = await drizzle(env.DB)
    .select()
    .from(vaultGroupCollection)
    .where(eq(vaultGroupCollection.groupId, groupId))
    .all()
  return rows.map((row) => ({
    id: row.collectionId,
    readOnly: row.readOnly,
    hidePasswords: row.hidePasswords,
    manage: row.manage,
  }))
}

export async function groupDetails(env: CloudflareEnv, group: VaultGroup) {
  return {
    ...groupResponse(group),
    collections: await groupCollections(env, group.id),
    users: await groupMemberIds(env, group.id),
    object: "groupDetails",
  }
}

export async function saveVaultGroup(
  env: CloudflareEnv,
  orgId: string,
  input: {
    id?: string
    name: string
    accessAll: boolean
    externalId: string | null
    collections: GroupCollectionInput[]
    users: string[]
  }
) {
  if (
    input.collections.length > 100 ||
    input.users.length > 100 ||
    new Set(input.collections.map((item) => item.id)).size !==
      input.collections.length ||
    new Set(input.users).size !== input.users.length
  )
    return null
  const db = drizzle(env.DB)
  const [collections, members] = await Promise.all([
    db
      .select({ id: vaultCollection.id })
      .from(vaultCollection)
      .where(eq(vaultCollection.orgId, orgId))
      .all(),
    db
      .select({ id: vaultMembership.id })
      .from(vaultMembership)
      .where(eq(vaultMembership.orgId, orgId))
      .all(),
  ])
  const validCollections = new Set(collections.map((row) => row.id))
  const validMembers = new Set(members.map((row) => row.id))
  if (
    input.collections.some((row) => !validCollections.has(row.id)) ||
    input.users.some((id) => !validMembers.has(id))
  )
    return null
  const existing = input.id ? await getVaultGroup(env, orgId, input.id) : null
  if (input.id && !existing) return null
  const removedMembers = existing
    ? (await groupMemberIds(env, existing.id)).filter(
        (id) => !input.users.includes(id)
      )
    : []
  const now = new Date()
  const group: VaultGroup = {
    id: existing?.id ?? crypto.randomUUID(),
    orgId,
    name: input.name,
    accessAll: input.accessAll,
    externalId: existing?.externalId ?? input.externalId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await db.batch([
    existing
      ? db
          .update(vaultGroup)
          .set({
            name: group.name,
            accessAll: group.accessAll,
            updatedAt: now,
          })
          .where(and(eq(vaultGroup.id, group.id), eq(vaultGroup.orgId, orgId)))
      : db.insert(vaultGroup).values(group),
    db
      .delete(vaultGroupCollection)
      .where(eq(vaultGroupCollection.groupId, group.id)),
    ...(removedMembers.length
      ? [
          db
            .delete(vaultDirectoryGroupGrant)
            .where(
              and(
                eq(vaultDirectoryGroupGrant.groupId, group.id),
                inArray(vaultDirectoryGroupGrant.membershipId, removedMembers)
              )
            ),
        ]
      : []),
    db.delete(vaultGroupMember).where(eq(vaultGroupMember.groupId, group.id)),
    ...input.collections.map((entry) =>
      db.insert(vaultGroupCollection).values({
        groupId: group.id,
        collectionId: entry.id,
        readOnly: entry.readOnly,
        hidePasswords: entry.hidePasswords,
        manage: entry.manage,
      })
    ),
    ...input.users.map((membershipId) =>
      db.insert(vaultGroupMember).values({ groupId: group.id, membershipId })
    ),
    db
      .update(vaultOrganization)
      .set({ updatedAt: now })
      .where(eq(vaultOrganization.id, orgId)),
  ])
  return group
}

export async function deleteVaultGroup(
  env: CloudflareEnv,
  orgId: string,
  groupId: string
) {
  const db = drizzle(env.DB)
  const deleted = await db
    .delete(vaultGroup)
    .where(and(eq(vaultGroup.orgId, orgId), eq(vaultGroup.id, groupId)))
    .returning({ id: vaultGroup.id })
    .get()
  if (deleted)
    await db
      .update(vaultOrganization)
      .set({ updatedAt: new Date() })
      .where(eq(vaultOrganization.id, orgId))
      .run()
  return !!deleted
}

export async function setMemberGroups(
  env: CloudflareEnv,
  orgId: string,
  memberId: string,
  groupIds: string[]
) {
  if (groupIds.length > 100 || new Set(groupIds).size !== groupIds.length)
    return false
  const db = drizzle(env.DB)
  const member = await db
    .select({ id: vaultMembership.id })
    .from(vaultMembership)
    .where(
      and(eq(vaultMembership.orgId, orgId), eq(vaultMembership.id, memberId))
    )
    .get()
  if (!member) return false
  const groups = groupIds.length
    ? await db
        .select({ id: vaultGroup.id })
        .from(vaultGroup)
        .where(
          and(eq(vaultGroup.orgId, orgId), inArray(vaultGroup.id, groupIds))
        )
        .all()
    : []
  if (groups.length !== groupIds.length) return false
  await db.batch([
    db
      .delete(vaultDirectoryGroupGrant)
      .where(eq(vaultDirectoryGroupGrant.membershipId, memberId)),
    db
      .delete(vaultGroupMember)
      .where(eq(vaultGroupMember.membershipId, memberId)),
    ...groupIds.map((groupId) =>
      db.insert(vaultGroupMember).values({ groupId, membershipId: memberId })
    ),
    db
      .update(vaultOrganization)
      .set({ updatedAt: new Date() })
      .where(eq(vaultOrganization.id, orgId)),
  ])
  return true
}
