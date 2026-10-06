"use client"
import { useState } from "react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Field, FieldLabel, FieldError } from "@workspace/ui/components/field"
import { post } from "@/components/action-button"
export function TeamForms({
  organizationId,
  name,
}: {
  organizationId: string
  name: string
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError("")
    const data = new FormData(event.currentTarget)
    try {
      if (data.has("email"))
        await post("/api/auth/organization/invite-member", {
          organizationId,
          email: data.get("email"),
          role: data.get("role"),
          resend: true,
        })
      else
        await post("/api/organization", {
          organizationId,
          name: data.get("name"),
          requestId: crypto.randomUUID(),
        })
      window.location.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Please try again")
      setBusy(false)
    }
  }
  return (
    <>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field>
          <FieldLabel htmlFor="orgName">Organization name</FieldLabel>
          <Input
            id="orgName"
            name="name"
            defaultValue={name}
            maxLength={100}
            required
          />
        </Field>
        <Button disabled={busy}>Save organization name</Button>
      </form>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <h2 className="text-lg font-semibold">Invite a teammate</h2>
        <Field>
          <FieldLabel htmlFor="inviteEmail">Email</FieldLabel>
          <Input id="inviteEmail" name="email" type="email" required />
        </Field>
        <Field>
          <FieldLabel htmlFor="inviteRole">Role</FieldLabel>
          <select
            className="h-10 rounded-md border bg-background px-3"
            name="role"
            id="inviteRole"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <Button disabled={busy}>Send invitation</Button>
      </form>
      {error && <FieldError>{error}</FieldError>}
    </>
  )
}
export function MemberRole({
  organizationId,
  memberId,
  role,
}: {
  organizationId: string
  memberId: string
  role: string
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  return (
    <div>
      <label className="sr-only" htmlFor={`role-${memberId}`}>
        Member role
      </label>
      <select
        id={`role-${memberId}`}
        className="h-9 rounded-md border bg-background px-2"
        defaultValue={role}
        disabled={busy}
        onChange={async (event) => {
          setBusy(true)
          try {
            await post("/api/auth/organization/update-member-role", {
              organizationId,
              memberId,
              role: event.target.value,
            })
            window.location.reload()
          } catch (cause) {
            setError(
              cause instanceof Error ? cause.message : "Could not change role"
            )
            setBusy(false)
          }
        }}
      >
        <option value="member">Member</option>
        <option value="admin">Admin</option>
        <option value="owner">Owner</option>
      </select>
      {error && <FieldError>{error}</FieldError>}
    </div>
  )
}
