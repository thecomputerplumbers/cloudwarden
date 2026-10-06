import { finishVaultDeletion } from "./bitwarden-auth"
import { settleVaultShares } from "./bitwarden-share"
import { settleOrgImports } from "./bitwarden-org-import"

// Idempotent across Worker restarts. The D1 deletion marker blocks new sessions,
// and the Durable Object fence prevents an in-flight request from restoring
// vault rows after they have been cleared.
export async function cleanupVaultDeletion(env: CloudflareEnv, userId: string) {
  if (!(await settleVaultShares(env, { userId }))) return false
  if (!(await settleOrgImports(env, { userId }))) return false
  const vault = await env.APP_DATABASE.getByName(`vault:${userId}`)
  await vault.clearPersonalVault()

  for (const prefix of [`${userId}/`, `sends/${userId}/`]) {
    let empty = false
    for (let batch = 0; batch < 20; batch++) {
      const found = await env.VAULT_ATTACHMENTS.list({ prefix, limit: 1000 })
      if (found.objects.length === 0) {
        empty = !found.truncated
        break
      }
      await env.VAULT_ATTACHMENTS.delete(
        found.objects.map((object) => object.key)
      )
    }
    if (!empty) return false
  }

  return finishVaultDeletion(env, userId)
}
