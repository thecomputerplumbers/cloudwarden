/**
 * Minimal shapes for the Stripe objects this module touches.
 *
 * These are deliberately partial: they describe the fields we read, and leave
 * everything else to `[key: string]: unknown` so a response from a newer API
 * version still type-checks. If you need a field that is not here, add it —
 * do not reach for `any`.
 */

export type StripeMetadata = Record<string, string>

export type StripeListResponse<T> = {
  object: "list"
  data: T[]
  has_more: boolean
  url: string
}

export type StripeCustomer = {
  id: string
  object: "customer"
  email: string | null
  name: string | null
  livemode: boolean
  deleted?: boolean
  metadata?: StripeMetadata
  [key: string]: unknown
}

export type StripeCheckoutSession = {
  id: string
  object: "checkout.session"
  url: string | null
  mode: "payment" | "subscription" | "setup"
  status: "open" | "complete" | "expired" | null
  payment_status: "paid" | "unpaid" | "no_payment_required"
  amount_total: number | null
  currency: string | null
  customer: string | StripeCustomer | null
  customer_email: string | null
  customer_details?: { email?: string | null } | null
  client_reference_id: string | null
  payment_intent: string | null
  subscription: string | null
  metadata?: StripeMetadata
  livemode: boolean
  [key: string]: unknown
}

export type StripeSubscriptionItem = {
  id: string
  price?: { id?: string; recurring?: { interval?: string } | null } | null
  quantity?: number
  /** Newer API versions report the billing window on the item, not the sub. */
  current_period_start?: number
  current_period_end?: number
}

export type StripeSubscription = {
  id: string
  object: "subscription"
  status:
    | "trialing"
    | "active"
    | "incomplete"
    | "incomplete_expired"
    | "past_due"
    | "canceled"
    | "unpaid"
    | "paused"
  customer: string | StripeCustomer
  cancel_at_period_end?: boolean
  canceled_at?: number | null
  trial_end?: number | null
  current_period_start?: number
  current_period_end?: number
  items?: { data?: StripeSubscriptionItem[] }
  metadata?: StripeMetadata
  livemode: boolean
  [key: string]: unknown
}

export type StripeBillingPortalSession = {
  id: string
  object: "billing_portal.session"
  url: string
  return_url: string | null
  livemode: boolean
}

export type StripeEvent<T = Record<string, unknown>> = {
  id: string
  object: "event"
  type: string
  api_version: string | null
  created: number
  livemode: boolean
  data: { object: T; previous_attributes?: Record<string, unknown> }
  request?: { id: string | null; idempotency_key: string | null } | null
}
