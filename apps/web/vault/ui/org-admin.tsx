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
import { cn } from "@workspace/ui/lib/utils"
import {
  ArrowLeftIcon,
  FolderIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react"
import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import { ROLES, STATUS } from "../org-api.ts"
import * as admin from "../org-store.ts"
import type { Vault } from "../store.ts"
import { VaultDot } from "./brand.tsx"
import { ConfirmDialog } from "./secrets/dialogs.tsx"
import { toast } from "./toast.tsx"

type Tab = "members" | "groups" | "collections"

const ROLE_LABELS: Record<number, string> = {
  [ROLES.owner]: "Owner",
  [ROLES.admin]: "Admin",
  [ROLES.user]: "User",
}

// Bitwarden's collection permissions, as the three flags the server keeps.
const PERMISSIONS = [
  { label: "Can view", readOnly: true, hidePasswords: false, manage: false },
  {
    label: "Can view, except passwords",
    readOnly: true,
    hidePasswords: true,
    manage: false,
  },
  { label: "Can edit", readOnly: false, hidePasswords: false, manage: false },
  {
    label: "Can edit, except passwords",
    readOnly: false,
    hidePasswords: true,
    manage: false,
  },
  { label: "Can manage", readOnly: false, hidePasswords: false, manage: true },
] as const

const permissionOf = (grant: admin.Grant) =>
  Math.max(
    0,
    PERMISSIONS.findIndex(
      (p) =>
        p.readOnly === grant.readOnly &&
        p.hidePasswords === grant.hidePasswords &&
        p.manage === grant.manage
    )
  )
const permissionLabel = (grant: admin.Grant) =>
  PERMISSIONS[permissionOf(grant)]!.label

function ErrorLine({ text }: { text: string | null }) {
  return text ? (
    <p
      role="alert"
      className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {text}
    </p>
  ) : null
}

const selectClass =
  "h-8 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"

/** Runs a dialog's save, keeping its error in the dialog. */
function useSave(action: () => Promise<unknown>, onDone: () => void) {
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
      setError(admin.message(failure))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, submit }
}

function FormDialog({
  title,
  description,
  onClose,
  onSubmit,
  busy,
  error,
  submitLabel,
  children,
}: {
  title: string
  description: string
  onClose: () => void
  onSubmit: (event: FormEvent) => void
  busy: boolean
  error: string | null
  submitLabel: string
  children: ReactNode
}) {
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg">
        <DialogHeader className="pr-8">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          id="cw-admin-form"
          onSubmit={onSubmit}
          className="-mx-1 grid gap-4 overflow-y-auto px-1"
        >
          {children}
          <ErrorLine text={error} />
        </form>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="cw-admin-form" disabled={busy}>
            {busy ? <Spinner /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TextField({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & React.ComponentProps<typeof Input>) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        className="h-9"
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...input}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

function RoleField({
  value,
  onChange,
}: {
  value: number
  onChange: (role: number) => void
}) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        Role
      </Label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(selectClass, "h-9 w-full")}
      >
        <option value={ROLES.user}>User: the collections you choose</option>
        <option value={ROLES.admin}>
          Admin: every collection, and managing members
        </option>
        <option value={ROLES.owner}>Owner: everything, including owners</option>
      </select>
    </div>
  )
}

/** A checklist of things (collections, members, groups), each with a collection permission. */
function AccessList({
  label,
  options,
  grants,
  onChange,
  empty,
}: {
  label: string
  options: { id: string; name: string; detail?: string }[]
  grants: admin.Grant[]
  onChange: (grants: admin.Grant[]) => void
  empty: string
}) {
  const id = useId()
  const toggle = (optionId: string, on: boolean) =>
    onChange(
      on
        ? [
            ...grants,
            {
              id: optionId,
              readOnly: false,
              hidePasswords: false,
              manage: false,
            },
          ]
        : grants.filter((grant) => grant.id !== optionId)
    )
  const setPermission = (optionId: string, index: number) => {
    const { readOnly, hidePasswords, manage } = PERMISSIONS[index]!
    onChange(
      grants.map((grant) =>
        grant.id === optionId
          ? { id: optionId, readOnly, hidePasswords, manage }
          : grant
      )
    )
  }
  return (
    <fieldset className="space-y-1.5" aria-labelledby={id}>
      <p id={id} className="text-xs text-muted-foreground">
        {label}
      </p>
      {options.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {options.map((option) => {
            const grant = grants.find((entry) => entry.id === option.id)
            return (
              <li
                key={option.id}
                className="flex min-h-11 items-center gap-3 px-3 py-1.5"
              >
                <label className="flex min-w-0 flex-1 items-center gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={!!grant}
                    onChange={(e) => toggle(option.id, e.target.checked)}
                    className="accent-[var(--primary)]"
                  />
                  <span className="min-w-0 truncate">
                    {option.name}
                    {option.detail ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {option.detail}
                      </span>
                    ) : null}
                  </span>
                </label>
                {grant ? (
                  <select
                    aria-label={`Permission for ${option.name}`}
                    value={permissionOf(grant)}
                    onChange={(e) =>
                      setPermission(option.id, Number(e.target.value))
                    }
                    className={selectClass}
                  >
                    {PERMISSIONS.map((p, index) => (
                      <option key={p.label} value={index}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </fieldset>
  )
}

/** A plain checklist, for group membership. */
function CheckList({
  label,
  options,
  selected,
  onChange,
  empty,
}: {
  label: string
  options: { id: string; name: string; detail?: string }[]
  selected: string[]
  onChange: (ids: string[]) => void
  empty: string
}) {
  const id = useId()
  return (
    <fieldset className="space-y-1.5" aria-labelledby={id}>
      <p id={id} className="text-xs text-muted-foreground">
        {label}
      </p>
      {options.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {options.map((option) => (
            <li key={option.id} className="px-3 py-2">
              <label className="flex items-center gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(option.id)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...selected, option.id]
                        : selected.filter((entry) => entry !== option.id)
                    )
                  }
                  className="accent-[var(--primary)]"
                />
                <span className="min-w-0 truncate">
                  {option.name}
                  {option.detail ? (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {option.detail}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}

const memberName = (member: admin.Member) => member.name || member.email

// Dialogs -------------------------------------------------------------------

function InviteDialog({ onClose }: { onClose: () => void }) {
  const state = admin.useOrg()
  const [emails, setEmails] = useState("")
  const [role, setRole] = useState<number>(ROLES.user)
  const [collections, setCollections] = useState<admin.Grant[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const list = emails
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
  const { busy, error, setError, submit } = useSave(async () => {
    await admin.invite({ emails: list, role, collections, groups })
    toast(
      list.length === 1
        ? `Invited ${list[0]}.`
        : `Invited ${list.length} people.`
    )
  }, onClose)
  return (
    <FormDialog
      title="Invite members"
      description="Each person gets an email to join. Once they accept, confirm them here to share the organization's key."
      onClose={onClose}
      onSubmit={(event) => {
        if (list.length === 0) {
          event.preventDefault()
          return setError("Enter at least one email address.")
        }
        if (list.length > 20) {
          event.preventDefault()
          return setError("Invite up to 20 people at a time.")
        }
        void submit(event)
      }}
      busy={busy}
      error={error}
      submitLabel="Invite"
    >
      <TextField
        label="Email addresses"
        hint="Separate several with commas."
        autoFocus
        value={emails}
        onChange={(e) => setEmails(e.target.value)}
      />
      <RoleField value={role} onChange={setRole} />
      {role === ROLES.user ? (
        <AccessList
          label="Collections"
          options={state.collections}
          grants={collections}
          onChange={setCollections}
          empty="This organization has no collections yet."
        />
      ) : null}
      <CheckList
        label="Groups"
        options={state.groups}
        selected={groups}
        onChange={setGroups}
        empty="This organization has no groups."
      />
    </FormDialog>
  )
}

function MemberDialog({
  member,
  onClose,
}: {
  member: admin.Member
  onClose: () => void
}) {
  const state = admin.useOrg()
  const [role, setRole] = useState(member.role)
  const [collections, setCollections] = useState(member.collections)
  const [groups, setGroups] = useState(member.groups)
  const { busy, error, submit } = useSave(async () => {
    await admin.updateMember(member, { role, collections, groups })
    toast(`Saved ${memberName(member)}.`)
  }, onClose)
  return (
    <FormDialog
      title={memberName(member)}
      description={member.email}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel="Save"
    >
      <RoleField value={role} onChange={setRole} />
      {role === ROLES.user ? (
        <AccessList
          label="Collections"
          options={state.collections}
          grants={collections}
          onChange={setCollections}
          empty="This organization has no collections yet."
        />
      ) : null}
      <CheckList
        label="Groups"
        options={state.groups}
        selected={groups}
        onChange={setGroups}
        empty="This organization has no groups."
      />
    </FormDialog>
  )
}

function GroupDialog({
  group,
  onClose,
}: {
  group: admin.Group | null
  onClose: () => void
}) {
  const state = admin.useOrg()
  const [name, setName] = useState(group?.name ?? "")
  const [members, setMembers] = useState(group?.members ?? [])
  const [collections, setCollections] = useState(group?.collections ?? [])
  const { busy, error, setError, submit } = useSave(async () => {
    await admin.saveGroup(
      { name: name.trim(), members, collections },
      group?.id
    )
    toast(group ? `Saved ${name.trim()}.` : `Created ${name.trim()}.`)
  }, onClose)
  return (
    <FormDialog
      title={group ? "Edit group" : "New group"}
      description="Members of a group get its collections, on top of their own."
      onClose={onClose}
      onSubmit={(event) =>
        name.trim()
          ? void submit(event)
          : (event.preventDefault(), setError("Give the group a name."))
      }
      busy={busy}
      error={error}
      submitLabel={group ? "Save" : "Create"}
    >
      <TextField
        label="Name"
        autoFocus
        maxLength={100}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <AccessList
        label="Collections"
        options={state.collections}
        grants={collections}
        onChange={setCollections}
        empty="This organization has no collections yet."
      />
      <CheckList
        label="Members"
        options={state.members.map((member) => ({
          id: member.id,
          name: memberName(member),
          detail: member.name ? member.email : undefined,
        }))}
        selected={members}
        onChange={setMembers}
        empty="No members yet."
      />
    </FormDialog>
  )
}

function CollectionDialog({
  collection,
  onClose,
}: {
  collection: admin.Collection | null
  onClose: () => void
}) {
  const state = admin.useOrg()
  const [name, setName] = useState(collection?.name ?? "")
  const [groups, setGroups] = useState(collection?.groups ?? [])
  const [members, setMembers] = useState(collection?.members ?? [])
  const { busy, error, setError, submit } = useSave(async () => {
    await admin.saveCollection(
      { name: name.trim(), groups, members },
      collection?.id
    )
    toast(collection ? `Saved ${name.trim()}.` : `Created ${name.trim()}.`)
  }, onClose)
  // Owners and admins already reach every collection.
  const users = state.members.filter((member) => member.role === ROLES.user)
  return (
    <FormDialog
      title={collection ? "Edit collection" : "New collection"}
      description="Who can reach this collection's items, and what they can do with them. Owners and admins always can."
      onClose={onClose}
      onSubmit={(event) =>
        name.trim()
          ? void submit(event)
          : (event.preventDefault(), setError("Give the collection a name."))
      }
      busy={busy}
      error={error}
      submitLabel={collection ? "Save" : "Create"}
    >
      <TextField
        label="Name"
        hint="Encrypted with the organization's key before it leaves this browser."
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <AccessList
        label="Groups"
        options={state.groups}
        grants={groups}
        onChange={setGroups}
        empty="This organization has no groups."
      />
      <AccessList
        label="Members"
        options={users.map((member) => ({
          id: member.id,
          name: memberName(member),
          detail: member.name ? member.email : undefined,
        }))}
        grants={members}
        onChange={setMembers}
        empty="No members with the User role."
      />
    </FormDialog>
  )
}

// Rows ----------------------------------------------------------------------

function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Actions for ${label}`}
          />
        }
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Row({
  title,
  badges,
  detail,
  action,
  menu,
}: {
  title: ReactNode
  badges?: ReactNode
  detail?: ReactNode
  action?: ReactNode
  menu?: ReactNode
}) {
  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="min-w-0 truncate">{title}</span>
          {badges}
        </p>
        {detail ? (
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        ) : null}
      </div>
      {action}
      {menu}
    </li>
  )
}

type Dialogs =
  | { kind: "invite" }
  | { kind: "member"; member: admin.Member }
  | { kind: "group"; group: admin.Group | null }
  | { kind: "collection"; collection: admin.Collection | null }
  | {
      kind: "confirm"
      title: string
      body: ReactNode
      label: string
      run: () => Promise<unknown>
    }
  | null

const NEW_ORGANIZATION = "new"

export function OrgAdmin({
  organizations,
  initialId,
  onExit,
  onNewOrganization,
}: {
  organizations: Vault[]
  /** Organization to open first, such as one just created. */
  initialId?: string
  onExit: () => void
  onNewOrganization: () => void
}) {
  const state = admin.useOrg()
  const [orgId, setOrgId] = useState(
    organizations.find((entry) => entry.id === initialId)?.id ??
      organizations[0]!.id
  )
  const [tab, setTab] = useState<Tab>("members")
  const [dialog, setDialog] = useState<Dialogs>(null)
  const organization =
    organizations.find((entry) => entry.id === orgId) ?? organizations[0]!

  useEffect(() => {
    void admin.load(orgId)
  }, [orgId])

  const close = () => setDialog(null)
  const act = (run: () => Promise<unknown>, done: string) =>
    void run()
      .then(() => toast(done))
      .catch((error: unknown) => toast(admin.message(error)))
  const collectionName = (id: string) =>
    state.collections.find((entry) => entry.id === id)?.name ?? "Collection"
  const groupName = (id: string) =>
    state.groups.find((entry) => entry.id === id)?.name ?? "Group"
  const accessSummary = (grants: admin.Grant[]) =>
    grants.length === 0
      ? "No collections"
      : grants.length <= 2
        ? grants
            .map(
              (grant) =>
                `${collectionName(grant.id)} (${permissionLabel(grant).toLowerCase()})`
            )
            .join(", ")
        : `${grants.length} collections`

  const awaiting = state.members.filter(
    (member) => member.status === STATUS.accepted
  ).length
  const TABS: { id: Tab; label: string; icon: ReactNode; count: number }[] = [
    {
      id: "members",
      label: "Members",
      icon: <UsersIcon className="size-4" />,
      count: state.members.length,
    },
    {
      id: "groups",
      label: "Groups",
      icon: <ShieldCheckIcon className="size-4" />,
      count: state.groups.length,
    },
    {
      id: "collections",
      label: "Collections",
      icon: <FolderIcon className="size-4" />,
      count: state.collections.length,
    },
  ]
  const addLabel =
    tab === "members"
      ? "Invite members"
      : tab === "groups"
        ? "New group"
        : "New collection"

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="shrink-0 border-b">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 pt-3 md:px-6">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to vault"
            onClick={onExit}
          >
            <ArrowLeftIcon />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-lg font-semibold tracking-[-0.015em] font-wide">
              <VaultDot color={organization.color} />
              <span className="truncate">{organization.name}</span>
            </h1>
            <p className="text-sm text-muted-foreground">Organization admin</p>
          </div>
          <select
            aria-label="Organization"
            value={orgId}
            onChange={(e) =>
              e.target.value === NEW_ORGANIZATION
                ? onNewOrganization()
                : setOrgId(e.target.value)
            }
            className={cn(selectClass, "h-9 max-w-48")}
          >
            {organizations.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
            <option value={NEW_ORGANIZATION}>New organization…</option>
          </select>
        </div>
        <div className="mx-auto flex max-w-3xl items-end justify-between gap-3 px-4 md:px-6">
          <nav aria-label="Organization admin" className="flex gap-1">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-current={tab === entry.id ? "page" : undefined}
                // Members accept invitations elsewhere: show the latest.
                onClick={() => (setTab(entry.id), void admin.reload())}
                className={cn(
                  "flex h-10 items-center gap-2 border-b-2 px-2.5 text-sm transition-colors",
                  tab === entry.id
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {entry.icon}
                {entry.label}
                <span className="font-mono text-[0.7rem] text-muted-foreground tabular-nums">
                  {entry.count}
                </span>
              </button>
            ))}
          </nav>
          <Button
            size="sm"
            className="mb-1.5"
            onClick={() =>
              setDialog(
                tab === "members"
                  ? { kind: "invite" }
                  : tab === "groups"
                    ? { kind: "group", group: null }
                    : { kind: "collection", collection: null }
              )
            }
          >
            <PlusIcon />
            <span className="hidden sm:inline">{addLabel}</span>
          </Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 md:px-6">
          <ErrorLine text={state.error} />
          {tab === "members" && awaiting > 0 ? (
            <p className="rounded-md border border-primary/30 bg-brand-soft px-3 py-2 text-sm">
              {awaiting === 1
                ? "1 person accepted and is waiting for you to confirm them."
                : `${awaiting} people accepted and are waiting for you to confirm them.`}
            </p>
          ) : null}
          {state.loading ? (
            <div className="flex justify-center p-10">
              <Spinner />
            </div>
          ) : tab === "members" ? (
            <ul className="divide-y overflow-hidden rounded-md border bg-card">
              {state.members.map((member) => (
                <Row
                  key={member.id}
                  title={memberName(member)}
                  badges={
                    <>
                      <Badge variant="outline">
                        {ROLE_LABELS[member.role]}
                      </Badge>
                      {member.status === STATUS.invited ? (
                        <Badge variant="secondary">Invited</Badge>
                      ) : member.status === STATUS.accepted ? (
                        <Badge variant="secondary" className="text-warning">
                          Needs confirmation
                        </Badge>
                      ) : null}
                      {member.twoFactor ? (
                        <Badge variant="secondary">2FA</Badge>
                      ) : null}
                    </>
                  }
                  detail={
                    <>
                      {member.name ? `${member.email} · ` : ""}
                      {member.role === ROLES.user
                        ? accessSummary(member.collections)
                        : "Every collection"}
                      {member.groups.length
                        ? ` · ${member.groups.map(groupName).join(", ")}`
                        : ""}
                    </>
                  }
                  action={
                    member.status === STATUS.accepted ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          act(
                            () => admin.confirm(member),
                            `Confirmed ${memberName(member)}.`
                          )
                        }
                      >
                        Confirm
                      </Button>
                    ) : null
                  }
                  menu={
                    <RowMenu label={memberName(member)}>
                      <DropdownMenuItem
                        onClick={() => setDialog({ kind: "member", member })}
                      >
                        Edit access
                      </DropdownMenuItem>
                      {member.status === STATUS.invited ? (
                        <DropdownMenuItem
                          onClick={() =>
                            act(
                              () => admin.reinvite(member),
                              `Sent ${member.email} a new invitation.`
                            )
                          }
                        >
                          Resend invitation
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() =>
                          setDialog({
                            kind: "confirm",
                            title: `Remove ${memberName(member)}?`,
                            body: `They lose access to ${organization.name} and its collections. Items they could see stay in the organization.`,
                            label: "Remove",
                            run: async () => {
                              await admin.removeMember(member)
                              toast(`Removed ${memberName(member)}.`)
                            },
                          })
                        }
                      >
                        Remove
                      </DropdownMenuItem>
                    </RowMenu>
                  }
                />
              ))}
            </ul>
          ) : tab === "groups" ? (
            state.groups.length === 0 ? (
              <Empty text="No groups yet. Groups give several members the same collections at once." />
            ) : (
              <ul className="divide-y overflow-hidden rounded-md border bg-card">
                {state.groups.map((group) => (
                  <Row
                    key={group.id}
                    title={group.name}
                    detail={`${group.members.length} ${group.members.length === 1 ? "member" : "members"} · ${accessSummary(group.collections)}`}
                    menu={
                      <RowMenu label={group.name}>
                        <DropdownMenuItem
                          onClick={() => setDialog({ kind: "group", group })}
                        >
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() =>
                            setDialog({
                              kind: "confirm",
                              title: `Delete ${group.name}?`,
                              body: "Its members keep any access they have of their own.",
                              label: "Delete",
                              run: async () => {
                                await admin.removeGroup(group)
                                toast(`Deleted ${group.name}.`)
                              },
                            })
                          }
                        >
                          Delete
                        </DropdownMenuItem>
                      </RowMenu>
                    }
                  />
                ))}
              </ul>
            )
          ) : state.collections.length === 0 ? (
            <Empty text="No collections yet. Collections hold the organization's shared items." />
          ) : (
            <ul className="divide-y overflow-hidden rounded-md border bg-card">
              {state.collections.map((collection) => (
                <Row
                  key={collection.id}
                  title={collection.name}
                  detail={[
                    collection.groups.length
                      ? collection.groups
                          .map((grant) => groupName(grant.id))
                          .join(", ")
                      : null,
                    `${collection.members.length} ${collection.members.length === 1 ? "member" : "members"}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  menu={
                    <RowMenu label={collection.name}>
                      <DropdownMenuItem
                        onClick={() =>
                          setDialog({ kind: "collection", collection })
                        }
                      >
                        Edit access
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() =>
                          setDialog({
                            kind: "confirm",
                            title: `Delete ${collection.name}?`,
                            body: "Only an empty collection can be deleted. Move or delete its items first.",
                            label: "Delete",
                            run: async () => {
                              await admin.removeCollection(collection)
                              toast(`Deleted ${collection.name}.`)
                            },
                          })
                        }
                      >
                        Delete
                      </DropdownMenuItem>
                    </RowMenu>
                  }
                />
              ))}
            </ul>
          )}
        </div>
      </main>
      {dialog?.kind === "invite" && <InviteDialog onClose={close} />}
      {dialog?.kind === "member" && (
        <MemberDialog member={dialog.member} onClose={close} />
      )}
      {dialog?.kind === "group" && (
        <GroupDialog group={dialog.group} onClose={close} />
      )}
      {dialog?.kind === "collection" && (
        <CollectionDialog collection={dialog.collection} onClose={close} />
      )}
      {dialog?.kind === "confirm" && (
        <ConfirmDialog
          title={dialog.title}
          body={dialog.body}
          confirmLabel={dialog.label}
          onConfirm={dialog.run}
          onClose={close}
        />
      )}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
      {text}
    </p>
  )
}
