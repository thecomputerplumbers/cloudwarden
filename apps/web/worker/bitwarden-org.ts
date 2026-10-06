import { and, eq, isNotNull, isNull, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import {
  vaultCollection,
  vaultCollectionMember,
  vaultMembership,
  vaultOrgCipher,
  vaultOrgCipherCollection,
  vaultOrganization,
  vaultUser,
} from "../db/schema/vault"

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
  const vault = await env.APP_DATABASE.getByName(`org:${orgId}`)
  await vault.clearPersonalVault()
  await drizzle(env.DB)
    .delete(vaultOrganization)
    .where(
      and(
        eq(vaultOrganization.id, orgId),
        isNotNull(vaultOrganization.deletingAt)
      )
    )
    .run()
}

export async function listOrgMembers(env: CloudflareEnv, orgId: string) {
  return drizzle(env.DB)
    .select({ membership: vaultMembership, user: vaultUser })
    .from(vaultMembership)
    .innerJoin(vaultUser, eq(vaultUser.id, vaultMembership.userId))
    .where(eq(vaultMembership.orgId, orgId))
    .all()
}

export async function inviteOrgMember(
  env: CloudflareEnv,
  orgId: string,
  userId: string,
  role: number,
  accessAll: boolean,
  collectionIds: string[]
) {
  const db = drizzle(env.DB)
  const member: Membership = {
    id: crypto.randomUUID(),
    orgId,
    userId,
    key: null,
    role,
    status: 1,
    accessAll,
    createdAt: new Date(),
  }
  await db.batch([
    db.insert(vaultMembership).values(member),
    ...collectionIds.map((collectionId) =>
      db.insert(vaultCollectionMember).values({
        collectionId,
        membershipId: member.id,
        readOnly: false,
        hidePasswords: false,
      })
    ),
  ])
  return member
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
  if (membership.accessAll)
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
  return rows.map((row) => row.collection)
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
    useGroups: false,
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
    useGroups: false,
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

export function collectionResponse(collection: Collection, member: Membership) {
  return {
    id: collection.id,
    organizationId: collection.orgId,
    name: collection.name,
    externalId: collection.externalId,
    type: 0,
    defaultUserCollectionEmail: null,
    readOnly: !member.accessAll,
    hidePasswords: false,
    manage: member.role === 0,
    object: "collectionDetails",
  }
}
