"use client"

import * as React from "react"
import { ExternalLink } from "lucide-react"
import { cn } from "cn"

import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"

import { useStripeRedirect } from "@workspace/stripe/react/use-checkout"

/**
 * Sends the customer to Stripe's billing portal, where they can change their
 * card, switch plan, cancel, or download invoices.
 *
 * `returnPath` is where Stripe sends them back to. It is checked on the
 * server before being handed to Stripe — see `safeReturnPath`.
 */
function ManageBillingButton({
  endpoint = "/api/stripe/portal",
  returnPath = "/",
  children = "Manage billing",
  pendingLabel = "Opening Stripe…",
  variant = "outline",
  showError = true,
  className,
  wrapperClassName,
  disabled,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "onClick"> & {
  endpoint?: string
  returnPath?: string
  pendingLabel?: React.ReactNode
  showError?: boolean
  /** The wrapper holding the button and its error line. */
  wrapperClassName?: string
}) {
  const { start, pending, error } = useStripeRedirect({
    endpoint,
    body: { returnPath },
  })

  return (
    <div className={cn("flex flex-col gap-2", wrapperClassName)}>
      <Button
        data-slot="manage-billing-button"
        className={className}
        variant={variant}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        onClick={() => start()}
        {...props}
      >
        {pending ? <Spinner /> : null}
        {pending ? pendingLabel : children}
        {!pending ? <ExternalLink data-icon="inline-end" /> : null}
      </Button>
      {showError && error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export { ManageBillingButton }
