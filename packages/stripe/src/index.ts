/**
 * Server-side Stripe for Cloudflare Workers.
 *
 * Everything here is `fetch` and WebCrypto — no `stripe` package, no Node
 * built-ins, nothing that needs a polyfill in workerd.
 *
 * Billing keys on the **organization**, not the user: the account pays, and a
 * person who leaves should not take the subscription with them.
 *
 * The Drizzle tables and their queries are kept out of this entry point so a
 * route that only opens a Checkout session does not pull in the database:
 *
 *   `@workspace/stripe/schema`   the tables (D1)
 *   `@workspace/stripe/store`    reads and writes against D1
 *   `@workspace/stripe/react/*`  client components
 */

export {
  getStripeConfig,
  priceEnvKey,
  requireSecretKey,
  stripeConfigComplete,
  type StripeConfig,
  type StripeEnv,
} from "@workspace/stripe/config"

export {
  createStripeClient,
  encodeStripeParams,
  StripeError,
  type StripeClient,
  type StripeParams,
  type StripeRequestOptions,
} from "@workspace/stripe/client"

export {
  createCheckoutSession,
  retrieveCheckoutSession,
  withCheckoutSessionId,
  type CheckoutLineItem,
  type CreateCheckoutOptions,
  type InlinePrice,
} from "@workspace/stripe/checkout"

export {
  createBillingPortalSession,
  safeReturnPath,
} from "@workspace/stripe/portal"

export {
  createCustomer,
  ensureCustomer,
  findCustomerByEmail,
  retrieveCustomer,
} from "@workspace/stripe/customer"

export {
  cancelSubscription,
  normalizeSubscription,
  resumeSubscription,
  retrieveSubscription,
  subscriptionIsEntitled,
  type NormalizedSubscription,
} from "@workspace/stripe/subscription"

export {
  handleStripeWebhook,
  parseStripeWebhook,
  StripeSignatureError,
  verifyStripeSignature,
  type ParsedStripeWebhook,
  type StripeWebhookHandler,
  type StripeWebhookOptions,
} from "@workspace/stripe/webhook"

export type {
  StripeBillingPortalSession,
  StripeCheckoutSession,
  StripeCustomer,
  StripeEvent,
  StripeListResponse,
  StripeMetadata,
  StripeSubscription,
  StripeSubscriptionItem,
} from "@workspace/stripe/types"
