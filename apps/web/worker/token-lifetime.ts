const DEFAULT_SECONDS = 3600

// Match upstream's interactive-client override. API keys and the directory
// connector retain their independent defaults.
export function accessTokenLifetimeSeconds(
  env: object,
  clientId: string,
  apiKey = false
) {
  if (apiKey) return DEFAULT_SECONDS
  if (clientId === "connector") return 24 * DEFAULT_SECONDS
  const value = (env as { ACCESS_TOKEN_LIFETIME_SECONDS?: string })
    .ACCESS_TOKEN_LIFETIME_SECONDS
  if (value === undefined) return DEFAULT_SECONDS
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 2_147_483_647)
    throw new Error("ACCESS_TOKEN_LIFETIME_SECONDS must be a positive integer")
  return Number(value)
}
