import type { StripeClient, StripeParams } from "@workspace/stripe/client"
import type {
  StripeCheckoutSession,
  StripeMetadata,
} from "@workspace/stripe/types"

/** An inline price, for amounts you set rather than manage in the dashboard. */
export type InlinePrice = {
  currency: string
  /** In minor units — 999 is $9.99. */
  unitAmount: number
  productName: string
  productDescription?: string
  recurring?: {
    interval: "day" | "week" | "month" | "year"
    intervalCount?: number
  }
}

export type CheckoutLineItem = {
  /** A price id from the dashboard. Mutually exclusive with `priceData`. */
  price?: string
  priceData?: InlinePrice
  quantity?: number
  adjustableQuantity?: { enabled: boolean; minimum?: number; maximum?: number }
}

export type CreateCheckoutOptions = {
  mode: "payment" | "subscription" | "setup"
  lineItems: CheckoutLineItem[]
  successUrl: string
  cancelUrl: string

  /** Prefer an existing customer id; fall back to an email for new buyers. */
  customer?: string
  customerEmail?: string

  /** Your own id for this attempt. Comes back on the session and the event. */
  clientReferenceId?: string
  metadata?: StripeMetadata
  /** Copied onto the subscription itself, where webhooks can still read it. */
  subscriptionMetadata?: StripeMetadata

  trialPeriodDays?: number
  allowPromotionCodes?: boolean
  /** Appended to the customer's card statement. Keep it short and recognisable. */
  statementDescriptorSuffix?: string
  automaticTax?: boolean
  /** Identifies one purchase attempt. Defaults to a fresh key per call. */
  idempotencyKey?: string
  /** Anything else Stripe accepts, merged in as-is. */
  extraParams?: StripeParams
}

/**
 * Opens a Checkout session and hands back the URL to redirect to.
 *
 * Amounts are decided here, on the server — never take a price or a quantity
 * from the browser, or a determined customer will name their own.
 *
 * ```ts
 * const session = await createCheckoutSession(stripe, {
 *   mode: "subscription",
 *   lineItems: [{ price: config.prices["pro-monthly"] }],
 *   successUrl: `${origin}/billing?checkout=success`,
 *   cancelUrl: `${origin}/billing?checkout=cancelled`,
 *   clientReferenceId: userId,
 * })
 * ```
 */
export async function createCheckoutSession(
  stripe: StripeClient,
  options: CreateCheckoutOptions
): Promise<StripeCheckoutSession> {
  const params: StripeParams = {
    mode: options.mode,
    success_url: options.successUrl,
    cancel_url: options.cancelUrl,
    client_reference_id: options.clientReferenceId,
    metadata: options.metadata,
    allow_promotion_codes: options.allowPromotionCodes,
    line_items: options.lineItems.map(toLineItemParams),
    ...options.extraParams,
  }

  // Stripe rejects a session that carries both; an id always wins.
  if (options.customer) params.customer = options.customer
  else if (options.customerEmail) params.customer_email = options.customerEmail

  if (options.automaticTax) params.automatic_tax = { enabled: true }

  if (options.mode === "subscription") {
    params.subscription_data = {
      trial_period_days: options.trialPeriodDays,
      metadata: options.subscriptionMetadata,
    }
  }

  if (options.mode === "payment" && options.statementDescriptorSuffix) {
    params.payment_intent_data = {
      statement_descriptor_suffix: options.statementDescriptorSuffix,
    }
  }

  const session = await stripe.post<StripeCheckoutSession>(
    "checkout/sessions",
    params,
    { idempotencyKey: options.idempotencyKey ?? crypto.randomUUID() }
  )

  if (!session.url) throw new Error("Stripe did not return a Checkout URL")
  return session
}

function toLineItemParams(item: CheckoutLineItem): StripeParams {
  if (item.price && item.priceData) {
    throw new Error("A line item takes either `price` or `priceData`, not both")
  }
  if (!item.price && !item.priceData) {
    throw new Error("A line item needs a `price` or `priceData`")
  }

  return {
    price: item.price,
    quantity: item.quantity ?? 1,
    adjustable_quantity: item.adjustableQuantity,
    price_data: item.priceData && {
      currency: item.priceData.currency,
      unit_amount: item.priceData.unitAmount,
      recurring: item.priceData.recurring && {
        interval: item.priceData.recurring.interval,
        interval_count: item.priceData.recurring.intervalCount,
      },
      product_data: {
        name: item.priceData.productName,
        description: item.priceData.productDescription,
      },
    },
  }
}

export function retrieveCheckoutSession(stripe: StripeClient, id: string) {
  return stripe.get<StripeCheckoutSession>(
    `checkout/sessions/${encodeURIComponent(id)}`
  )
}

/**
 * The success URL Stripe redirects to can carry the session id, but only if
 * the literal placeholder survives encoding — `URL` would escape the braces.
 *
 * ```ts
 * successUrl: withCheckoutSessionId(`${origin}/billing?checkout=success`)
 * ```
 */
export function withCheckoutSessionId(url: string, param = "session_id") {
  const separator = url.includes("?") ? "&" : "?"
  return `${url}${separator}${param}={CHECKOUT_SESSION_ID}`
}
