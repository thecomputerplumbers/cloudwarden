import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import {
  vaultDirectoryIdentity,
  vaultMembership,
  vaultUser,
} from "../db/schema/vault"
import { readVaultDirectory } from "./bitwarden-directory"
import { getVaultOrganization } from "./bitwarden-org"

type DirectoryConfig = CloudflareEnv & {
  SCIM_DIRECTORY_URL?: string
  SCIM_TOKEN?: string
  SCIM_ORGANIZATION_ID?: string
  SCIM_INVITATIONS_ENABLED?: string
}

/** Reconcile only identities previously linked by this directory sync. */
export async function reconcileVaultDirectory(
  env: CloudflareEnv,
  fetcher: typeof fetch = fetch
) {
  const config = env as DirectoryConfig
  if (
    !config.SCIM_DIRECTORY_URL ||
    !config.SCIM_TOKEN ||
    !config.SCIM_ORGANIZATION_ID
  )
    return
  const orgId = config.SCIM_ORGANIZATION_ID
  if (!(await getVaultOrganization(env, orgId)))
    throw new Error("SCIM organization is unavailable")

  // A failed or changing page must never revoke a membership.
  const users = await readVaultDirectory(
    config.SCIM_DIRECTORY_URL,
    config.SCIM_TOKEN,
    fetcher
  )
  const db = drizzle(env.DB)
  const known = await db
    .select()
    .from(vaultDirectoryIdentity)
    .where(eq(vaultDirectoryIdentity.orgId, orgId))
    .all()
  const byId = new Map(known.map((identity) => [identity.externalId, identity]))
  const current = new Map(users.map((user) => [user.id, user]))
  const now = new Date()

  // Revoke links whose identity disappeared, was disabled, or changed email.
  // The role condition protects owners even if an operator later changes one.
  for (const identity of known) {
    const user = current.get(identity.externalId)
    if (user?.active && user.email === identity.email) continue
    const revoke =
      identity.membershipId &&
      db
        .update(vaultMembership)
        .set({ status: 3 })
        .where(
          and(
            eq(vaultMembership.id, identity.membershipId),
            eq(vaultMembership.orgId, orgId),
            eq(vaultMembership.role, 2)
          )
        )
    const update = db
      .update(vaultDirectoryIdentity)
      .set({
        active: false,
        updatedAt: now,
      })
      .where(eq(vaultDirectoryIdentity.id, identity.id))
    if (revoke) await db.batch([revoke, update])
    else await update.run()
  }

  for (const user of users) {
    let identity = byId.get(user.id)
    if (!identity) {
      identity = await db
        .insert(vaultDirectoryIdentity)
        .values({
          id: crypto.randomUUID(),
          orgId,
          externalId: user.id,
          email: user.email,
          name: user.name,
          active: user.active,
          membershipId: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get()
    } else {
      await db
        .update(vaultDirectoryIdentity)
        .set({
          email: user.email,
          name: user.name,
          active: user.active,
          updatedAt: now,
        })
        .where(eq(vaultDirectoryIdentity.id, identity.id))
        .run()
    }
    if (!user.active || !identity) continue
    if (identity.membershipId) {
      const membership = await db
        .select({ membership: vaultMembership, account: vaultUser })
        .from(vaultMembership)
        .innerJoin(vaultUser, eq(vaultUser.id, vaultMembership.userId))
        .where(
          and(
            eq(vaultMembership.id, identity.membershipId),
            eq(vaultMembership.orgId, orgId)
          )
        )
        .get()
      if (!membership) {
        await db
          .update(vaultDirectoryIdentity)
          .set({ membershipId: null })
          .where(eq(vaultDirectoryIdentity.id, identity.id))
          .run()
        identity.membershipId = null
      } else if (
        membership?.membership.role === 2 &&
        (membership.account.email !== user.email ||
          membership.account.deletingAt)
      ) {
        await db
          .update(vaultMembership)
          .set({ status: 3 })
          .where(eq(vaultMembership.id, identity.membershipId))
          .run()
        const replacement = await db
          .select({ id: vaultUser.id })
          .from(vaultUser)
          .where(eq(vaultUser.email, user.email))
          .get()
        if (replacement && replacement.id !== membership.account.id) {
          await db
            .update(vaultDirectoryIdentity)
            .set({ membershipId: null })
            .where(eq(vaultDirectoryIdentity.id, identity.id))
            .run()
          identity.membershipId = null
        }
      } else if (
        membership?.membership.role === 2 &&
        membership.membership.status === 3
      )
        await db
          .update(vaultMembership)
          .set({ status: membership.membership.key ? 2 : 1 })
          .where(eq(vaultMembership.id, membership.membership.id))
          .run()
      if (identity.membershipId) continue
    }
    if (config.SCIM_INVITATIONS_ENABLED !== "true") continue
    const account = await db
      .select({
        id: vaultUser.id,
        publicKey: vaultUser.publicKey,
        deletingAt: vaultUser.deletingAt,
      })
      .from(vaultUser)
      .where(eq(vaultUser.email, user.email))
      .get()
    if (!account?.publicKey || account.deletingAt) continue
    const existing = await db
      .select({ id: vaultMembership.id })
      .from(vaultMembership)
      .where(
        and(
          eq(vaultMembership.orgId, orgId),
          eq(vaultMembership.userId, account.id)
        )
      )
      .get()
    if (existing) continue // Manual membership is never taken over by SCIM.
    const memberId = crypto.randomUUID()
    const insert = db.insert(vaultMembership).values({
      id: memberId,
      orgId,
      userId: account.id,
      key: null,
      role: 2,
      status: 1,
      accessAll: false,
      createdAt: now,
    })
    const link = db
      .update(vaultDirectoryIdentity)
      .set({ membershipId: memberId })
      .where(eq(vaultDirectoryIdentity.id, identity.id))
    await db.batch([insert, link])
  }
}
