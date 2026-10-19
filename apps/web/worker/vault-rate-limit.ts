import { tokenHash } from "./bitwarden-auth"

export function vaultRateLimiter(env: CloudflareEnv) {
  return {
    async consumeRateLimit(key: string, limit: number, windowMs: number) {
      const object = env.APP_DATABASE.getByName(
        `bitwarden-rate:${await tokenHash(key)}`
      )
      return object.consumeRateLimit(key, limit, windowMs)
    },
  }
}
