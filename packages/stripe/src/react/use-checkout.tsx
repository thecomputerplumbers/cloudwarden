"use client"

import * as React from "react"

/**
 * Posts to one of your own routes, expects `{ url }` back, and sends the
 * browser there.
 *
 * The redirect is deliberately the only thing the client does. Prices,
 * quantities and the customer are all decided on the server — if the browser
 * could name a price, it could name a cheaper one.
 */
export function useStripeRedirect({
  endpoint,
  body,
  onError,
}: {
  endpoint: string
  body?: unknown
  onError?: (message: string) => void
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const start = React.useCallback(
    async (overrides?: unknown) => {
      setPending(true)
      setError(null)

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(overrides ?? body ?? {}),
        })

        if (response.status === 401) {
          throw new Error("Please sign in, then try again.")
        }

        const payload = (await response.json()) as {
          url?: string
          error?: string
        }

        if (!response.ok || !payload.url) {
          throw new Error(payload.error || "Could not reach Stripe.")
        }

        // `assign` rather than `replace`, so the back button returns here
        // instead of skipping past the page the person came from.
        window.location.assign(payload.url)
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Could not reach Stripe."
        setError(message)
        onError?.(message)
        setPending(false)
      }
    },
    [body, endpoint, onError]
  )

  return { start, pending, error, clearError: () => setError(null) }
}
