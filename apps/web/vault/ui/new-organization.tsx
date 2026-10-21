"use client"

import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Spinner } from "@workspace/ui/components/spinner"
import { useId, useState, type FormEvent } from "react"
import * as vault from "../store.ts"

/**
 * Names a new organization. The keys are made in the browser (see
 * `vault.createOrganization`); the creator becomes its owner with a "Default
 * collection", and invites people from Organization admin.
 */
export function NewOrganizationDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (orgId: string) => void
}) {
  const id = useId()
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await vault.createOrganization(trimmed))
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not create the organization"
      )
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="pr-8">
          <DialogTitle>New organization</DialogTitle>
          <DialogDescription>
            Share items with family or a team. You'll be its owner, with a
            Default collection to start; invite people from Organization admin.
          </DialogDescription>
        </DialogHeader>
        <form id={`${id}-form`} onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              placeholder="Weinheimer Family"
              autoFocus
              required
            />
          </div>
          {error ? (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={busy || !trimmed}>
            {busy ? <Spinner /> : null}
            Create organization
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
