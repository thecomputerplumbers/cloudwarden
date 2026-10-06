"use client"
import { useState } from "react"
import { authClient } from "@workspace/auth/client"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Field, FieldLabel, FieldError } from "@workspace/ui/components/field"
export function AccountForm({ name }: { name: string }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("")
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError("")
    setMessage("")
    const form = event.currentTarget,
      data = new FormData(form)
    try {
      const result = data.has("name")
        ? await authClient.updateUser({ name: String(data.get("name")) })
        : await authClient.changePassword({
            currentPassword: String(data.get("currentPassword")),
            newPassword: String(data.get("newPassword")),
            revokeOtherSessions: true,
          })
      if (result.error)
        throw new Error(result.error.message ?? "Please try again")
      setMessage("Changes saved.")
      if (!data.has("name")) form.reset()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Please try again")
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <h2 className="text-lg font-semibold">Profile</h2>
        <Field>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input
            id="name"
            name="name"
            defaultValue={name}
            required
            maxLength={100}
          />
        </Field>
        <Button disabled={busy}>Save name</Button>
      </form>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <h2 className="text-lg font-semibold">Change password</h2>
        <Field>
          <FieldLabel htmlFor="currentPassword">Current password</FieldLabel>
          <Input
            id="currentPassword"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="newPassword">New password</FieldLabel>
          <Input
            id="newPassword"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </Field>
        <p className="text-sm text-muted-foreground">
          Other browser sessions will be signed out.
        </p>
        <Button disabled={busy}>Change password</Button>
      </form>
      {error && <FieldError>{error}</FieldError>}
      {message && <p role="status">{message}</p>}
    </>
  )
}
