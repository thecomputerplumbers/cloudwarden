"use client"
import { useState } from "react"
import Link from "next/link"
import { authClient } from "@workspace/auth/client"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Field, FieldLabel, FieldError } from "@workspace/ui/components/field"

export function EmailFlow({
  mode,
  token = "",
  initialEmail = "",
}: {
  mode: "forgot" | "reset" | "verify"
  token?: string
  initialEmail?: string
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("")
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError("")
    setMessage("")
    const data = new FormData(event.currentTarget)
    const email = String(data.get("email") ?? "")
    try {
      const result =
        mode === "forgot"
          ? await authClient.requestPasswordReset({
              email,
              redirectTo: `${window.location.origin}/reset-password`,
            })
          : mode === "verify"
            ? await authClient.sendVerificationEmail({
                email,
                callbackURL: "/onboarding",
              })
            : await authClient.resetPassword({
                token,
                newPassword: String(data.get("password") ?? ""),
              })
      if (result.error)
        throw new Error(result.error.message ?? "Please try again")
      setMessage(
        mode === "reset"
          ? "Password updated. You can now sign in."
          : "If this address is eligible, an email is on its way. Check your inbox."
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Please try again")
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      {mode === "reset" ? (
        <Field>
          <FieldLabel htmlFor="password">New password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </Field>
      ) : (
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            defaultValue={initialEmail}
            autoComplete="email"
            required
          />
        </Field>
      )}
      {mode === "reset" && !token && (
        <FieldError>
          This reset link is missing or expired. Request another one.
        </FieldError>
      )}
      {error && <FieldError>{error}</FieldError>}
      {message && <p role="status">{message}</p>}
      <Button disabled={busy || (mode === "reset" && !token)} type="submit">
        {busy
          ? "Please wait…"
          : mode === "forgot"
            ? "Send reset link"
            : mode === "verify"
              ? "Resend verification email"
              : "Set new password"}
      </Button>
      <Link className="underline" href="/sign-in">
        Back to sign in
      </Link>
      {mode === "reset" && (
        <Link className="underline" href="/forgot-password">
          Request a new reset link
        </Link>
      )}
    </form>
  )
}
