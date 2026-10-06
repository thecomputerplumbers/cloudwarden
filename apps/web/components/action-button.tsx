"use client"
import { useState } from "react"
import { Button } from "@workspace/ui/components/button"
export async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const result = (await response.json()) as {
    error?: string | { message?: string }
    message?: string
    url?: string
  }
  if (!response.ok)
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : (result.error?.message ?? result.message ?? "Request failed")
    )
  return result
}
export function ActionButton({
  label,
  path,
  body,
  redirectTo,
}: {
  label: string
  path: string
  body: unknown
  redirectTo?: string
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  return (
    <div>
      <Button
        variant="outline"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError("")
          try {
            await post(path, body)
            if (redirectTo) window.location.assign(redirectTo)
            else window.location.reload()
          } catch (cause) {
            setError(
              cause instanceof Error ? cause.message : "Please try again"
            )
            setBusy(false)
          }
        }}
      >
        {busy ? "Please wait…" : label}
      </Button>
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
