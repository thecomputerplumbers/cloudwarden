import { logError } from "@/lib/diagnostics"
import { requireMembership } from "@workspace/auth"
import { createBillingPortalSession, safeReturnPath } from "@workspace/stripe"
import { getCustomerByOrganization } from "@workspace/stripe/store"

import { getDb } from "@/db"
import { getServerSession } from "@/lib/session"
import { appOrigin, stripe } from "@/lib/stripe"

/**
 * Sends the customer to Stripe's hosted billing portal.
 *
 * The return path comes from the browser, so it is checked before it reaches
 * Stripe: `safeReturnPath` rejects anything that is not a same-origin path,
 * which is what stops `//evil.example` from becoming an open redirect wearing
 * this domain's name.
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

  const body = (await request.json().catch(() => ({}))) as {
    returnPath?: unknown
  }
  const returnPath = safeReturnPath(body.returnPath, "/billing")

  const db = getDb()

  // The portal can cancel the subscription and change the card, so it is
  // gated the same way checkout is.
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
    const customer = await getCustomerByOrganization(
      db,
      organizationId,
      client.config.livemode
    )
    if (!customer) {
      return Response.json(
        { error: "There is no billing account for this organization yet." },
        { status: 404 }
      )
    }

    const portal = await createBillingPortalSession(client, {
      customer: customer.id,
      returnUrl: new URL(returnPath, appOrigin(request)).toString(),
    })

    return Response.json({ url: portal.url })
  } catch (error) {
    logError(error, "stripe.portal")
    return Response.json(
      { error: "Could not open billing. Please try again." },
      { status: 502 }
    )
  }
}
