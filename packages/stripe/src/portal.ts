import type { StripeClient } from "@workspace/stripe/client"
import type { StripeBillingPortalSession } from "@workspace/stripe/types"

/**
 * Opens Stripe's hosted billing portal. Everything a customer might want to
 * do to their own subscription — change the card, switch plan, cancel, pull
 * invoices — happens there, which is a large amount of UI you do not have to
 * build or keep compliant.
 */
export async function createBillingPortalSession(
  stripe: StripeClient,
  options: {
    customer: string
    returnUrl: string
    /** A portal configuration id, when you have more than the default. */
    configuration?: string
    locale?: string
  }
): Promise<StripeBillingPortalSession> {
  const session = await stripe.post<StripeBillingPortalSession>(
    "billing_portal/sessions",
    {
      customer: options.customer,
      return_url: options.returnUrl,
      configuration: options.configuration,
      locale: options.locale,
    }
  )

  if (!session.url) throw new Error("Stripe did not return a portal URL")
  return session
}

/**
 * Only same-origin paths are allowed back from a redirect. A return path that
 * arrives in a request body is attacker-controlled: without this check,
 * `//evil.example` would send the customer off-site from your own domain.
 */
export function safeReturnPath(value: unknown, fallback = "/") {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback
  try {
    const base = "https://return.invalid"
    const parsed = new URL(value, base)
    if (parsed.origin !== base || parsed.pathname.startsWith("//"))
      return fallback
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return fallback
  }
}
