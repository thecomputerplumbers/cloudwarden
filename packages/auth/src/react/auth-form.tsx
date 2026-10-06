"use client"

import * as React from "react"
import { cn } from "cn"

import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Spinner } from "@workspace/ui/components/spinner"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"

import { authClient } from "@workspace/auth/client"

type Mode = "sign-in" | "sign-up"

/**
 * Email and password, in one card.
 *
 * This posts through the Better Auth browser client rather than a server
 * action, because Better Auth sets the session cookie on its own response —
 * routing it through an action would mean forwarding `Set-Cookie` by hand.
 *
 * Errors are shown exactly as Better Auth words them. In particular, a failed
 * sign-in does not say whether the address exists: telling an attacker which
 * emails have accounts is the whole of an enumeration attack.
 */
function AuthForm({
  mode,
  redirectTo = "/dashboard",
  onSwitchMode,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Card>, "onSubmit"> & {
  mode: Mode
  redirectTo?: string
  /** Renders the "need an account?" link when provided. */
  onSwitchMode?: React.ReactNode
}) {
  const signUp = mode === "sign-up"
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)

    const data = new FormData(event.currentTarget)
    const email = String(data.get("email") ?? "")
    const password = String(data.get("password") ?? "")
    const name = String(data.get("name") ?? "")

    try {
      const oauth = new URLSearchParams(window.location.search).has("client_id")
      const callbackURL = oauth
        ? `/api/auth/oauth2/authorize${window.location.search}`
        : redirectTo
      const result = signUp
        ? await authClient.signUp.email({ email, password, name, callbackURL })
        : await authClient.signIn.email({ email, password, callbackURL })
      if (result.error)
        throw new Error(
          result.error.message ?? "That did not work. Please try again."
        )
      if (
        result.data &&
        "url" in result.data &&
        typeof result.data.url === "string"
      ) {
        window.location.assign(result.data.url)
      } else if (signUp) {
        window.location.assign(
          `/verify-email?email=${encodeURIComponent(email)}`
        )
      } else {
        window.location.assign(callbackURL)
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "That did not work. Please try again."
      )
      setPending(false)
    }
  }

  return (
    <Card className={cn("w-full max-w-sm", className)} {...props}>
      <form onSubmit={submit}>
        <CardHeader>
          <CardTitle>{signUp ? "Create an account" : "Sign in"}</CardTitle>
          <CardDescription>
            {signUp
              ? "You will start with your own organization."
              : "Welcome back."}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {signUp && (
            <Field>
              <FieldLabel htmlFor="auth-name">Name</FieldLabel>
              <Input
                id="auth-name"
                name="name"
                autoComplete="name"
                required
                disabled={pending}
              />
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="auth-email">Email</FieldLabel>
            <Input
              id="auth-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              disabled={pending}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="auth-password">Password</FieldLabel>
            <Input
              id="auth-password"
              name="password"
              type="password"
              autoComplete={signUp ? "new-password" : "current-password"}
              required
              minLength={8}
              disabled={pending}
            />
            {signUp ? (
              <FieldDescription>At least 8 characters.</FieldDescription>
            ) : null}
          </Field>

          {error ? <FieldError>{error}</FieldError> : null}
        </CardContent>

        <CardFooter className="flex-col items-stretch gap-3">
          <Button
            type="submit"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? <Spinner /> : null}
            {signUp ? "Create account" : "Sign in"}
          </Button>
          {onSwitchMode ? (
            <p className="text-center text-sm text-muted-foreground">
              {onSwitchMode}
            </p>
          ) : null}
        </CardFooter>
      </form>
    </Card>
  )
}

export { AuthForm }
