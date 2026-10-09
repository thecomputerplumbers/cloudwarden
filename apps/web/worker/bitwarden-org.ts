import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import {
  vaultCollection,
  vaultCollectionMember,
  vaultDirectoryCollectionGrant,
  vaultGroup,
  vaultGroupCollection,
  vaultGroupMember,
  vaultMembership,
  vaultOrgCipher,
  vaultOrgCipherCollection,
  vaultOrganization,
  vaultCipherTransfer,
  vaultOrgImport,
  vaultUser,
} from "../db/schema/vault"
import { settleVaultShares } from "./bitwarden-share"
import { settleOrgImports } from "./bitwarden-org-import"

export type Organization = typeof vaultOrganization.$inferSelect
export type Membership = typeof vaultMembership.$inferSelect
export type Collection = typeof vaultCollection.$inferSelect

export async function beginOrgDeletion(
  env: CloudflareEnv,
  orgId: string,
  userId: string
) {
  return !!(await drizzle(env.DB)
    .update(vaultOrganization)
    .set({ deletingAt: new Date() })
    .where(
      and(
        eq(vaultOrganization.id, orgId),
        isNull(vaultOrganization.deletingAt),
        sql`exists (select 1 from ${vaultMembership} owner where owner.org_id = ${orgId}
        and owner.user_id = ${userId} and owner.role = 0 and owner.status = 2)`
      )
    )
    .returning({ id: vaultOrganization.id })
    .get())
}

export async function deletingOrganizations(env: CloudflareEnv) {
  return drizzle(env.DB)
    .select({ id: vaultOrganization.id })
    .from(vaultOrganization)
    .where(isNotNull(vaultOrganization.deletingAt))
    .limit(10)
    .all()
}

export async function cleanupOrgDeletion(env: CloudflareEnv, orgId: string) {
  if (!(await settleVaultShares(env, { orgId }))) return false
  if (!(await settleOrgImports(env, { orgId }))) return false
  const vault = await env.APP_DATABASE.getByName(`org:${orgId}`)
  await vault.clearPersonalVault()
  let empty = false
  for (let batch = 0; batch < 20; batch++) {
    const found = await env.VAULT_ATTACHMENTS.list({
      prefix: `org/${orgId}/`,
      limit: 1000,
    })
    if (found.objects.length === 0) {
      empty = !found.truncated
      break
    }
    await env.VAULT_ATTACHMENTS.delete(
      found.objects.map((object) => object.key)
    )
  }
  if (!empty) return false
  return !!(await drizzle(env.DB)
    .delete(vaultOrganization)
    .where(
      and(
        eq(vaultOrganization.id, orgId),
        isNotNull(vaultOrganization.deletingAt),
        sql`not exists (select 1 from ${vaultCipherTransfer} pending where pending.org_id = ${orgId})`,
        sql`not exists (select 1 from ${vaultOrgImport} pending where pending.org_id = ${orgId} and pending.completed_at is null)`
      )
    )
    .returning({ id: vaultOrganization.id })
    .get())
}

export async function listOrgMembers(env: CloudflareEnv, orgId: string) {
  return drizzle(env.DB)
    .select({ membership: vaultMembership, user: vaultUser })
    .from(vaultMembership)
    .innerJoin(vaultUser, eq(vaultUser.id, vaultMembership.userId))
    .where(eq(vaultMembership.orgId, orgId))
    .all()
}

export async function orgMemberCollections(
  env: CloudflareEnv,
  memberId: string
) {
  return drizzle(env.DB)
    .select({
      id: vaultCollectionMember.collectionId,
      readOnly: vaultCollectionMember.readOnly,
      hidePasswords: vaultCollectionMember.hidePasswords,
    })
    .from(vaultCollectionMember)
    .where(eq(vaultCollectionMember.membershipId, memberId))
    .all()
}

export async function setOrgMemberCollections(
  env: CloudflareEnv,
  orgId: string,
  memberId: string,
  collections: { id: string; readOnly: boolean; hidePasswords: boolean }[]
) {
  const db = drizzle(env.DB)
  const member = await db
    .select()
    .from(vaultMembership)
    .where(
      and(
        eq(vaultMembership.id, memberId),
        eq(vaultMembership.orgId, orgId),
        eq(vaultMembership.role, 2)
      )
    )
    .get()
  if (!member) return false
  if (
    collections.length > 50 ||
    new Set(collections.map((item) => item.id)).size !== collections.length
  )
    return false
  for (const collection of collections)
    if (!(await getVaultCollection(env, orgId, collection.id))) return false
  await db.batch([
    db
      .update(vaultMembership)
      .set({ accessAll: false })
      .where(eq(vaultMembership.id, memberId)),
    db
      .delete(vaultDirectoryCollectionGrant)
      .where(eq(vaultDirectoryCollectionGrant.membershipId, memberId)),
    db
      .delete(vaultCollectionMember)
      .where(eq(vaultCollectionMember.membershipId, memberId)),
    ...collections.map((collection) =>
      db.insert(vaultCollectionMember).values({
        collectionId: collection.id,
        membershipId: memberId,
        readOnly: collection.readOnly,
        hidePasswords: collection.hidePasswords,
      })
    ),
  ])
  return true
}

export async function inviteOrgMember(
  env: CloudflareEnv,
  orgId: string,
  userId: string,
  role: number,
  accessAll: boolean,
  collections: { id: string; readOnly: boolean; hidePasswords: boolean }[],
  status = 1
) {
  const db = drizzle(env.DB)
  const member: Membership = {
    id: crypto.randomUUID(),
    orgId,
    userId,
    key: null,
    role,
    status,
    accessAll,
    createdAt: new Date(),
  }
  await db.batch([
    db.insert(vaultMembership).values(member),
    ...collections.map((collection) =>
      db.insert(vaultCollectionMember).values({
        collectionId: collection.id,
        membershipId: member.id,
        readOnly: collection.readOnly,
        hidePasswords: collection.hidePasswords,
      })
    ),
  ])
  return member
}

export async function acceptOrgMember(
  env: CloudflareEnv,
  orgId: string,
  memberId: string,
  userId: string
) {
  return drizzle(env.DB)
    .update(vaultMembership)
    .set({ status: 1 })
    .where(
      and(
        eq(vaultMembership.id, memberId),
        eq(vaultMembership.orgId, orgId),
        eq(vaultMembership.userId, userId),
        eq(vaultMembership.status, 0)
      )
    )
    .returning({ id: vaultMembership.id })
    .get()
}

export async function confirmOrgMember(
  env: CloudflareEnv,
  orgId: string,
  memberId: string,
  key: string
) {
  return drizzle(env.DB)
    .update(vaultMembership)
    .set({ key, status: 2 })
    .where(
      and(
        eq(vaultMembership.id, memberId),
        eq(vaultMembership.orgId, orgId),
        eq(vaultMembership.status, 1)
      )
    )
    .returning()
    .get()
}

export async function removeOrgMember(
  env: CloudflareEnv,
  orgId: string,
  memberId: string
) {
  return drizzle(env.DB)
    .delete(vaultMembership)
    .where(
      and(
        eq(vaultMembership.id, memberId),
        eq(vaultMembership.orgId, orgId),
        eq(vaultMembership.role, 2)
      )
    )
    .returning()
    .get()
}

export async function getOrgCipherLocator(env: CloudflareEnv, id: string) {
  const db = drizzle(env.DB)
  const locator = await db
    .select()
    .from(vaultOrgCipher)
    .where(eq(vaultOrgCipher.id, id))
    .get()
  if (!locator) return null
  const mappings = await db
    .select({ collectionId: vaultOrgCipherCollection.collectionId })
    .from(vaultOrgCipherCollection)
    .where(eq(vaultOrgCipherCollection.cipherId, id))
    .all()
  return { ...locator, collectionIds: mappings.map((row) => row.collectionId) }
}

export async function listOrgCipherLocators(env: CloudflareEnv, orgId: string) {
  const ids = await drizzle(env.DB)
    .select({ id: vaultOrgCipher.id })
    .from(vaultOrgCipher)
    .where(eq(vaultOrgCipher.orgId, orgId))
    .all()
  return Promise.all(ids.map((row) => getOrgCipherLocator(env, row.id)))
}

export async function createOrgCipherLocator(
  env: CloudflareEnv,
  id: string,
  orgId: string,
  collectionIds: string[]
) {
  const db = drizzle(env.DB)
  await db.batch([
    db.insert(vaultOrgCipher).values({ id, orgId, createdAt: new Date() }),
    ...collectionIds.map((collectionId) =>
      db.insert(vaultOrgCipherCollection).values({ cipherId: id, collectionId })
    ),
  ])
}

export async function setOrgCipherCollections(
  env: CloudflareEnv,
  cipherId: string,
  collectionIds: string[]
) {
  const db = drizzle(env.DB)
  await db.batch([
    db
      .delete(vaultOrgCipherCollection)
      .where(eq(vaultOrgCipherCollection.cipherId, cipherId)),
    ...collectionIds.map((collectionId) =>
      db.insert(vaultOrgCipherCollection).values({ cipherId, collectionId })
    ),
  ])
}

export async function deleteOrgCipherLocator(env: CloudflareEnv, id: string) {
  await drizzle(env.DB)
    .delete(vaultOrgCipher)
    .where(eq(vaultOrgCipher.id, id))
    .run()
}

export async function validOrgCollections(
  env: CloudflareEnv,
  orgId: string,
  member: Membership,
  ids: string[]
) {
  if (ids.length === 0 || ids.length > 50 || new Set(ids).size !== ids.length)
    return false
  const available = new Set(
    (await listVaultCollections(env, orgId, member)).map((row) => row.id)
  )
  return ids.every((id) => available.has(id))
}

export async function createVaultOrganization(
  env: CloudflareEnv,
  userId: string,
  input: {
    name: string
    billingEmail: string
    collectionName: string
    key: string
    privateKey: string | null
    publicKey: string | null
  }
) {
  const db = drizzle(env.DB)
  const now = new Date()
  const org: Organization = {
    id: crypto.randomUUID(),
    name: input.name,
    billingEmail: input.billingEmail,
    privateKey: input.privateKey,
    publicKey: input.publicKey,
    createdAt: now,
    updatedAt: now,
    deletingAt: null,
  }
  const member: Membership = {
    id: crypto.randomUUID(),
    orgId: org.id,
    userId,
    key: input.key,
    role: 0,
    status: 2,
    accessAll: true,
    createdAt: now,
  }
  const collection: Collection = {
    id: crypto.randomUUID(),
    orgId: org.id,
    name: input.collectionName,
    externalId: null,
    createdAt: now,
    updatedAt: now,
  }
  await db.batch([
    db.insert(vaultOrganization).values(org),
    db.insert(vaultMembership).values(member),
    db.insert(vaultCollection).values(collection),
  ])
  return { org, member, collection }
}

export async function getVaultOrganization(env: CloudflareEnv, id: string) {
  return (
    (await drizzle(env.DB)
      .select()
      .from(vaultOrganization)
      .where(
        and(eq(vaultOrganization.id, id), isNull(vaultOrganization.deletingAt))
      )
      .get()) ?? null
  )
}

export async function updateVaultOrganization(
  env: CloudflareEnv,
  id: string,
  name: string,
  billingEmail: string
) {
  return drizzle(env.DB)
    .update(vaultOrganization)
    .set({ name, billingEmail, updatedAt: new Date() })
    .where(
      and(eq(vaultOrganization.id, id), isNull(vaultOrganization.deletingAt))
    )
    .returning()
    .get()
}

export async function getVaultMembership(
  env: CloudflareEnv,
  orgId: string,
  userId: string
) {
  return (
    (
      await drizzle(env.DB)
        .select({ membership: vaultMembership })
        .from(vaultMembership)
        .innerJoin(
          vaultOrganization,
          eq(vaultOrganization.id, vaultMembership.orgId)
        )
        .where(
          and(
            eq(vaultMembership.orgId, orgId),
            eq(vaultMembership.userId, userId),
            eq(vaultMembership.status, 2),
            isNull(vaultOrganization.deletingAt)
          )
        )
        .get()
    )?.membership ?? null
  )
}

export async function listVaultOrganizations(
  env: CloudflareEnv,
  userId: string
) {
  return drizzle(env.DB)
    .select({ organization: vaultOrganization, membership: vaultMembership })
    .from(vaultMembership)
    .innerJoin(
      vaultOrganization,
      eq(vaultOrganization.id, vaultMembership.orgId)
    )
    .where(
      and(
        eq(vaultMembership.userId, userId),
        eq(vaultMembership.status, 2),
        isNull(vaultOrganization.deletingAt)
      )
    )
    .all()
}

export async function listVaultCollections(
  env: CloudflareEnv,
  orgId: string,
  membership: Membership
) {
  const db = drizzle(env.DB)
  if (membership.accessAll || membership.role <= 1)
    return db
      .select()
      .from(vaultCollection)
      .where(eq(vaultCollection.orgId, orgId))
      .all()
  const groups = await db
    .select({ id: vaultGroup.id, accessAll: vaultGroup.accessAll })
    .from(vaultGroupMember)
    .innerJoin(vaultGroup, eq(vaultGroup.id, vaultGroupMember.groupId))
    .where(
      and(
        eq(vaultGroupMember.membershipId, membership.id),
        eq(vaultGroup.orgId, orgId)
      )
    )
    .all()
  if (groups.some((group) => group.accessAll))
    return db
      .select()
      .from(vaultCollection)
      .where(eq(vaultCollection.orgId, orgId))
      .all()
  const rows = await db
    .select({ collection: vaultCollection })
    .from(vaultCollectionMember)
    .innerJoin(
      vaultCollection,
      eq(vaultCollection.id, vaultCollectionMember.collectionId)
    )
    .where(
      and(
        eq(vaultCollection.orgId, orgId),
        eq(vaultCollectionMember.membershipId, membership.id)
      )
    )
    .all()
  if (!groups.length) return rows.map((row) => row.collection)
  const groupRows = await db
    .select({ collection: vaultCollection })
    .from(vaultGroupCollection)
    .innerJoin(
      vaultCollection,
      eq(vaultCollection.id, vaultGroupCollection.collectionId)
    )
    .where(
      and(
        eq(vaultCollection.orgId, orgId),
        inArray(
          vaultGroupCollection.groupId,
          groups.map((group) => group.id)
        )
      )
    )
    .all()
  return [
    ...new Map(
      [...rows, ...groupRows].map((row) => [row.collection.id, row.collection])
    ).values(),
  ]
}

export type VaultCollectionRights = {
  readOnly: boolean
  hidePasswords: boolean
  manage: boolean
}

export async function listVaultCollectionRights(
  env: CloudflareEnv,
  orgId: string,
  membership: Membership
) {
  const rights = new Map<string, VaultCollectionRights>()
  if (membership.orgId !== orgId || membership.status !== 2) return rights
  const collections = await listVaultCollections(env, orgId, membership)
  const db = drizzle(env.DB)
  const groups = await db
    .select({ id: vaultGroup.id, accessAll: vaultGroup.accessAll })
    .from(vaultGroupMember)
    .innerJoin(vaultGroup, eq(vaultGroup.id, vaultGroupMember.groupId))
    .where(
      and(
        eq(vaultGroupMember.membershipId, membership.id),
        eq(vaultGroup.orgId, orgId)
      )
    )
    .all()
  if (
    membership.role <= 1 ||
    membership.accessAll ||
    groups.some((group) => group.accessAll)
  ) {
    for (const collection of collections)
      rights.set(collection.id, {
        readOnly: false,
        hidePasswords: false,
        manage: true,
      })
    return rights
  }
  const direct = await db
    .select({
      id: vaultCollectionMember.collectionId,
      readOnly: vaultCollectionMember.readOnly,
      hidePasswords: vaultCollectionMember.hidePasswords,
    })
    .from(vaultCollectionMember)
    .innerJoin(
      vaultCollection,
      eq(vaultCollection.id, vaultCollectionMember.collectionId)
    )
    .where(
      and(
        eq(vaultCollectionMember.membershipId, membership.id),
        eq(vaultCollection.orgId, orgId)
      )
    )
    .all()
  const directById = new Map(direct.map((entry) => [entry.id, entry]))
  const groupRows = groups.length
    ? await db
        .select({
          id: vaultGroupCollection.collectionId,
          readOnly: vaultGroupCollection.readOnly,
          hidePasswords: vaultGroupCollection.hidePasswords,
          manage: vaultGroupCollection.manage,
        })
        .from(vaultGroupCollection)
        .innerJoin(
          vaultCollection,
          eq(vaultCollection.id, vaultGroupCollection.collectionId)
        )
        .where(
          and(
            eq(vaultCollection.orgId, orgId),
            inArray(
              vaultGroupCollection.groupId,
              groups.map((group) => group.id)
            )
          )
        )
        .all()
    : []
  const groupById = new Map<string, VaultCollectionRights>()
  for (const entry of groupRows) {
    const previous = groupById.get(entry.id)
    groupById.set(entry.id, {
      readOnly: (previous?.readOnly ?? true) && entry.readOnly,
      hidePasswords: (previous?.hidePasswords ?? true) && entry.hidePasswords,
      manage: (previous?.manage ?? false) || entry.manage,
    })
  }
  for (const collection of collections) {
    const directGrant = directById.get(collection.id)
    if (directGrant)
      rights.set(collection.id, {
        readOnly: directGrant.readOnly,
        hidePasswords: directGrant.hidePasswords,
        manage: false,
      })
    else {
      const groupGrant = groupById.get(collection.id)
      if (groupGrant) rights.set(collection.id, groupGrant)
    }
  }
  return rights
}

export function cipherCollectionRights(
  rights: Map<string, VaultCollectionRights>,
  collectionIds: string[]
) {
  const visible = collectionIds.filter((id) => rights.has(id))
  if (!visible.length) return null
  const grants = visible.map((id) => rights.get(id)!)
  const readOnly = grants.every((grant) => grant.readOnly)
  const hidePasswords = grants.every((grant) => grant.hidePasswords)
  const manage = grants.some((grant) => grant.manage)
  return {
    collectionIds: visible,
    edit: !readOnly || manage,
    viewPassword: !hidePasswords,
    manage,
  }
}

export async function writableVaultCollections(
  env: CloudflareEnv,
  orgId: string,
  membership: Membership,
  collectionIds: string[]
) {
  if (!collectionIds.length || collectionIds.length > 50) return false
  const rights = await listVaultCollectionRights(env, orgId, membership)
  return collectionIds.every((id) => {
    const grant = rights.get(id)
    return grant && (!grant.readOnly || grant.manage)
  })
}

export async function createVaultCollection(
  env: CloudflareEnv,
  orgId: string,
  name: string,
  externalId: string | null
) {
  const now = new Date()
  return drizzle(env.DB)
    .insert(vaultCollection)
    .values({
      id: crypto.randomUUID(),
      orgId,
      name,
      externalId,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()
}

export async function getVaultCollection(
  env: CloudflareEnv,
  orgId: string,
  id: string
) {
  return (
    (await drizzle(env.DB)
      .select()
      .from(vaultCollection)
      .where(and(eq(vaultCollection.orgId, orgId), eq(vaultCollection.id, id)))
      .get()) ?? null
  )
}

export async function updateVaultCollection(
  env: CloudflareEnv,
  orgId: string,
  id: string,
  name: string,
  externalId: string | null
) {
  return drizzle(env.DB)
    .update(vaultCollection)
    .set({ name, externalId, updatedAt: new Date() })
    .where(and(eq(vaultCollection.orgId, orgId), eq(vaultCollection.id, id)))
    .returning()
    .get()
}

export async function deleteEmptyVaultCollection(
  env: CloudflareEnv,
  orgId: string,
  id: string
) {
  const db = drizzle(env.DB)
  const deleted = await db
    .delete(vaultCollection)
    .where(
      and(
        eq(vaultCollection.orgId, orgId),
        eq(vaultCollection.id, id),
        sql`not exists (select 1 from ${vaultOrgCipherCollection} where ${vaultOrgCipherCollection.collectionId} = ${id})`
      )
    )
    .returning({ id: vaultCollection.id })
    .get()
  if (deleted) return "deleted" as const
  return (await getVaultCollection(env, orgId, id))
    ? ("used" as const)
    : ("missing" as const)
}

export type CollectionGrant = {
  id: string
  readOnly: boolean
  hidePasswords: boolean
  manage: boolean
}

export async function listCollectionAccess(env: CloudflareEnv, orgId: string) {
  const db = drizzle(env.DB)
  const [users, groups] = await Promise.all([
    db
      .select({
        collectionId: vaultCollectionMember.collectionId,
        id: vaultCollectionMember.membershipId,
        readOnly: vaultCollectionMember.readOnly,
        hidePasswords: vaultCollectionMember.hidePasswords,
      })
      .from(vaultCollectionMember)
      .innerJoin(
        vaultCollection,
        eq(vaultCollection.id, vaultCollectionMember.collectionId)
      )
      .where(eq(vaultCollection.orgId, orgId))
      .all(),
    db
      .select({
        collectionId: vaultGroupCollection.collectionId,
        id: vaultGroupCollection.groupId,
        readOnly: vaultGroupCollection.readOnly,
        hidePasswords: vaultGroupCollection.hidePasswords,
        manage: vaultGroupCollection.manage,
      })
      .from(vaultGroupCollection)
      .innerJoin(
        vaultCollection,
        eq(vaultCollection.id, vaultGroupCollection.collectionId)
      )
      .where(eq(vaultCollection.orgId, orgId))
      .all(),
  ])
  const access = new Map<
    string,
    { users: CollectionGrant[]; groups: CollectionGrant[] }
  >()
  const entry = (collectionId: string) => {
    const existing = access.get(collectionId)
    if (existing) return existing
    const created = { users: [], groups: [] }
    access.set(collectionId, created)
    return created
  }
  for (const { collectionId, ...grant } of users)
    entry(collectionId).users.push({ ...grant, manage: false })
  for (const { collectionId, ...grant } of groups)
    entry(collectionId).groups.push(grant)
  return access
}

// Replaces one collection's user and group grants with the given lists.
export async function setCollectionAccess(
  env: CloudflareEnv,
  orgId: string,
  collectionId: string,
  users: CollectionGrant[] | null,
  groups: CollectionGrant[] | null
) {
  const db = drizzle(env.DB)
  const collection = await getVaultCollection(env, orgId, collectionId)
  if (!collection) return false
  const kept = (users ?? []).map((user) => user.id)
  const removals = [
    ...(users
      ? [
          db
            .delete(vaultCollectionMember)
            .where(eq(vaultCollectionMember.collectionId, collectionId)),
          // A grant removed by hand must not come back as a directory grant.
          db
            .delete(vaultDirectoryCollectionGrant)
            .where(
              kept.length
                ? and(
                    eq(
                      vaultDirectoryCollectionGrant.collectionId,
                      collectionId
                    ),
                    notInArray(vaultDirectoryCollectionGrant.membershipId, kept)
                  )
                : eq(vaultDirectoryCollectionGrant.collectionId, collectionId)
            ),
        ]
      : []),
    ...(groups
      ? [
          db
            .delete(vaultGroupCollection)
            .where(eq(vaultGroupCollection.collectionId, collectionId)),
        ]
      : []),
  ]
  // Validate before deleting anything: the grants are re-added below.
  if (
    (users ?? []).length + (groups ?? []).length > 1000 ||
    new Set(kept).size !== kept.length ||
    new Set((groups ?? []).map((group) => group.id)).size !==
      (groups ?? []).length
  )
    return false
  const [members, orgGroups] = await Promise.all([
    db
      .select({ id: vaultMembership.id })
      .from(vaultMembership)
      .where(eq(vaultMembership.orgId, orgId))
      .all(),
    db
      .select({ id: vaultGroup.id })
      .from(vaultGroup)
      .where(eq(vaultGroup.orgId, orgId))
      .all(),
  ])
  const memberIds = new Set(members.map((row) => row.id))
  const groupIds = new Set(orgGroups.map((row) => row.id))
  if (
    !kept.every((id) => memberIds.has(id)) ||
    !(groups ?? []).every((group) => groupIds.has(group.id))
  )
    return false
  const statements = [
    ...removals,
    ...(users ?? []).map((user) =>
      db.insert(vaultCollectionMember).values({
        collectionId,
        membershipId: user.id,
        readOnly: user.readOnly,
        hidePasswords: user.hidePasswords,
      })
    ),
    ...(groups ?? []).map((group) =>
      db.insert(vaultGroupCollection).values({
        groupId: group.id,
        collectionId,
        readOnly: group.readOnly,
        hidePasswords: group.hidePasswords,
        manage: group.manage,
      })
    ),
  ]
  const [first, ...rest] = statements
  if (first) await db.batch([first, ...rest])
  return true
}

// Adds or updates grants on every listed collection; other grants are kept.
export async function grantCollectionAccess(
  env: CloudflareEnv,
  orgId: string,
  collectionIds: string[],
  users: CollectionGrant[],
  groups: CollectionGrant[]
) {
  if (
    !collectionIds.length ||
    collectionIds.length > 50 ||
    collectionIds.length * (users.length + groups.length) > 1000 ||
    new Set(collectionIds).size !== collectionIds.length ||
    new Set(users.map((user) => user.id)).size !== users.length ||
    new Set(groups.map((group) => group.id)).size !== groups.length
  )
    return false
  const db = drizzle(env.DB)
  const [collections, members, orgGroups] = await Promise.all([
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
    db
      .select({ id: vaultGroup.id })
      .from(vaultGroup)
      .where(eq(vaultGroup.orgId, orgId))
      .all(),
  ])
  const known = (rows: { id: string }[], ids: string[]) => {
    const set = new Set(rows.map((row) => row.id))
    return ids.every((id) => set.has(id))
  }
  if (
    !known(collections, collectionIds) ||
    !known(
      members,
      users.map((user) => user.id)
    ) ||
    !known(
      orgGroups,
      groups.map((group) => group.id)
    )
  )
    return false
  const statements = collectionIds.flatMap((collectionId) => [
    ...users.map((user) =>
      db
        .insert(vaultCollectionMember)
        .values({
          collectionId,
          membershipId: user.id,
          readOnly: user.readOnly,
          hidePasswords: user.hidePasswords,
        })
        .onConflictDoUpdate({
          target: [
            vaultCollectionMember.collectionId,
            vaultCollectionMember.membershipId,
          ],
          set: { readOnly: user.readOnly, hidePasswords: user.hidePasswords },
        })
    ),
    ...groups.map((group) =>
      db
        .insert(vaultGroupCollection)
        .values({
          groupId: group.id,
          collectionId,
          readOnly: group.readOnly,
          hidePasswords: group.hidePasswords,
          manage: group.manage,
        })
        .onConflictDoUpdate({
          target: [
            vaultGroupCollection.groupId,
            vaultGroupCollection.collectionId,
          ],
          set: {
            readOnly: group.readOnly,
            hidePasswords: group.hidePasswords,
            manage: group.manage,
          },
        })
    ),
  ])
  const [first, ...rest] = statements
  if (first) await db.batch([first, ...rest])
  return true
}

export async function isLastVaultOwner(env: CloudflareEnv, userId: string) {
  const db = drizzle(env.DB)
  const owned = await db
    .select()
    .from(vaultMembership)
    .where(
      and(
        eq(vaultMembership.userId, userId),
        eq(vaultMembership.role, 0),
        eq(vaultMembership.status, 2)
      )
    )
    .all()
  for (const membership of owned) {
    const owners = await db
      .select({ id: vaultMembership.id })
      .from(vaultMembership)
      .where(
        and(
          eq(vaultMembership.orgId, membership.orgId),
          eq(vaultMembership.role, 0),
          eq(vaultMembership.status, 2)
        )
      )
      .all()
    if (owners.length <= 1) return true
  }
  return false
}

export function organizationResponse(org: Organization) {
  return {
    id: org.id,
    name: org.name,
    businessName: org.name,
    billingEmail: org.billingEmail,
    seats: null,
    maxCollections: null,
    maxStorageGb: 32_767,
    use2fa: true,
    useCustomPermissions: true,
    useDirectory: false,
    useEvents: false,
    useGroups: true,
    useTotp: true,
    usePolicies: false,
    useScim: false,
    useSso: false,
    useKeyConnector: false,
    usePasswordManager: true,
    useSecretsManager: false,
    selfHost: true,
    useApi: false,
    hasPublicAndPrivateKeys: !!(org.privateKey && org.publicKey),
    object: "organization",
  }
}

export function profileOrganizationResponse(
  org: Organization,
  member: Membership
) {
  return {
    id: org.id,
    name: org.name,
    organizationUserId: member.id,
    userId: member.userId,
    key: member.key,
    type: member.role,
    status: member.status,
    enabled: true,
    accessAll: member.accessAll,
    selfHost: true,
    usePasswordManager: true,
    use2fa: true,
    useTotp: true,
    useGroups: true,
    usePolicies: false,
    useSso: false,
    useScim: false,
    hasPublicAndPrivateKeys: !!(org.privateKey && org.publicKey),
    permissions: {
      createNewCollections: member.role === 0,
      editAnyCollection: member.role === 0,
      deleteAnyCollection: member.role === 0,
      manageUsers: member.role === 0,
    },
    object: "profileOrganization",
  }
}

export function collectionResponse(
  collection: Collection,
  member: Membership,
  rights: VaultCollectionRights
) {
  return {
    id: collection.id,
    organizationId: collection.orgId,
    name: collection.name,
    externalId: collection.externalId,
    type: 0,
    defaultUserCollectionEmail: null,
    readOnly: rights.readOnly,
    hidePasswords: rights.hidePasswords,
    manage: member.role <= 1 && rights.manage,
    object: "collectionDetails",
  }
}
