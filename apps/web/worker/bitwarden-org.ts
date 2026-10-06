import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import {
  vaultCollection,
  vaultCollectionMember,
  vaultMembership,
  vaultOrganization,
} from "../db/schema/vault"

export type Organization = typeof vaultOrganization.$inferSelect
export type Membership = typeof vaultMembership.$inferSelect
export type Collection = typeof vaultCollection.$inferSelect

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
      .where(eq(vaultOrganization.id, id))
      .get()) ?? null
  )
}

export async function getVaultMembership(
  env: CloudflareEnv,
  orgId: string,
  userId: string
) {
  return (
    (await drizzle(env.DB)
      .select()
      .from(vaultMembership)
      .where(
        and(
          eq(vaultMembership.orgId, orgId),
          eq(vaultMembership.userId, userId),
          eq(vaultMembership.status, 2)
        )
      )
      .get()) ?? null
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
      and(eq(vaultMembership.userId, userId), eq(vaultMembership.status, 2))
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
