/** One Stripe account per deployment. Use separate databases for test and live. */
export type StripeEnv = {
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_API_VERSION?: string
}

export type StripeConfig<PriceKey extends string = string> = {
  /** Derived from the credential, never selected independently. */
  livemode: boolean
  secretKey: string | undefined
  webhookSecret: string | undefined
  apiVersion: string | undefined
  prices: Record<PriceKey, string | undefined>
}

export function priceEnvKey(key: string) {
  return `STRIPE_PRICE_${key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
}

export function getStripeConfig<const PriceKey extends string = never>(
  env: StripeEnv,
  options: { prices?: readonly PriceKey[] } = {}
): StripeConfig<PriceKey> {
  const lookup = env as Record<string, string | undefined>
  const prices = {} as Record<PriceKey, string | undefined>
  for (const key of options.prices ?? []) prices[key] = lookup[priceEnvKey(key)]
  return {
    livemode: /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY ?? ""),
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    apiVersion: env.STRIPE_API_VERSION,
    prices,
  }
}

export function stripeConfigComplete(config: StripeConfig<string>) {
  return Boolean(
    /^(sk|rk)_(test|live)_/.test(config.secretKey ?? "") &&
    config.webhookSecret &&
    Object.values(config.prices).every(Boolean)
  )
}

export function requireSecretKey(config: StripeConfig<string>) {
  if (!config.secretKey || !/^(sk|rk)_(test|live)_/.test(config.secretKey)) {
    throw new Error("A valid STRIPE_SECRET_KEY must be configured")
  }
  return config.secretKey
}
