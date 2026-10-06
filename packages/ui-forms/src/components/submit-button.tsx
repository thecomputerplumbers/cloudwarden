"use client"

import * as React from "react"
import { useFormStatus } from "react-dom"

import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"

/**
 * A submit button that disables itself and shows a spinner while the
 * surrounding form's action is in flight. It reads `useFormStatus`, so it has
 * to be rendered inside the `<form>` rather than beside it.
 */
function SubmitButton({
  children,
  pendingLabel,
  disabled,
  ...props
}: React.ComponentProps<typeof Button> & {
  /** Replaces the label while submitting. Defaults to keeping the label. */
  pendingLabel?: React.ReactNode
}) {
  const { pending } = useFormStatus()

  return (
    <Button
      type="submit"
      data-slot="submit-button"
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...props}
    >
      {pending ? <Spinner /> : null}
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  )
}

/**
 * Any other control that should go quiet while the form submits — a "cancel"
 * link, a secondary action, a destructive button beside the primary one.
 */
function FormPending({
  children,
}: {
  children: (pending: boolean) => React.ReactNode
}) {
  const { pending } = useFormStatus()
  return <>{children(pending)}</>
}

export { FormPending, SubmitButton }
