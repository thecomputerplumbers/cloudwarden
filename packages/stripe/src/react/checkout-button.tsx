"use client"

import * as React from "react"
import { cn } from "cn"

import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"

import { useStripeRedirect } from "@workspace/stripe/react/use-checkout"

/**
 * Starts a Checkout session and redirects.
 *
 * ```tsx
 * <CheckoutButton endpoint="/api/stripe/checkout" body={{ plan: "pro-monthly" }}>
 *   Upgrade to Pro
 * </CheckoutButton>
 * ```
 *
 * The route behind `endpoint` decides the price and returns `{ url }`.
 */
function CheckoutButton({
  endpoint = "/api/stripe/checkout",
  body,
  children,
  pendingLabel = "Opening Stripe…",
  showError = true,
  className,
  wrapperClassName,
  disabled,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "onClick"> & {
  endpoint?: string
  body?: unknown
  pendingLabel?: React.ReactNode
  /** Renders the failure under the button. Turn off to handle it yourself. */
  showError?: boolean
  /** The wrapper holding the button and its error line. */
  wrapperClassName?: string
}) {
  const { start, pending, error } = useStripeRedirect({ endpoint, body })

  return (
    <div className={cn("flex flex-col gap-2", wrapperClassName)}>
      <Button
        data-slot="checkout-button"
        className={className}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        onClick={() => start()}
        {...props}
      >
        {pending ? <Spinner /> : null}
        {pending ? pendingLabel : children}
      </Button>
      {showError && error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export { CheckoutButton }
