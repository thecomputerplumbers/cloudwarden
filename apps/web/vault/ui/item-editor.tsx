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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Spinner } from "@workspace/ui/components/spinner"
import { Textarea } from "@workspace/ui/components/textarea"
import { cn } from "@workspace/ui/lib/utils"
import { DicesIcon, PlusIcon, XIcon } from "lucide-react"
import {
  cloneElement,
  isValidElement,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from "react"
import type { ItemDraft, ItemKind, VaultItem } from "../crypto/cipher.ts"
import { generatePassword } from "../password.ts"
import * as vault from "../store.ts"
import { VaultDot } from "./brand.tsx"
import { KIND_LABELS } from "./item-kinds.ts"

/** The folder picker's value for "no folder"; never a real folder id. */
const NO_FOLDER = "none"

function draftOf(
  item: VaultItem | null,
  kind: ItemKind,
  vaultId: string
): ItemDraft {
  if (item)
    return {
      kind: item.kind === "unknown" ? "note" : item.kind,
      name: item.name,
      notes: item.notes,
      favorite: item.favorite,
      folderId: item.folderId,
      organizationId: item.organizationId,
      collectionIds: item.collectionIds,
      login: item.login ?? {
        username: null,
        password: null,
        totp: null,
        uris: [],
      },
      card: item.card ?? {},
      identity: item.identity ?? {},
      sshKey: item.sshKey ?? {},
      fields: item.fields,
    }
  return {
    kind,
    name: "",
    notes: null,
    favorite: false,
    folderId: null,
    organizationId: vaultId === vault.PERSONAL ? null : vaultId,
    collectionIds: [],
    login: {
      username: null,
      password: null,
      totp: null,
      uris: [{ uri: "", match: null }],
    },
    card: {},
    identity: {},
    sshKey: {},
    fields: [],
  }
}

/**
 * A labelled form field. A single control is linked to the label; pass a
 * function to place the id on a control inside a row, or `group` for a set
 * of controls, which is then labelled as a group.
 */
function Field({
  label,
  children,
  className,
  group,
}: {
  label: string
  children: ReactNode | ((id: string) => ReactNode)
  className?: string
  group?: boolean
}) {
  const id = useId()
  const labelId = `${id}-label`
  const control =
    typeof children === "function"
      ? children(id)
      : !group && isValidElement(children)
        ? cloneElement(children as ReactElement<{ id?: string }>, { id })
        : children
  return (
    <div
      className={cn("space-y-1.5", className)}
      {...(group ? { role: "group", "aria-labelledby": labelId } : {})}
    >
      <Label
        id={labelId}
        {...(group ? {} : { htmlFor: id })}
        className="text-xs text-muted-foreground"
      >
        {label}
      </Label>
      {control}
    </div>
  )
}

const empty = (value: string) => (value.trim() ? value : null)

export function ItemEditor({
  open,
  item,
  kind,
  vaultId,
  onClose,
  onSaved,
}: {
  open: boolean
  item: VaultItem | null
  kind: ItemKind
  vaultId: string
  onClose: () => void
  onSaved: (item: VaultItem) => void
}) {
  const state = vault.useVault()
  const [draft, setDraft] = useState<ItemDraft>(() =>
    draftOf(item, kind, vaultId)
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const patch = (next: Partial<ItemDraft>) =>
    setDraft((current) => ({ ...current, ...next }))
  const patchLogin = (next: Partial<NonNullable<ItemDraft["login"]>>) =>
    setDraft((current) => ({
      ...current,
      login: { ...current.login!, ...next },
    }))
  const patchRecord = (
    key: "card" | "identity" | "sshKey",
    name: string,
    value: string
  ) =>
    setDraft((current) => ({
      ...current,
      [key]: { ...current[key], [name]: empty(value) },
    }))
  const vaultChoice = draft.organizationId ?? vault.PERSONAL
  const collections = state.collections.filter(
    (entry) => entry.vaultId === draft.organizationId && !entry.readOnly
  )
  const writableVaults = state.vaults.filter((entry) => entry.readable)

  async function save() {
    if (!draft.name.trim()) return setError("Give the item a name.")
    if (draft.organizationId && !draft.collectionIds.length)
      return setError("Choose at least one collection for a shared item.")
    setBusy(true)
    setError(null)
    try {
      const login =
        draft.kind === "login" && draft.login
          ? {
              ...draft.login,
              uris: draft.login.uris.filter((entry) => entry.uri.trim()),
            }
          : undefined
      const saved = await vault.saveItem(
        { ...draft, name: draft.name.trim(), ...(login ? { login } : {}) },
        item ?? undefined
      )
      onSaved(saved)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const text = (value: string | null | undefined) => value ?? ""
  const folderItems = [
    { value: NO_FOLDER, label: "No folder" },
    ...state.folders.map((folder) => ({
      value: folder.id,
      label: folder.name,
    })),
  ]

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (!next ? onClose() : undefined)}
    >
      <DialogContent className="max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl">
        <DialogHeader className="gap-3 pr-8">
          <DialogTitle className="label-caps font-normal text-muted-foreground">
            {item
              ? `Edit ${KIND_LABELS[draft.kind].toLowerCase()}`
              : `New ${KIND_LABELS[draft.kind].toLowerCase()}`}
          </DialogTitle>
          <input
            aria-label="Name"
            placeholder="Untitled"
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            className="-mx-2 w-[calc(100%+1rem)] rounded-md border border-transparent bg-transparent px-2 py-1 text-xl font-semibold tracking-[-0.015em] font-wide transition-colors outline-none placeholder:text-muted-foreground/60 hover:border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25"
          />
          <DialogDescription className="text-xs">
            Encrypted in your browser before it is saved.
          </DialogDescription>
        </DialogHeader>
        <form
          id="cw-editor"
          onSubmit={(event) => (event.preventDefault(), void save())}
          className="-mx-4 min-h-0 space-y-4 overflow-y-auto border-t px-4 pt-4"
        >
          {!item && writableVaults.length > 1 && (
            <Field label="Vault" group>
              <div className="flex flex-wrap gap-1.5">
                {writableVaults.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() =>
                      patch({
                        organizationId:
                          entry.id === vault.PERSONAL ? null : entry.id,
                        collectionIds: [],
                        folderId: null,
                      })
                    }
                    className={cn(
                      "flex h-8 items-center gap-2 rounded-md border px-3 text-sm transition-colors",
                      vaultChoice === entry.id
                        ? "border-primary bg-primary/8 text-foreground"
                        : "hover:bg-muted"
                    )}
                  >
                    <VaultDot color={entry.color} />
                    {entry.name}
                  </button>
                ))}
              </div>
            </Field>
          )}
          {draft.organizationId && !item && (
            <Field label="Collections" group>
              <div className="flex flex-wrap gap-1.5">
                {collections.map((entry) => {
                  const on = draft.collectionIds.includes(entry.id)
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() =>
                        patch({
                          collectionIds: on
                            ? draft.collectionIds.filter(
                                (id) => id !== entry.id
                              )
                            : [...draft.collectionIds, entry.id],
                        })
                      }
                      className={cn(
                        "h-8 rounded-md border px-3 text-sm transition-colors",
                        on
                          ? "border-primary bg-primary/8 text-foreground"
                          : "hover:bg-muted"
                      )}
                    >
                      {entry.name}
                    </button>
                  )
                })}
                {!collections.length && (
                  <p className="text-sm text-muted-foreground">
                    You cannot add items to any collection in this organization.
                  </p>
                )}
              </div>
            </Field>
          )}
          {!draft.organizationId && state.folders.length > 0 && (
            <Field label="Folder">
              <Select
                items={folderItems}
                value={draft.folderId ?? NO_FOLDER}
                onValueChange={(value) =>
                  patch({ folderId: value === NO_FOLDER ? null : value })
                }
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {folderItems.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {draft.kind === "login" && draft.login && (
            <div className="space-y-4 rounded-md border bg-surface-1 p-4">
              <Field label="Username">
                <Input
                  autoComplete="off"
                  value={text(draft.login.username)}
                  onChange={(e) =>
                    patchLogin({ username: empty(e.target.value) })
                  }
                  className="h-9"
                />
              </Field>
              <Field label="Password">
                {(id) => (
                  <div className="flex gap-2">
                    <Input
                      id={id}
                      autoComplete="new-password"
                      value={text(draft.login!.password)}
                      onChange={(e) =>
                        patchLogin({ password: empty(e.target.value) })
                      }
                      className="h-9 font-mono"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9"
                      onClick={() =>
                        patchLogin({ password: generatePassword() })
                      }
                    >
                      <DicesIcon /> Generate
                    </Button>
                  </div>
                )}
              </Field>
              <Field label="Authenticator key (TOTP)">
                <Input
                  autoComplete="off"
                  value={text(draft.login.totp)}
                  onChange={(e) => patchLogin({ totp: empty(e.target.value) })}
                  className="h-9 font-mono"
                  placeholder="otpauth://… or base32 secret"
                />
              </Field>
              <Field label="Websites" group>
                <div className="space-y-2">
                  {draft.login.uris.map((entry, index) => (
                    <div key={index} className="flex gap-2">
                      <Input
                        aria-label={`Website ${index + 1}`}
                        value={entry.uri}
                        placeholder="https://example.com"
                        onChange={(e) =>
                          patchLogin({
                            uris: draft.login!.uris.map((u, i) =>
                              i === index ? { ...u, uri: e.target.value } : u
                            ),
                          })
                        }
                        className="h-9"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove website"
                        onClick={() =>
                          patchLogin({
                            uris: draft.login!.uris.filter(
                              (_, i) => i !== index
                            ),
                          })
                        }
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      patchLogin({
                        uris: [...draft.login!.uris, { uri: "", match: null }],
                      })
                    }
                  >
                    <PlusIcon /> Add website
                  </Button>
                </div>
              </Field>
            </div>
          )}

          {draft.kind === "card" && (
            <div className="grid grid-cols-2 gap-4 rounded-md border bg-surface-1 p-4">
              <Field label="Cardholder" className="col-span-2">
                <Input
                  value={text(draft.card?.cardholderName)}
                  onChange={(e) =>
                    patchRecord("card", "cardholderName", e.target.value)
                  }
                  className="h-9"
                />
              </Field>
              <Field label="Number" className="col-span-2">
                <Input
                  inputMode="numeric"
                  autoComplete="off"
                  value={text(draft.card?.number)}
                  onChange={(e) =>
                    patchRecord("card", "number", e.target.value)
                  }
                  className="h-9 font-mono"
                />
              </Field>
              <Field label="Brand">
                <Input
                  value={text(draft.card?.brand)}
                  onChange={(e) => patchRecord("card", "brand", e.target.value)}
                  className="h-9"
                />
              </Field>
              <Field label="Security code">
                <Input
                  autoComplete="off"
                  value={text(draft.card?.code)}
                  onChange={(e) => patchRecord("card", "code", e.target.value)}
                  className="h-9 font-mono"
                />
              </Field>
              <Field label="Expiry month">
                <Input
                  inputMode="numeric"
                  value={text(draft.card?.expMonth)}
                  onChange={(e) =>
                    patchRecord("card", "expMonth", e.target.value)
                  }
                  className="h-9"
                />
              </Field>
              <Field label="Expiry year">
                <Input
                  inputMode="numeric"
                  value={text(draft.card?.expYear)}
                  onChange={(e) =>
                    patchRecord("card", "expYear", e.target.value)
                  }
                  className="h-9"
                />
              </Field>
            </div>
          )}

          {draft.kind === "identity" && (
            <div className="grid grid-cols-2 gap-4 rounded-md border bg-surface-1 p-4">
              {(
                [
                  ["firstName", "First name"],
                  ["lastName", "Last name"],
                  ["email", "Email"],
                  ["phone", "Phone"],
                  ["company", "Company"],
                  ["address1", "Address"],
                  ["city", "City"],
                  ["state", "State"],
                  ["postalCode", "Postal code"],
                  ["country", "Country"],
                ] as const
              ).map(([name, label]) => (
                <Field key={name} label={label}>
                  <Input
                    value={text(draft.identity?.[name])}
                    onChange={(e) =>
                      patchRecord("identity", name, e.target.value)
                    }
                    className="h-9"
                  />
                </Field>
              ))}
            </div>
          )}

          {draft.kind === "sshKey" && (
            <div className="space-y-4 rounded-md border bg-surface-1 p-4">
              <Field label="Private key">
                <Textarea
                  rows={4}
                  value={text(draft.sshKey?.privateKey)}
                  onChange={(e) =>
                    patchRecord("sshKey", "privateKey", e.target.value)
                  }
                  className="font-mono text-xs"
                />
              </Field>
              <Field label="Public key">
                <Textarea
                  rows={2}
                  value={text(draft.sshKey?.publicKey)}
                  onChange={(e) =>
                    patchRecord("sshKey", "publicKey", e.target.value)
                  }
                  className="font-mono text-xs"
                />
              </Field>
              <Field label="Fingerprint">
                <Input
                  value={text(draft.sshKey?.keyFingerprint)}
                  onChange={(e) =>
                    patchRecord("sshKey", "keyFingerprint", e.target.value)
                  }
                  className="h-9 font-mono"
                />
              </Field>
            </div>
          )}

          <Field label="Notes">
            <Textarea
              rows={draft.kind === "note" ? 8 : 3}
              value={text(draft.notes)}
              onChange={(e) => patch({ notes: empty(e.target.value) })}
            />
          </Field>

          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="cw-editor" disabled={busy}>
            {busy ? <Spinner /> : null}
            {item ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
