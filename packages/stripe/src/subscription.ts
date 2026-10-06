import type { StripeClient } from "@workspace/stripe/client"
import type { StripeSubscription } from "@workspace/stripe/types"

export function retrieveSubscription(stripe: StripeClient, id: string) {
  return stripe.get<StripeSubscription>(
    `subscriptions/${encodeURIComponent(id)}`
  )
}

/**
 * Ends a subscription at the end of the paid period, which is what a customer
 * expects when they cancel — they keep what they have paid for. Pass
 * `immediately` only when you are also issuing a refund.
 */
export function cancelSubscription(
  stripe: StripeClient,
  id: string,
  { immediately = false }: { immediately?: boolean } = {}
) {
  const path = `subscriptions/${encodeURIComponent(id)}`
  return immediately
    ? stripe.delete<StripeSubscription>(path)
    : stripe.post<StripeSubscription>(path, { cancel_at_period_end: true })
}

export function resumeSubscription(stripe: StripeClient, id: string) {
  return stripe.post<StripeSubscription>(
    `subscriptions/${encodeURIComponent(id)}`,
    { cancel_at_period_end: false }
  )
}

/** The fields worth storing, in the shapes the Drizzle tables expect. */
export type NormalizedSubscription = {
  id: string
  customerId: string
  status: StripeSubscription["status"]
  priceId: string | null
  quantity: number | null
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
  canceledAt: Date | null
  trialEnd: Date | null
}

/**
 * Flattens a subscription for storage.
 *
 * Stripe moved the billing window from the subscription onto its items when
 * subscriptions gained multiple prices, so the period is read from the first
 * item and falls back to the older top-level fields. Reading only one of the
 * two is the usual cause of a renewal date that silently stops updating.
 */
export function normalizeSubscription(
  sub: StripeSubscription
): NormalizedSubscription {
  const item = sub.items?.data?.[0]
  const start = item?.current_period_start ?? sub.current_period_start
  const end = item?.current_period_end ?? sub.current_period_end

  return {
    id: sub.id,
    customerId:
      typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    status: sub.status,
    priceId: item?.price?.id ?? null,
    quantity: item?.quantity ?? null,
    currentPeriodStart: toDate(start),
    currentPeriodEnd: toDate(end),
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    canceledAt: toDate(sub.canceled_at),
    trialEnd: toDate(sub.trial_end),
  }
}

function toDate(seconds: number | null | undefined) {
  return typeof seconds === "number" ? new Date(seconds * 1000) : null
}

const ENTITLED_STATUSES = new Set(["active", "trialing"])

/**
 * Whether this subscription should unlock paid features right now.
 *
 * `past_due` is deliberately excluded: Stripe keeps retrying the card, and a
 * grace period is a product decision. If you want one, pass `graceStatuses`.
 */
export function subscriptionIsEntitled(
  // `status` is widened to `string`: a stored row holds whatever Stripe sent,
  // including a status added after this package was written.
  sub: { status: string; currentPeriodEnd: Date | null },
  {
    now = new Date(),
    graceStatuses = [],
  }: { now?: Date; graceStatuses?: string[] } = {}
) {
  if (!ENTITLED_STATUSES.has(sub.status) && !graceStatuses.includes(sub.status))
    return false
  // A cancelled subscription keeps its access until the period it paid for
  // actually runs out.
  return !sub.currentPeriodEnd || sub.currentPeriodEnd > now
}
