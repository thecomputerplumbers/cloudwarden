/**
 * Billing tables, owned by `@workspace/stripe`.
 *
 * These sit in D1 beside the auth tables rather than in the Durable Object,
 * because they key off organizations — a subscription row is only meaningful
 * next to the organization that owns it.
 */

export {
  stripeCustomer,
  stripeEvent,
  stripeSubscription,
  type StripeCustomerRow,
  type StripeEventRow,
  type StripeSubscriptionRow,
} from "@workspace/stripe/schema"
