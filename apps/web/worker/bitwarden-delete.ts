import { finishVaultDeletion } from "./bitwarden-auth"

// Idempotent across Worker restarts. The D1 deletion marker blocks new sessions,
// and the Durable Object fence prevents an in-flight request from restoring
// vault rows after they have been cleared.
export async function cleanupVaultDeletion(env: CloudflareEnv, userId: string) {
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

  await finishVaultDeletion(env, userId)
  return true
}
