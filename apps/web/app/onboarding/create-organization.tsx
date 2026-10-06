"use client"

import * as React from "react"

import { authClient } from "@workspace/auth/client"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Spinner } from "@workspace/ui/components/spinner"

/** Lowercase, hyphenated, no runs — the shape a URL segment wants. */
function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * The first organization.
 *
 * Billing keys on the organization, so an account without one cannot
 * subscribe — which is why sign-up lands here rather than on the dashboard.
 * Creating it also sets it as the session's active organization.
 */
export function CreateOrganization({ defaultName }: { defaultName?: string }) {
  const [name, setName] = React.useState(defaultName ?? "")
  const [slug, setSlug] = React.useState(slugify(defaultName ?? ""))
  const [slugEdited, setSlugEdited] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)

    try {
      const created = await authClient.organization.create({ name, slug })
      if (created.error)
        throw new Error(
          created.error.message ?? "Could not create the organization."
        )
      // Onboarding can recover by selecting this organization if activation fails.
      const active = await authClient.organization.setActive({
        organizationId: created.data.id,
      })
      if (active.error) {
        window.location.assign("/onboarding")
        return
      }
      window.location.assign("/dashboard")
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not create the organization."
      )
      setPending(false)
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <form onSubmit={submit}>
        <CardHeader>
          <CardTitle>Name your organization</CardTitle>
          <CardDescription>
            Billing, members and invitations all belong to it.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="org-name">Name</FieldLabel>
            <Input
              id="org-name"
              value={name}
              required
              disabled={pending}
              onChange={(event) => {
                setName(event.target.value)
                if (!slugEdited) setSlug(slugify(event.target.value))
              }}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="org-slug">Slug</FieldLabel>
            <Input
              id="org-slug"
              value={slug}
              required
              pattern="[a-z0-9-]+"
              disabled={pending}
              onChange={(event) => {
                setSlugEdited(true)
                setSlug(slugify(event.target.value))
              }}
            />
            <FieldDescription>Must be unique. Used in URLs.</FieldDescription>
          </Field>

          {error ? <FieldError>{error}</FieldError> : null}
        </CardContent>

        <CardFooter>
          <Button
            type="submit"
            className="w-full"
            disabled={pending || !slug}
            aria-busy={pending || undefined}
          >
            {pending ? <Spinner /> : null}
            Create organization
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
