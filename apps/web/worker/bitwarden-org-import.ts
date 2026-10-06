import { and, eq, isNull, lt, or } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import {
  vaultCollection,
  vaultOrgCipher,
  vaultOrgCipherCollection,
  vaultOrgImport,
  vaultOrganization,
} from "../db/schema/vault"
import { findVaultUserById } from "./bitwarden-auth"
import {
  getOrgCipherLocator,
  getVaultCollection,
  getVaultMembership,
  getVaultOrganization,
} from "./bitwarden-org"

export type OrgImportPlan = {
  collections: {
    id: string
    name: string
    externalId: string | null
    existing: boolean
  }[]
  ciphers: { id: string; payload: string; collectionIds: string[] }[]
}

export async function startOrgImport(
  env: CloudflareEnv,
  orgId: string,
  userId: string,
  plan: OrgImportPlan
) {
  const id = crypto.randomUUID()
  await drizzle(env.DB)
    .insert(vaultOrgImport)
    .values({
      id,
      orgId,
      userId,
      payload: JSON.stringify(plan),
      createdAt: new Date(),
    })
    .run()
  return id
}

export async function pendingOrgImports(env: CloudflareEnv) {
  return drizzle(env.DB)
    .select({ id: vaultOrgImport.id })
    .from(vaultOrgImport)
    .where(isNull(vaultOrgImport.completedAt))
    .limit(10)
    .all()
}

export async function pruneOrgImports(env: CloudflareEnv) {
  await drizzle(env.DB)
    .delete(vaultOrgImport)
    .where(
      lt(vaultOrgImport.completedAt, new Date(Date.now() - 24 * 60 * 60_000))
    )
    .run()
}

async function publishedOrgImport(
  env: CloudflareEnv,
  orgId: string,
  plan: OrgImportPlan
) {
  if (plan.ciphers.length)
    return !!(await getOrgCipherLocator(env, plan.ciphers[0]!.id))
  const created = plan.collections.find((collection) => !collection.existing)
  return created ? !!(await getVaultCollection(env, orgId, created.id)) : true
}

async function abortOrgImport(
  env: CloudflareEnv,
  row: typeof vaultOrgImport.$inferSelect,
  plan: OrgImportPlan
) {
  const vault = await env.APP_DATABASE.getByName(`org:${row.orgId}`)
  await vault.removeUnpublishedOrgImport(
    plan.ciphers.map((cipher) => cipher.id)
  )
  await drizzle(env.DB)
    .delete(vaultOrgImport)
    .where(eq(vaultOrgImport.id, row.id))
    .run()
}

async function finishOrgImport(env: CloudflareEnv, id: string) {
  await drizzle(env.DB)
    .update(vaultOrgImport)
    .set({ payload: "{}", completedAt: new Date() })
    .where(eq(vaultOrgImport.id, id))
    .run()
}

export async function completeOrgImport(env: CloudflareEnv, id: string) {
  const db = drizzle(env.DB)
  const row = await db
    .select()
    .from(vaultOrgImport)
    .where(eq(vaultOrgImport.id, id))
    .get()
  if (!row) return false
  if (row.completedAt) return true
  const now = new Date()
  const leaseId = crypto.randomUUID()
  const claimed = await db
    .update(vaultOrgImport)
    .set({ leaseId, leaseUntil: new Date(now.getTime() + 15 * 60_000) })
    .where(
      and(
        eq(vaultOrgImport.id, id),
        isNull(vaultOrgImport.completedAt),
        or(
          isNull(vaultOrgImport.leaseUntil),
          lt(vaultOrgImport.leaseUntil, now)
        )
      )
    )
    .returning({ id: vaultOrgImport.id })
    .get()
  if (!claimed) return false
  try {
    const plan = JSON.parse(row.payload) as OrgImportPlan
    if (await publishedOrgImport(env, row.orgId, plan)) {
      await finishOrgImport(env, id)
      return true
    }
    const [organization, member, user] = await Promise.all([
      getVaultOrganization(env, row.orgId),
      getVaultMembership(env, row.orgId, row.userId),
      findVaultUserById(env, row.userId),
    ])
    if (
      !organization ||
      !member ||
      member.role > 1 ||
      !member.accessAll ||
      !user
    ) {
      await abortOrgImport(env, row, plan)
      return false
    }
    for (const collection of plan.collections) {
      if (
        collection.existing &&
        !(await getVaultCollection(env, row.orgId, collection.id))
      ) {
        await abortOrgImport(env, row, plan)
        return false
      }
    }
    const vault = await env.APP_DATABASE.getByName(`org:${row.orgId}`)
    await vault.stageOrgImport(plan.ciphers)
    const createdAt = new Date()
    const statements = [
      ...plan.collections
        .filter((collection) => !collection.existing)
        .map((collection) =>
          db
            .insert(vaultCollection)
            .values({
              id: collection.id,
              orgId: row.orgId,
              name: collection.name,
              externalId: collection.externalId,
              createdAt,
              updatedAt: createdAt,
            })
            .onConflictDoNothing()
        ),
      ...plan.ciphers.map((cipher) =>
        db
          .insert(vaultOrgCipher)
          .values({ id: cipher.id, orgId: row.orgId, createdAt })
          .onConflictDoNothing()
      ),
      ...plan.ciphers.flatMap((cipher) =>
        cipher.collectionIds.map((collectionId) =>
          db
            .insert(vaultOrgCipherCollection)
            .values({ cipherId: cipher.id, collectionId })
            .onConflictDoNothing()
        )
      ),
      db
        .update(vaultOrganization)
        .set({
          updatedAt: new Date(
            Math.max(Date.now(), organization.updatedAt.getTime() + 1)
          ),
        })
        .where(eq(vaultOrganization.id, row.orgId)),
    ]
    const [first, ...rest] = statements
    await db.batch([first!, ...rest])
    await finishOrgImport(env, id)
    return true
  } finally {
    await db
      .update(vaultOrgImport)
      .set({ leaseId: null, leaseUntil: null })
      .where(
        and(eq(vaultOrgImport.id, id), eq(vaultOrgImport.leaseId, leaseId))
      )
      .run()
  }
}

export async function settleOrgImports(
  env: CloudflareEnv,
  owner: { userId: string } | { orgId: string }
) {
  const filter =
    "userId" in owner
      ? eq(vaultOrgImport.userId, owner.userId)
      : eq(vaultOrgImport.orgId, owner.orgId)
  const pending = await drizzle(env.DB)
    .select({ id: vaultOrgImport.id })
    .from(vaultOrgImport)
    .where(and(filter, isNull(vaultOrgImport.completedAt)))
    .limit(10)
    .all()
  for (const row of pending) await completeOrgImport(env, row.id)
  return !(await drizzle(env.DB)
    .select({ id: vaultOrgImport.id })
    .from(vaultOrgImport)
    .where(and(filter, isNull(vaultOrgImport.completedAt)))
    .limit(1)
    .get())
}
