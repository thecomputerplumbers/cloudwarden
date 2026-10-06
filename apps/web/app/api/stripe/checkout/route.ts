import { logError } from "@/lib/diagnostics"
import { requireMembership } from "@workspace/auth"
import {
  createCheckoutSession,
  ensureCustomer,
  StripeError,
  withCheckoutSessionId,
} from "@workspace/stripe"
import {
  getCustomerByOrganization,
  upsertCustomer,
} from "@workspace/stripe/store"

import { getDb } from "@/db"
import { getServerSession } from "@/lib/session"
import { appOrigin, isPlan, priceFor, stripe } from "@/lib/stripe"

/**
 * Opens a Checkout session for the caller's active organization.
 *
 * The body carries a plan key and nothing else. Price, quantity and customer
 * are all decided here — a route that accepts a price id from the browser is
 * a route that sells anything at any price.
 */
export async function POST(request: Request) {
  const session = await getServerSession()
  if (!session) {
    return Response.json({ error: "Not signed in" }, { status: 401 })
  }

  const organizationId = session.session.activeOrganizationId
  if (!organizationId) {
    return Response.json({ error: "No active organization" }, { status: 400 })
  }

  const body = (await request.json().catch(() => ({}))) as { plan?: unknown }
  if (!isPlan(body.plan)) {
    return Response.json({ error: "Unknown plan" }, { status: 400 })
  }
  const plan = body.plan

  const db = getDb()

  // Membership is re-checked against the database rather than trusted from
  // the session: `activeOrganizationId` is stale for anyone who was removed
  // from the organization since their session last refreshed. Only an owner
  // or admin gets to commit the account to a subscription.
  try {
    await requireMembership(db, {
      organizationId,
      userId: session.user.id,
      role: "admin",
    })
  } catch {
    return Response.json(
      { error: "You do not have permission to manage billing." },
      { status: 403 }
    )
  }

  try {
    const client = stripe()

    const customer = await ensureCustomer(client, {
      organizationId,
      email: session.user.email,
      name: session.user.name,
      lookup: async () =>
        (
          await getCustomerByOrganization(
            db,
            organizationId,
            client.config.livemode
          )
        )?.id ?? null,
      persist: (id) =>
        upsertCustomer(db, {
          id,
          organizationId,
          email: session.user.email,
          livemode: client.config.livemode,
        }),
    })

    const origin = appOrigin(request)
    const checkout = await createCheckoutSession(client, {
      mode: "subscription",
      customer,
      lineItems: [{ price: priceFor(plan) }],
      successUrl: withCheckoutSessionId(`${origin}/billing?checkout=success`),
      cancelUrl: `${origin}/billing?checkout=cancelled`,
      clientReferenceId: organizationId,
      metadata: { organization_id: organizationId, plan },
      // Repeated on the subscription, where `customer.subscription.*` events
      // can still read it after checkout is long over.
      subscriptionMetadata: { organization_id: organizationId, plan },
      allowPromotionCodes: true,
    })

    return Response.json({ url: checkout.url })
  } catch (error) {
    // Stripe's own messages are written for customers and are safe to show.
    const message =
      error instanceof StripeError
        ? error.message
        : "Could not start checkout. Please try again."
    logError(error, "stripe.checkout")
    return Response.json({ error: message }, { status: 502 })
  }
}
