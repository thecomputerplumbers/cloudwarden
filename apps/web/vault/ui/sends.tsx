"use client"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Spinner } from "@workspace/ui/components/spinner"
import { Textarea } from "@workspace/ui/components/textarea"
import { formatRelativeTime } from "@workspace/ui-data/lib/format"
import {
  ArrowLeftIcon,
  FileIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
  TextIcon,
} from "lucide-react"
import { useEffect, useId, useState, type FormEvent } from "react"
import * as sends from "../send-store.ts"
import { ConfirmDialog } from "./secrets/dialogs.tsx"
import { copy, toast } from "./toast.tsx"

const DAY = 24 * 60 * 60 * 1000
const DELETION_DAYS = [1, 2, 3, 7, 14, 30]

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: (id: string) => React.ReactNode
}) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children(id)}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

const selectClass =
  "h-9 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"

function Check({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center gap-2.5 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--primary)]"
      />
      {label}
    </label>
  )
}

function SendDialog({
  send,
  kind: initialKind,
  onClose,
}: {
  send: sends.Send | null
  kind: "text" | "file"
  onClose: () => void
}) {
  const kind = send?.kind ?? initialKind
  const [name, setName] = useState(send?.name ?? "")
  const [text, setText] = useState(send?.text ?? "")
  const [hidden, setHidden] = useState(send?.hidden ?? false)
  const [file, setFile] = useState<File | null>(null)
  const [notes, setNotes] = useState(send?.notes ?? "")
  // An edit keeps the deletion date unless another is chosen.
  const [deletion, setDeletion] = useState(7)
  const [keepDeletion, setKeepDeletion] = useState(!!send)
  const [maxAccess, setMaxAccess] = useState(
    send?.maxAccessCount ? String(send.maxAccessCount) : ""
  )
  const [password, setPassword] = useState("")
  const [removePassword, setRemovePassword] = useState(false)
  const [hideEmail, setHideEmail] = useState(send?.hideEmail ?? false)
  const [disabled, setDisabled] = useState(send?.disabled ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (!name.trim()) return setError("Give the Send a name.")
    if (kind === "text" && !text) return setError("Add the text to send.")
    if (kind === "file" && !send && !file) return setError("Choose a file.")
    if (file && file.size > sends.MAX_FILE)
      return setError("Files can be up to 19 MB.")
    const max = maxAccess.trim() ? Number.parseInt(maxAccess, 10) : null
    if (max !== null && !(max >= 1)) return setError("Use a number above 0.")
    setBusy(true)
    try {
      const saved = await sends.save(
        {
          name: name.trim(),
          notes: notes.trim() || null,
          text: kind === "text" ? text : null,
          hidden,
          file,
          password: removePassword ? null : password,
          deletionDate:
            keepDeletion && send
              ? new Date(send.deletionDate)
              : new Date(Date.now() + deletion * DAY),
          expirationDate: send?.expirationDate
            ? new Date(send.expirationDate)
            : null,
          maxAccessCount: max,
          hideEmail,
          disabled,
        },
        send ?? undefined
      )
      if (!send && saved) {
        await copy(saved.link, "Link")
        toast("Send created. Its link is copied.")
      } else toast("Send saved.")
      onClose()
    } catch (failure) {
      setError(sends.message(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg">
        <DialogHeader className="pr-8">
          <DialogTitle>
            {send
              ? "Edit Send"
              : kind === "file"
                ? "New file Send"
                : "New text Send"}
          </DialogTitle>
          <DialogDescription>
            Anyone with the link can open it until it is deleted. It is
            encrypted here; the key travels only in the link.
          </DialogDescription>
        </DialogHeader>
        <form
          id="cw-send-form"
          onSubmit={submit}
          className="-mx-1 grid gap-4 overflow-y-auto px-1"
        >
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                autoFocus
                className="h-9"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          {kind === "text" ? (
            <>
              <Field label="Text">
                {(id) => (
                  <Textarea
                    id={id}
                    rows={5}
                    className="font-mono text-sm"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                )}
              </Field>
              <Check
                label="Hide the text until the recipient chooses to show it"
                checked={hidden}
                onChange={setHidden}
              />
            </>
          ) : send ? (
            <p className="flex items-center gap-2 rounded-md border bg-surface-1 px-3 py-2 text-sm">
              <FileIcon className="size-4 text-muted-foreground" />
              {send.fileName} · {send.fileSize}
            </p>
          ) : (
            <Field label="File" hint="Up to 19 MB.">
              {(id) => (
                <Input
                  id={id}
                  type="file"
                  className="h-auto py-1.5"
                  onChange={(e) => {
                    const chosen = e.target.files?.[0] ?? null
                    setFile(chosen)
                    if (chosen && !name) setName(chosen.name)
                  }}
                />
              )}
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Deleted after">
              {(id) => (
                <select
                  id={id}
                  className={selectClass}
                  value={keepDeletion ? "keep" : deletion}
                  onChange={(e) =>
                    e.target.value === "keep"
                      ? setKeepDeletion(true)
                      : (setKeepDeletion(false),
                        setDeletion(Number(e.target.value)))
                  }
                >
                  {send ? (
                    <option value="keep">
                      As set ({new Date(send.deletionDate).toLocaleDateString()}
                      )
                    </option>
                  ) : null}
                  {DELETION_DAYS.map((days) => (
                    <option key={days} value={days}>
                      {days === 1 ? "1 day" : `${days} days`}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Maximum opens">
              {(id) => (
                <Input
                  id={id}
                  inputMode="numeric"
                  placeholder="No limit"
                  className="h-9"
                  value={maxAccess}
                  onChange={(e) => setMaxAccess(e.target.value)}
                />
              )}
            </Field>
          </div>
          <Field
            label={send?.hasPassword ? "New password" : "Password (optional)"}
            hint={
              send?.hasPassword
                ? "Leave empty to keep the current password."
                : "The recipient needs it as well as the link."
            }
          >
            {(id) => (
              <Input
                id={id}
                type="password"
                autoComplete="new-password"
                className="h-9"
                disabled={removePassword}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          {send?.hasPassword ? (
            <Check
              label="Remove the password"
              checked={removePassword}
              onChange={setRemovePassword}
            />
          ) : null}
          <Field label="Private notes">
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            )}
          </Field>
          <Check
            label="Hide my email address from recipients"
            checked={hideEmail}
            onChange={setHideEmail}
          />
          <Check
            label="Turn this Send off (nobody can open it)"
            checked={disabled}
            onChange={setDisabled}
          />
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
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="cw-send-form" disabled={busy}>
            {busy ? <Spinner /> : null}
            {send ? "Save" : "Create and copy link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function status(send: sends.Send) {
  if (send.disabled) return "Off"
  if (send.expirationDate && Date.parse(send.expirationDate) < Date.now())
    return "Expired"
  if (send.maxAccessCount !== null && send.accessCount >= send.maxAccessCount)
    return "Used up"
  return null
}

export function Sends({ onExit }: { onExit: () => void }) {
  const state = sends.useSends()
  const [dialog, setDialog] = useState<
    | { kind: "edit"; send: sends.Send | null; type: "text" | "file" }
    | { kind: "delete"; send: sends.Send }
    | null
  >(null)
  useEffect(() => {
    void sends.load()
  }, [])
  const close = () => setDialog(null)

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="shrink-0 border-b">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3 md:px-6">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to vault"
            onClick={onExit}
          >
            <ArrowLeftIcon />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-[-0.015em] font-wide">
              Send
            </h1>
            <p className="text-sm text-muted-foreground">
              Share text or a file, end-to-end encrypted, with anyone.
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="sm" />}>
              <PlusIcon />
              <span className="hidden sm:inline">New Send</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onClick={() =>
                  setDialog({ kind: "edit", send: null, type: "text" })
                }
              >
                <TextIcon /> Text
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  setDialog({ kind: "edit", send: null, type: "file" })
                }
              >
                <FileIcon /> File
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 md:px-6">
          {state.error ? (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {state.error}
            </p>
          ) : null}
          {state.loading ? (
            <div className="flex justify-center p-10">
              <Spinner />
            </div>
          ) : state.sends.length === 0 ? (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              No Sends yet. A Send is a link to some text or a file that deletes
              itself after a few days.
            </p>
          ) : (
            <ul className="divide-y overflow-hidden rounded-md border bg-card">
              {state.sends.map((send) => {
                const note = status(send)
                return (
                  <li
                    key={send.id}
                    className="flex min-h-14 items-center gap-3 px-4 py-2.5"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-1 text-muted-foreground">
                      {send.kind === "file" ? (
                        <FileIcon className="size-4" />
                      ) : (
                        <TextIcon className="size-4" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className="min-w-0 truncate">{send.name}</span>
                        {send.hasPassword ? (
                          <Badge variant="secondary">Password</Badge>
                        ) : null}
                        {note ? (
                          <Badge variant="secondary" className="text-warning">
                            {note}
                          </Badge>
                        ) : null}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        Deleted{" "}
                        {formatRelativeTime(new Date(send.deletionDate))}
                        {" · "}
                        {send.maxAccessCount
                          ? `${send.accessCount} of ${send.maxAccessCount} opens`
                          : `${send.accessCount} ${send.accessCount === 1 ? "open" : "opens"}`}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => copy(send.link, "Link")}
                    >
                      <LinkIcon />
                      <span className="hidden sm:inline">Copy link</span>
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Actions for ${send.name}`}
                          />
                        }
                      >
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem
                          disabled={send.emailAuth}
                          onClick={() =>
                            setDialog({ kind: "edit", send, type: send.kind })
                          }
                        >
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => window.open(send.link, "_blank")}
                        >
                          Open as recipient
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDialog({ kind: "delete", send })}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </main>
      {dialog?.kind === "edit" && (
        <SendDialog send={dialog.send} kind={dialog.type} onClose={close} />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title={`Delete ${dialog.send.name}?`}
          body="Its link stops working straight away."
          confirmLabel="Delete"
          onConfirm={async () => {
            await sends.remove(dialog.send)
            toast("Send deleted.")
          }}
          onClose={close}
        />
      )}
    </div>
  )
}
