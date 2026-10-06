"use client"

import * as React from "react"
import { CircleAlert, CircleCheck } from "lucide-react"
import { cn } from "cn"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { FieldGroup } from "@workspace/ui/components/field"

import {
  errorsFor,
  idleFormState,
  type FormState,
} from "@workspace/ui-forms/lib/action-state"

const FormStateContext = React.createContext<FormState<unknown>>(idleFormState)

/** Reads the state the surrounding `<Form>` was given. */
function useFormState() {
  return React.useContext(FormStateContext)
}

/** The errors the action reported for one field name. */
function useFieldErrors(name: string | undefined) {
  const state = useFormState()
  return errorsFor(state, name)
}

/**
 * A `<form>` that publishes its action's result to the fields inside it, so
 * each field can mark itself invalid without being handed its own errors.
 *
 * ```tsx
 * const [state, action] = useActionState(updateProfile, idleFormState)
 *
 * <Form action={action} state={state}>
 *   <FormMessage />
 *   <TextField name="email" label="Email" type="email" required />
 *   <FormActions>
 *     <SubmitButton>Save</SubmitButton>
 *   </FormActions>
 * </Form>
 * ```
 */
function Form({
  state = idleFormState,
  className,
  children,
  ...props
}: React.ComponentProps<"form"> & { state?: FormState<unknown> }) {
  return (
    <FormStateContext.Provider value={state}>
      <form data-slot="form" className={cn("w-full", className)} {...props}>
        {children}
      </form>
    </FormStateContext.Provider>
  )
}

/** Vertical rhythm between fields. Re-exported so one import covers a form. */
function FormFields({
  className,
  ...props
}: React.ComponentProps<typeof FieldGroup>) {
  return (
    <FieldGroup
      data-slot="form-fields"
      className={cn("gap-5", className)}
      {...props}
    />
  )
}

/**
 * The form-level banner. With no children it renders whatever message the
 * action returned, as an error or a confirmation, and nothing at all while
 * the form is untouched.
 */
function FormMessage({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Alert>) {
  const state = useFormState()

  if (children) {
    return (
      <Alert data-slot="form-message" className={className} {...props}>
        {children}
      </Alert>
    )
  }

  if (state.status === "idle" || !state.message) return null

  const failed = state.status === "error"

  return (
    <Alert
      data-slot="form-message"
      role={failed ? "alert" : "status"}
      variant={failed ? "destructive" : "default"}
      className={cn("mb-5", className)}
      {...props}
    >
      {failed ? <CircleAlert /> : <CircleCheck />}
      <AlertTitle>{state.message}</AlertTitle>
    </Alert>
  )
}

/**
 * Lists every field error at the top of a long form. Useful when the invalid
 * field may be scrolled out of view after a submit.
 */
function FormErrorSummary({
  className,
  title = "Please fix the following",
  ...props
}: React.ComponentProps<typeof Alert> & { title?: React.ReactNode }) {
  const state = useFormState()
  if (state.status !== "error") return null

  const entries = Object.entries(state.fieldErrors ?? {})
  if (entries.length === 0) return null

  return (
    <Alert
      data-slot="form-error-summary"
      role="alert"
      variant="destructive"
      className={cn("mb-5", className)}
      {...props}
    >
      <CircleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="ml-4 flex list-disc flex-col gap-1">
          {entries.map(([name, messages]) => (
            <li key={name}>{messages.join(" ")}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

/** The row of buttons that closes a form. */
function FormActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="form-actions"
      className={cn(
        "mt-6 flex flex-wrap items-center gap-2 border-t border-border pt-5",
        className
      )}
      {...props}
    />
  )
}

export {
  Form,
  FormActions,
  FormErrorSummary,
  FormFields,
  FormMessage,
  FormStateContext,
  useFieldErrors,
  useFormState,
}
