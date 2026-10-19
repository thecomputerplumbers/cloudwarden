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
import { Textarea } from "@workspace/ui/components/textarea"
import { useState, type FormEvent, type ReactNode } from "react"
import { message, type Project, type Secret } from "../../sm-store.ts"

export function ErrorLine({ text }: { text: string | null }) {
  return text ? (
    <p
      role="alert"
      className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {text}
    </p>
  ) : null
}

/** Runs a save, showing its error in the dialog instead of closing. */
function useSubmit(action: () => Promise<unknown>, onDone: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await action()
      onDone()
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, submit }
}

/** Create or rename something that has only a name: a project or a machine account. */
export function NameDialog({
  title,
  description,
  label,
  initial,
  submitLabel,
  onSave,
  onClose,
}: {
  title: string
  description: string
  label: string
  initial: string
  submitLabel: string
  onSave: (name: string) => Promise<unknown>
  onClose: () => void
}) {
  const [name, setName] = useState(initial)
  const { busy, error, setError, submit } = useSubmit(
    () => onSave(name.trim()),
    onClose
  )
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(event) =>
            name.trim()
              ? submit(event)
              : (event.preventDefault(), setError(`Give it a name.`))
          }
          className="grid gap-4"
        >
          <DialogHeader className="pr-8">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="cw-name" className="text-xs text-muted-foreground">
              {label}
            </Label>
            <Input
              id="cw-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9"
              autoComplete="off"
            />
          </div>
          <ErrorLine text={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string
  body: ReactNode
  confirmLabel: string
  onConfirm: () => Promise<unknown>
  onClose: () => void
}) {
  const { busy, error, submit } = useSubmit(onConfirm, onClose)
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="pr-8">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription render={<div />}>{body}</DialogDescription>
        </DialogHeader>
        <ErrorLine text={error} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const KEY_PATTERN = /^[A-Za-z0-9_.-]+$/

export function SecretEditor({
  secret,
  projects,
  defaultProjectId,
  onSave,
  onClose,
}: {
  secret: Secret | null
  projects: Project[]
  defaultProjectId: string | null
  onSave: (input: {
    projectId: string
    key: string
    value: string
    note: string | null
  }) => Promise<unknown>
  onClose: () => void
}) {
  const [key, setKey] = useState(secret?.key ?? "")
  const [value, setValue] = useState(secret?.value ?? "")
  const [note, setNote] = useState(secret?.note ?? "")
  const [projectId, setProjectId] = useState(
    secret?.projectId ?? defaultProjectId ?? projects[0]?.id ?? ""
  )
  const { busy, error, setError, submit } = useSubmit(
    () =>
      onSave({
        projectId,
        key: key.trim(),
        value,
        note: note.trim() ? note : null,
      }),
    onClose
  )
  const validate = (event: FormEvent) => {
    event.preventDefault()
    if (!key.trim()) return setError("Give the secret a key.")
    if (!KEY_PATTERN.test(key.trim()))
      return setError(
        "Keys use letters, digits, dots, dashes, and underscores, like DATABASE_URL."
      )
    if (!projectId) return setError("Choose a project.")
    void submit()
  }
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg">
        <DialogHeader className="pr-8">
          <DialogTitle>{secret ? "Edit secret" : "New secret"}</DialogTitle>
          <DialogDescription>
            Encrypted in your browser with the organization's key before it is
            saved.
          </DialogDescription>
        </DialogHeader>
        <form
          id="cw-secret"
          onSubmit={validate}
          className="-mx-4 min-h-0 space-y-4 overflow-y-auto border-t px-4 pt-4"
        >
          <div className="space-y-1.5">
            <Label
              htmlFor="cw-secret-key"
              className="text-xs text-muted-foreground"
            >
              Key
            </Label>
            <Input
              id="cw-secret-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="DATABASE_URL"
              className="h-9 font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="cw-secret-value"
              className="text-xs text-muted-foreground"
            >
              Value
            </Label>
            <Textarea
              id="cw-secret-value"
              rows={4}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="font-mono text-sm"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="cw-secret-project"
              className="text-xs text-muted-foreground"
            >
              Project
            </Label>
            <select
              id="cw-secret-project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="cw-secret-note"
              className="text-xs text-muted-foreground"
            >
              Note
            </Label>
            <Textarea
              id="cw-secret-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <ErrorLine text={error} />
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="cw-secret" disabled={busy}>
            {busy ? <Spinner /> : null}
            {secret ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
