import type { StripeClient } from "@workspace/stripe/client"
import type {
  StripeCustomer,
  StripeListResponse,
  StripeMetadata,
} from "@workspace/stripe/types"

export function createCustomer(
  stripe: StripeClient,
  options: {
    email: string
    name?: string
    metadata?: StripeMetadata
    /** Makes a retried create safe — your own user id works well here. */
    idempotencyKey?: string
  }
) {
  return stripe.post<StripeCustomer>(
    "customers",
    {
      email: options.email,
      name: options.name,
      metadata: options.metadata,
    },
    { idempotencyKey: options.idempotencyKey }
  )
}

export function retrieveCustomer(stripe: StripeClient, id: string) {
  return stripe.get<StripeCustomer>(`customers/${encodeURIComponent(id)}`)
}

/**
 * Finds a customer by email. Email is not unique in Stripe, so this returns
 * the most recent match and is only a reasonable fallback — the durable link
 * is the customer id you store against your own user.
 */
export async function findCustomerByEmail(stripe: StripeClient, email: string) {
  const result = await stripe.get<StripeListResponse<StripeCustomer>>(
    "customers",
    { email, limit: 1 }
  )
  return result.data[0] ?? null
}

/**
 * Resolves the Stripe customer for one of your organizations, creating it
 * once.
 *
 * `lookup` and `persist` are yours: read the stored id, and write back the id
 * this returns. Doing it here rather than at checkout is what keeps an
 * account from accumulating a new Stripe customer per purchase — and then
 * seeing none of its subscriptions in the billing portal.
 *
 * The idempotency key is derived from the organization id, so two concurrent
 * checkouts cannot create two customers for the same account.
 */
export async function ensureCustomer(
  stripe: StripeClient,
  options: {
    organizationId: string
    email: string
    name?: string
    lookup: () => Promise<string | null> | string | null
    persist: (customerId: string) => Promise<void> | void
    metadata?: StripeMetadata
  }
): Promise<string> {
  const existing = await options.lookup()
  if (existing) return existing

  const customer = await createCustomer(stripe, {
    email: options.email,
    name: options.name,
    metadata: { organization_id: options.organizationId, ...options.metadata },
    idempotencyKey: `customer:${options.organizationId}`,
  })

  await options.persist(customer.id)
  return customer.id
}
