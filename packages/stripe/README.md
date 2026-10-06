# @workspace/stripe

Stripe Checkout, billing portal, subscription reconciliation and webhook
verification for Cloudflare Workers. Uses `fetch` and WebCrypto.

## One account per deployment

Configure one set of credentials and prices:

```text
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_PRICE_PRO_MONTHLY=price_…
STRIPE_PRICE_PRO_YEARLY=price_…
STRIPE_API_VERSION=… # optional explicit API version
```

There is no runtime test/live switch and no prefixed credential fallback.
Use separate deployments and D1 databases for test and live. The credential
prefix determines the expected environment; webhooks and retrieved
subscriptions from another environment are rejected. Customer lookup fails
if a database contains an organization customer from the other environment.
Do not repoint an existing test database at live credentials.

Set secrets using `pnpm --filter web exec wrangler secret put <NAME>`.
Plan keys resolve server-side: `pro-monthly` reads `STRIPE_PRICE_PRO_MONTHLY`.
The browser never supplies a price or amount.

## Entry points

- `@workspace/stripe`: configuration, HTTP client, checkout, portal and webhooks.
- `@workspace/stripe/schema`: Drizzle tables for D1.
- `@workspace/stripe/store`: asynchronous D1 queries and reconciliation.
- `@workspace/stripe/react/*`: checkout, portal and pricing controls.

## Data and reconciliation

Billing belongs to an organization. `stripe_customer` has one customer per
organization; `stripe_subscription` keeps subscription history; `stripe_event`
contains successfully processed event IDs. Tables live beside auth in D1,
not inside the Durable Object. The app re-exports them from
`apps/web/db/schema/billing.ts` and lists that module in `drizzle.config.ts`.
After schema changes, run `pnpm db:generate` and commit the new migration.
Apply D1 migrations before deploying code that needs them.

Signed webhook events trigger `reconcileSubscription`, which fetches current
state from Stripe instead of trusting an event snapshot. A conditional revision
update fences concurrent writes. If another handler wins, the losing handler
reads and fetches again. Entitlement checks consider all matching subscriptions,
so an old canceled row cannot hide an active subscription. Only `active` and
`trialing` grant access, subject to the stored period end.

A checkout redirect never grants access. Reads and billing mutations must
check current organization membership; mutations require an admin or owner.

## Webhook retries

The app handles `checkout.session.completed` and
`customer.subscription.created`, `.updated`, and `.deleted`.
It verifies the raw payload against this deployment's webhook secret.

`stripeEventSeen` checks completed IDs. `recordStripeEvent` runs only after
successful processing. Failures in processing or recording return 500 and
remain retryable. Duplicate in-flight deliveries may both execute, so every
handler must be idempotent. Subscription reconciliation is safe to repeat;
additional one-time entitlement handlers need unique business keys or an
atomic database batch. Do not record an event before its handler succeeds.

Locally, run `stripe listen --forward-to localhost:3000/api/stripe/webhook`
and configure its signing secret as `STRIPE_WEBHOOK_SECRET`.

## Checkout attempts and redirects

`createCheckoutSession` generates a fresh idempotency key per invocation.
Network retries inside the HTTP client reuse that key. Callers that need to
resume the same attempt can provide an explicit attempt key; an organization
ID is not an attempt key. Customer creation uses a separate customer key.

`safeReturnPath` parses paths against a fixed origin and rejects external
origins, including backslash and control-character URL normalization cases.

## Validation

`pnpm test` exercises webhook failures, duplicate deliveries, concurrent
reconciliation, subscription history, environment separation, membership
revocation, redirects, auth defaults and checkout attempts. Database tests
execute generated migrations and real Drizzle SQL against SQLite using a
small D1 transport adapter.
