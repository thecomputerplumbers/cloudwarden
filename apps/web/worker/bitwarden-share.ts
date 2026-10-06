import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import { vaultCipherTransfer } from "../db/schema/vault"
import {
  createOrgCipherLocator,
  getOrgCipherLocator,
  getVaultMembership,
  getVaultOrganization,
  validOrgCollections,
} from "./bitwarden-org"

export async function startVaultShare(
  env: CloudflareEnv,
  input: {
    cipherId: string
    userId: string
    orgId: string
    collectionIds: string[]
    payload: string
    attachmentKeys: Record<string, { fileName: string; key: string }>
    lastKnownRevisionDate?: string
  }
) {
  const db = drizzle(env.DB)
  const inserted = await db
    .insert(vaultCipherTransfer)
    .values({
      cipherId: input.cipherId,
      userId: input.userId,
      orgId: input.orgId,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ cipherId: vaultCipherTransfer.cipherId })
    .get()
  if (!inserted) return "busy" as const
  const source = await env.APP_DATABASE.getByName(`vault:${input.userId}`)
  const prepared = await source.prepareVaultShare(input.cipherId, {
    orgId: input.orgId,
    collectionIds: input.collectionIds,
    payload: input.payload,
    attachmentKeys: input.attachmentKeys,
    lastKnownRevisionDate: input.lastKnownRevisionDate,
  })
  if (prepared !== "prepared") {
    await db
      .delete(vaultCipherTransfer)
      .where(eq(vaultCipherTransfer.cipherId, input.cipherId))
      .run()
  }
  return prepared
}

export async function pendingVaultShares(env: CloudflareEnv) {
  return drizzle(env.DB).select().from(vaultCipherTransfer).limit(10).all()
}

export async function settleVaultShares(
  env: CloudflareEnv,
  owner: { userId: string } | { orgId: string }
) {
  const transfers = await drizzle(env.DB)
    .select({ cipherId: vaultCipherTransfer.cipherId })
    .from(vaultCipherTransfer)
    .where(
      "userId" in owner
        ? eq(vaultCipherTransfer.userId, owner.userId)
        : eq(vaultCipherTransfer.orgId, owner.orgId)
    )
    .limit(10)
    .all()
  for (const transfer of transfers)
    await completeVaultShare(env, transfer.cipherId)
  const remaining = await drizzle(env.DB)
    .select({ cipherId: vaultCipherTransfer.cipherId })
    .from(vaultCipherTransfer)
    .where(
      "userId" in owner
        ? eq(vaultCipherTransfer.userId, owner.userId)
        : eq(vaultCipherTransfer.orgId, owner.orgId)
    )
    .limit(1)
    .get()
  return !remaining
}

async function abortVaultShare(
  env: CloudflareEnv,
  transfer: typeof vaultCipherTransfer.$inferSelect
) {
  const source = await env.APP_DATABASE.getByName(`vault:${transfer.userId}`)
  const destination = await env.APP_DATABASE.getByName(`org:${transfer.orgId}`)
  if (!(await getOrgCipherLocator(env, transfer.cipherId))) {
    await destination.removeUnpublishedSharedCipher(transfer.cipherId)
    const prefix = `org/${transfer.orgId}/${transfer.cipherId}/`
    let empty = false
    for (let batch = 0; batch < 20; batch++) {
      const objects = await env.VAULT_ATTACHMENTS.list({ prefix, limit: 1000 })
      if (!objects.objects.length) {
        empty = !objects.truncated
        break
      }
      await env.VAULT_ATTACHMENTS.delete(
        objects.objects.map((object) => object.key)
      )
    }
    if (!empty) return
    await source.clearVaultShare(transfer.cipherId)
    await drizzle(env.DB)
      .delete(vaultCipherTransfer)
      .where(eq(vaultCipherTransfer.cipherId, transfer.cipherId))
      .run()
  }
}

/** Resume a cross-object share after a Worker interruption. */
export async function completeVaultShare(env: CloudflareEnv, cipherId: string) {
  const db = drizzle(env.DB)
  const transfer = await db
    .select()
    .from(vaultCipherTransfer)
    .where(eq(vaultCipherTransfer.cipherId, cipherId))
    .get()
  if (!transfer) return !!(await getOrgCipherLocator(env, cipherId))
  const source = await env.APP_DATABASE.getByName(`vault:${transfer.userId}`)
  const snapshot = await source.getVaultShare(cipherId)
  const locator = await getOrgCipherLocator(env, cipherId)
  if (!snapshot) {
    if (!locator) await abortVaultShare(env, transfer)
    else
      await db
        .delete(vaultCipherTransfer)
        .where(eq(vaultCipherTransfer.cipherId, cipherId))
        .run()
    return !!locator
  }
  if (snapshot.orgId !== transfer.orgId)
    throw new Error("Cipher transfer organization changed")
  if (!locator) {
    const member = await getVaultMembership(
      env,
      transfer.orgId,
      transfer.userId
    )
    if (
      !member ||
      member.role > 1 ||
      !(await getVaultOrganization(env, transfer.orgId)) ||
      !(await validOrgCollections(
        env,
        transfer.orgId,
        member,
        snapshot.collectionIds
      ))
    ) {
      await abortVaultShare(env, transfer)
      return false
    }
    for (const attachment of snapshot.attachments) {
      const destinationKey = `org/${transfer.orgId}/${cipherId}/${attachment.id}`
      if (await env.VAULT_ATTACHMENTS.head(destinationKey)) continue
      const original = await env.VAULT_ATTACHMENTS.get(
        `${transfer.userId}/${cipherId}/${attachment.id}`
      )
      if (!original?.body) {
        await abortVaultShare(env, transfer)
        return false
      }
      await env.VAULT_ATTACHMENTS.put(destinationKey, original.body)
    }
    const destination = await env.APP_DATABASE.getByName(
      `org:${transfer.orgId}`
    )
    await destination.stageSharedCipher(
      cipherId,
      snapshot.payload,
      snapshot.attachments
    )
    if (!(await getOrgCipherLocator(env, cipherId)))
      await createOrgCipherLocator(
        env,
        cipherId,
        transfer.orgId,
        snapshot.collectionIds
      )
  }
  await source.finishVaultShare(cipherId)
  if (snapshot.attachments.length)
    await env.VAULT_ATTACHMENTS.delete(
      snapshot.attachments.map(
        (attachment) => `${transfer.userId}/${cipherId}/${attachment.id}`
      )
    )
  await source.clearVaultShare(cipherId)
  await db
    .delete(vaultCipherTransfer)
    .where(eq(vaultCipherTransfer.cipherId, cipherId))
    .run()
  return true
}
