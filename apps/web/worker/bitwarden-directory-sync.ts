import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import {
  vaultCollection,
  vaultCollectionMember,
  vaultDirectoryCollectionGrant,
  vaultDirectoryIdentity,
  vaultMembership,
  vaultUser,
} from "../db/schema/vault"
import { createVaultStubUser } from "./bitwarden-auth"
import { readVaultDirectory } from "./bitwarden-directory"
import {
  invitationMailEnabled,
  invitationOrigin,
  sendOrgInvite,
} from "./bitwarden-invite"
import { getVaultOrganization } from "./bitwarden-org"
import {
  organizationNotificationTargets,
  publishVaultNotification,
} from "./bitwarden-notifications"

type DirectoryConfig = CloudflareEnv & {
  SCIM_DIRECTORY_URL?: string
  SCIM_TOKEN?: string
  SCIM_ORGANIZATION_ID?: string
  SCIM_INVITATIONS_ENABLED?: string
}

/** Reconcile only identities previously linked by this directory sync. */
export async function reconcileVaultDirectory(
  env: CloudflareEnv,
  fetcher: typeof fetch = fetch,
  notifyUser: (userId: string) => Promise<void> = (userId) =>
    publishVaultNotification(env, { type: 5, userId })
) {
  const config = env as DirectoryConfig
  if (
    !config.SCIM_DIRECTORY_URL ||
    !config.SCIM_TOKEN ||
    !config.SCIM_ORGANIZATION_ID
  )
    return
  const orgId = config.SCIM_ORGANIZATION_ID
  const org = await getVaultOrganization(env, orgId)
  if (!org) throw new Error("SCIM organization is unavailable")
  const sendInvites =
    config.SCIM_INVITATIONS_ENABLED === "true" && invitationMailEnabled(env)
  if (sendInvites) invitationOrigin(env)

  // A failed or changing page must never revoke a membership.
  const users = await readVaultDirectory(
    config.SCIM_DIRECTORY_URL,
    config.SCIM_TOKEN,
    fetcher
  )
  const db = drizzle(env.DB)
  const collections = await db
    .select({ id: vaultCollection.id, externalId: vaultCollection.externalId })
    .from(vaultCollection)
    .where(eq(vaultCollection.orgId, orgId))
    .all()
  const collectionByGroup = new Map<string, string>()
  for (const collection of collections) {
    if (!collection.externalId) continue
    if (collectionByGroup.has(collection.externalId))
      throw new Error("Duplicate collection directory ID")
    collectionByGroup.set(collection.externalId, collection.id)
  }
  const known = await db
    .select()
    .from(vaultDirectoryIdentity)
    .where(eq(vaultDirectoryIdentity.orgId, orgId))
    .all()
  const byId = new Map(known.map((identity) => [identity.externalId, identity]))
  const current = new Map(users.map((user) => [user.id, user]))
  const now = new Date()
  const beforeRecipients = new Set(
    await organizationNotificationTargets(env, orgId, null)
  )
  const collectionChangedUsers = new Set<string>()

  try {
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
            invitationSentAt: null,
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
            .set({ membershipId: null, invitationSentAt: null })
            .where(eq(vaultDirectoryIdentity.id, identity.id))
            .run()
          identity.membershipId = null
          identity.invitationSentAt = null
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
          let replacement = await db
            .select({ id: vaultUser.id })
            .from(vaultUser)
            .where(eq(vaultUser.email, user.email))
            .get()
          if (!replacement && sendInvites)
            replacement = await createVaultStubUser(env, user.email, user.name)
          if (replacement && replacement.id !== membership.account.id) {
            await db
              .update(vaultDirectoryIdentity)
              .set({ membershipId: null, invitationSentAt: null })
              .where(eq(vaultDirectoryIdentity.id, identity.id))
              .run()
            identity.membershipId = null
            identity.invitationSentAt = null
          }
        } else if (
          membership?.membership.role === 2 &&
          membership.membership.status === 3
        ) {
          const status = membership.membership.key ? 2 : sendInvites ? 0 : 1
          await db
            .update(vaultMembership)
            .set({ status })
            .where(eq(vaultMembership.id, membership.membership.id))
            .run()
          membership.membership.status = status
          if (status === 0) {
            await db
              .update(vaultDirectoryIdentity)
              .set({ invitationSentAt: null })
              .where(eq(vaultDirectoryIdentity.id, identity.id))
              .run()
            identity.invitationSentAt = null
          }
        }
        if (
          identity.membershipId &&
          sendInvites &&
          !identity.invitationSentAt &&
          membership?.membership.status === 0
        ) {
          await sendOrgInvite(env, {
            email: user.email,
            orgId,
            orgName: org.name,
            memberId: identity.membershipId,
            userId: membership.account.id,
            existingUser: !!membership.account.privateKey,
          })
          await db
            .update(vaultDirectoryIdentity)
            .set({ invitationSentAt: new Date() })
            .where(eq(vaultDirectoryIdentity.id, identity.id))
            .run()
        }
        if (identity.membershipId) continue
      }
      if (config.SCIM_INVITATIONS_ENABLED !== "true") continue
      let account = await db
        .select()
        .from(vaultUser)
        .where(eq(vaultUser.email, user.email))
        .get()
      if (!account && sendInvites)
        account = await createVaultStubUser(env, user.email, user.name)
      if (
        !account ||
        account.deletingAt ||
        (!sendInvites && !account.publicKey)
      )
        continue
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
        status: sendInvites ? 0 : 1,
        accessAll: false,
        createdAt: now,
      })
      const link = db
        .update(vaultDirectoryIdentity)
        .set({ membershipId: memberId, invitationSentAt: null })
        .where(eq(vaultDirectoryIdentity.id, identity.id))
      await db.batch([insert, link])
      if (sendInvites) {
        await sendOrgInvite(env, {
          email: user.email,
          orgId,
          orgName: org.name,
          memberId,
          userId: account.id,
          existingUser: !!account.privateKey,
        })
        await db
          .update(vaultDirectoryIdentity)
          .set({ invitationSentAt: new Date() })
          .where(eq(vaultDirectoryIdentity.id, identity.id))
          .run()
      }
    }

    // Only mutate collection assignments that this sync previously created.
    // An absent groups field means the source did not send group information.
    const linked = await db
      .select({
        externalId: vaultDirectoryIdentity.externalId,
        membershipId: vaultDirectoryIdentity.membershipId,
      })
      .from(vaultDirectoryIdentity)
      .where(eq(vaultDirectoryIdentity.orgId, orgId))
      .all()
    for (const identity of linked) {
      if (!identity.membershipId) continue
      const user = current.get(identity.externalId)
      if (user?.active && user.groups === undefined) continue
      const member = await db
        .select({
          userId: vaultMembership.userId,
          role: vaultMembership.role,
          status: vaultMembership.status,
        })
        .from(vaultMembership)
        .where(
          and(
            eq(vaultMembership.id, identity.membershipId),
            eq(vaultMembership.orgId, orgId)
          )
        )
        .get()
      if (!member || member.role !== 2) continue
      const desired = new Set(
        user?.active && member.status !== 3
          ? (user.groups?.flatMap((group) => {
              const collectionId = collectionByGroup.get(group)
              return collectionId ? [collectionId] : []
            }) ?? [])
          : []
      )
      const owned = await db
        .select({ collectionId: vaultDirectoryCollectionGrant.collectionId })
        .from(vaultDirectoryCollectionGrant)
        .where(
          eq(vaultDirectoryCollectionGrant.membershipId, identity.membershipId)
        )
        .all()
      const ownedIds = new Set(owned.map((grant) => grant.collectionId))
      for (const grant of owned) {
        if (desired.has(grant.collectionId)) continue
        await db.batch([
          db
            .delete(vaultCollectionMember)
            .where(
              and(
                eq(vaultCollectionMember.membershipId, identity.membershipId),
                eq(vaultCollectionMember.collectionId, grant.collectionId)
              )
            ),
          db
            .delete(vaultDirectoryCollectionGrant)
            .where(
              and(
                eq(
                  vaultDirectoryCollectionGrant.membershipId,
                  identity.membershipId
                ),
                eq(
                  vaultDirectoryCollectionGrant.collectionId,
                  grant.collectionId
                )
              )
            ),
        ])
        collectionChangedUsers.add(member.userId)
      }
      for (const collectionId of desired) {
        const assignment = await db
          .select({ collectionId: vaultCollectionMember.collectionId })
          .from(vaultCollectionMember)
          .where(
            and(
              eq(vaultCollectionMember.membershipId, identity.membershipId),
              eq(vaultCollectionMember.collectionId, collectionId)
            )
          )
          .get()
        if (assignment) continue
        if (ownedIds.has(collectionId)) {
          await db.insert(vaultCollectionMember).values({
            collectionId,
            membershipId: identity.membershipId,
            readOnly: false,
            hidePasswords: false,
          })
          collectionChangedUsers.add(member.userId)
          continue
        }
        await db.batch([
          db.insert(vaultCollectionMember).values({
            collectionId,
            membershipId: identity.membershipId,
            readOnly: false,
            hidePasswords: false,
          }),
          db.insert(vaultDirectoryCollectionGrant).values({
            id: crypto.randomUUID(),
            collectionId,
            membershipId: identity.membershipId,
          }),
        ])
        collectionChangedUsers.add(member.userId)
      }
    }
  } finally {
    try {
      const afterRecipients = new Set(
        await organizationNotificationTargets(env, orgId, null)
      )
      const changed =
        beforeRecipients.size !== afterRecipients.size ||
        [...beforeRecipients].some((id) => !afterRecipients.has(id))
      if (changed || collectionChangedUsers.size) {
        const recipients = changed
          ? [
              ...new Set([
                ...beforeRecipients,
                ...afterRecipients,
                ...collectionChangedUsers,
              ]),
            ]
          : [...collectionChangedUsers]
        for (let index = 0; index < recipients.length; index += 20)
          await Promise.all(recipients.slice(index, index + 20).map(notifyUser))
      }
    } catch {
      console.error("SCIM membership notification failed")
    }
  }
}
