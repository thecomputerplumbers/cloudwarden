"use client"

import { Button } from "@workspace/ui/components/button"
import { formatRelativeTime } from "@workspace/ui-data/lib/format"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Spinner } from "@workspace/ui/components/spinner"
import { cn } from "@workspace/ui/lib/utils"
import {
  ArrowLeftIcon,
  BotIcon,
  FolderKanbanIcon,
  KeyRoundIcon,
  LayersIcon,
  MenuIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import * as secrets from "../../sm-store.ts"
import type { Vault } from "../../store.ts"
import { VaultDot, Wordmark } from "../brand.tsx"
import { ConfirmDialog, NameDialog, SecretEditor } from "./dialogs.tsx"
import { EmptyDetail, MachineAccountDetail, SecretDetail } from "./details.tsx"

type View = { kind: "secrets"; projectId: string | null } | { kind: "machines" }

function SectionTitle({
  title,
  action,
}: {
  title: string
  action?: ReactNode
}) {
  return (
    <div className="flex h-7 items-center justify-between px-3">
      <h3 className="label-caps text-muted-foreground/80">{title}</h3>
      {action}
    </div>
  )
}

function NavRow({
  active,
  onClick,
  icon,
  label,
  count,
  menu,
}: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  label: string
  count?: number
  menu?: ReactNode
}) {
  return (
    <div
      className={cn(
        "group/row relative flex h-8 items-center rounded-md text-[0.84rem] text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/70",
        active &&
          "bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-primary"
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <span
          className={cn(
            "flex size-4 items-center justify-center text-muted-foreground",
            active && "text-primary"
          )}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
      {/* The menu fades in over the count, but stays focusable and in the accessibility tree. */}
      <span className="relative flex w-9 shrink-0 items-center justify-center">
        {count !== undefined && (
          <span
            className={cn(
              "font-mono text-[0.7rem] text-muted-foreground tabular-nums transition-opacity",
              menu &&
                "group-focus-within/row:opacity-0 group-hover/row:opacity-0"
            )}
          >
            {count}
          </span>
        )}
        {menu && (
          <span
            className={cn(
              "flex items-center justify-center",
              count !== undefined &&
                "absolute inset-0 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100"
            )}
          >
            {menu}
          </span>
        )}
      </span>
    </div>
  )
}

export function SecretsApp({
  organizations,
  onExit,
}: {
  organizations: Vault[]
  onExit: () => void
}) {
  const sm = secrets.useSecrets()
  const [orgId, setOrgId] = useState(organizations[0]!.id)
  const [view, setView] = useState<View>({ kind: "secrets", projectId: null })
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [pane, setPane] = useState<"nav" | "list" | "detail">("list")
  const [dialog, setDialog] = useState<
    | "secret"
    | "project"
    | "machine"
    | { renameProject: string }
    | { deleteProject: string }
    | null
  >(null)
  const organization =
    organizations.find((entry) => entry.id === orgId) ?? organizations[0]!

  useEffect(() => {
    void secrets.load(orgId)
  }, [orgId])

  const go = (next: View) => {
    setView(next)
    setSelected(null)
    setPane("list")
  }
  const select = (id: string) => (setSelected(id), setPane("detail"))
  const projectName = (id: string) =>
    sm.projects.find((project) => project.id === id)?.name ?? "Project"
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)

  const secretRows = sm.secrets.filter(
    (secret) =>
      (view.kind !== "secrets" ||
        !view.projectId ||
        secret.projectId === view.projectId) &&
      terms.every((term) =>
        `${secret.key} ${projectName(secret.projectId)} ${secret.note ?? ""}`
          .toLowerCase()
          .includes(term)
      )
  )
  const machineRows = sm.machineAccounts.filter((account) =>
    terms.every((term) => account.name.toLowerCase().includes(term))
  )
  const selectedSecret =
    view.kind === "secrets"
      ? sm.secrets.find((secret) => secret.id === selected)
      : undefined
  const selectedMachine =
    view.kind === "machines"
      ? sm.machineAccounts.find((account) => account.id === selected)
      : undefined
  const title =
    view.kind === "machines"
      ? "Machine accounts"
      : view.projectId
        ? projectName(view.projectId)
        : "All secrets"
  const renaming =
    dialog && typeof dialog === "object" && "renameProject" in dialog
      ? sm.projects.find((p) => p.id === dialog.renameProject)
      : undefined
  const deleting =
    dialog && typeof dialog === "object" && "deleteProject" in dialog
      ? sm.projects.find((p) => p.id === dialog.deleteProject)
      : undefined

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <nav
        aria-label="Secrets Manager"
        className={cn(
          "w-full shrink-0 flex-col border-r bg-sidebar md:flex md:w-64",
          pane === "nav" ? "flex" : "hidden"
        )}
      >
        <div className="flex h-14 shrink-0 items-center px-4">
          <Wordmark className="text-[0.95rem]" />
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2 pb-4">
          <button
            type="button"
            onClick={onExit}
            className="flex h-8 w-full items-center gap-2 rounded-md px-3 text-sm text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <ArrowLeftIcon className="size-4" /> Back to vault
          </button>

          <section className="space-y-1">
            <SectionTitle title="Organization" />
            {organizations.length > 1 ? (
              <div className="px-1">
                <label className="relative block">
                  <span className="sr-only">Organization</span>
                  <VaultDot
                    color={organization.color}
                    className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
                  />
                  <select
                    value={orgId}
                    onChange={(event) => {
                      setOrgId(event.target.value)
                      go({ kind: "secrets", projectId: null })
                    }}
                    className="h-9 w-full rounded-md border bg-background pr-3 pl-7 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                  >
                    {organizations.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : (
              <p className="flex h-8 items-center gap-2.5 px-3 text-sm">
                <VaultDot color={organization.color} />
                {organization.name}
              </p>
            )}
          </section>

          <section className="space-y-0.5">
            <SectionTitle title="Secrets" />
            <NavRow
              active={view.kind === "secrets" && !view.projectId}
              onClick={() => go({ kind: "secrets", projectId: null })}
              icon={<LayersIcon className="size-4" />}
              label="All secrets"
              count={sm.secrets.length}
            />
            <NavRow
              active={view.kind === "machines"}
              onClick={() => go({ kind: "machines" })}
              icon={<BotIcon className="size-4" />}
              label="Machine accounts"
              count={sm.machineAccounts.length}
            />
          </section>

          <section className="space-y-0.5">
            <SectionTitle
              title="Projects"
              action={
                <button
                  type="button"
                  aria-label="New project"
                  title="New project"
                  onClick={() => setDialog("project")}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <PlusIcon className="size-3.5" />
                </button>
              }
            />
            {sm.projects.map((project) => (
              <NavRow
                key={project.id}
                active={
                  view.kind === "secrets" && view.projectId === project.id
                }
                onClick={() => go({ kind: "secrets", projectId: project.id })}
                icon={<FolderKanbanIcon className="size-4" />}
                label={project.name}
                count={
                  sm.secrets.filter((secret) => secret.projectId === project.id)
                    .length
                }
                menu={
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <button
                          type="button"
                          aria-label={`${project.name} options`}
                          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                        />
                      }
                    >
                      <MoreHorizontalIcon className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-36">
                      <DropdownMenuItem
                        onClick={() => setDialog({ renameProject: project.id })}
                      >
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setDialog({ deleteProject: project.id })}
                        className="text-destructive"
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
              />
            ))}
            {!sm.projects.length && !sm.loading && (
              <p className="px-3 py-1 text-xs text-muted-foreground">
                Projects group the secrets a machine can be given.
              </p>
            )}
          </section>
        </div>
      </nav>

      <section
        aria-label={title}
        className={cn(
          "w-full shrink-0 flex-col border-r bg-surface-1 md:flex md:w-[22rem]",
          pane === "list" ? "flex" : "hidden"
        )}
      >
        <header className="shrink-0 space-y-3 p-3 pb-2">
          <div className="flex h-8 items-center justify-between gap-2 px-1">
            <h2 className="truncate text-sm font-semibold">
              {title}{" "}
              <span className="font-normal text-muted-foreground tabular-nums">
                {view.kind === "machines"
                  ? machineRows.length
                  : secretRows.length}
              </span>
            </h2>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Menu"
                className="md:hidden"
                onClick={() => setPane("nav")}
              >
                <MenuIcon />
              </Button>
              {view.kind === "machines" ? (
                <Button size="sm" onClick={() => setDialog("machine")}>
                  <PlusIcon /> New
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={!sm.projects.length}
                  title={
                    sm.projects.length ? undefined : "Create a project first"
                  }
                  onClick={() => setDialog("secret")}
                >
                  <PlusIcon /> New
                </Button>
              )}
            </div>
          </div>
          <label className="flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
            <SearchIcon className="size-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("")
              }}
              placeholder={
                view.kind === "machines"
                  ? "Search machine accounts"
                  : "Search secrets"
              }
              aria-label={
                view.kind === "machines"
                  ? "Search machine accounts"
                  : "Search secrets"
              }
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </label>
        </header>
        <ul
          aria-label={`${title} list`}
          className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3"
        >
          {sm.loading && (
            <li className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Spinner /> Decrypting
            </li>
          )}
          {sm.error && (
            <li
              role="alert"
              className="m-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {sm.error}
            </li>
          )}
          {!sm.loading &&
            view.kind === "secrets" &&
            secretRows.map((secret) => (
              <li key={secret.id}>
                <button
                  type="button"
                  aria-current={secret.id === selected ? "true" : undefined}
                  onClick={() => select(secret.id)}
                  className={cn(
                    "relative flex h-12 w-full items-center gap-3 rounded-md px-2.5 text-left transition-colors outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring",
                    secret.id === selected &&
                      "bg-accent before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-primary hover:bg-accent"
                  )}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
                    <KeyRoundIcon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[0.8rem] font-medium">
                      {secret.key}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {projectName(secret.projectId)} · edited{" "}
                      {formatRelativeTime(new Date(secret.revisionDate))}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          {!sm.loading &&
            view.kind === "machines" &&
            machineRows.map((account) => (
              <li key={account.id}>
                <button
                  type="button"
                  aria-current={account.id === selected ? "true" : undefined}
                  onClick={() => select(account.id)}
                  className={cn(
                    "relative flex h-12 w-full items-center gap-3 rounded-md px-2.5 text-left transition-colors outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring",
                    account.id === selected &&
                      "bg-accent before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:bg-primary hover:bg-accent"
                  )}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
                    <BotIcon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {account.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {account.access.length} project
                      {account.access.length === 1 ? "" : "s"} ·{" "}
                      {account.tokens.length} token
                      {account.tokens.length === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          {!sm.loading &&
            !sm.error &&
            view.kind === "secrets" &&
            !secretRows.length && (
              <li className="px-4 py-16 text-center text-sm text-muted-foreground">
                {query
                  ? "Nothing matches that search."
                  : sm.projects.length
                    ? "No secrets yet. Secrets are values machines read, like DATABASE_URL."
                    : "Create a project first: secrets live in projects."}
              </li>
            )}
          {!sm.loading &&
            !sm.error &&
            view.kind === "machines" &&
            !machineRows.length && (
              <li className="px-4 py-16 text-center text-sm text-muted-foreground">
                {query
                  ? "Nothing matches that search."
                  : "No machine accounts yet. A machine account is how a cluster or service reads secrets."}
              </li>
            )}
        </ul>
      </section>

      <div
        className={cn(
          "min-w-0 flex-1 md:block",
          pane === "detail" ? "block" : "hidden"
        )}
      >
        {selectedSecret ? (
          <SecretDetail
            key={selectedSecret.id}
            secret={selectedSecret}
            projects={sm.projects}
            onBack={() => (setSelected(null), setPane("list"))}
          />
        ) : selectedMachine ? (
          <MachineAccountDetail
            key={selectedMachine.id}
            account={selectedMachine}
            projects={sm.projects}
            secretsList={sm.secrets}
            onBack={() => (setSelected(null), setPane("list"))}
          />
        ) : (
          <EmptyDetail
            text={
              view.kind === "machines"
                ? "Choose a machine account to set its project access and make tokens."
                : "Choose a secret to see its value."
            }
          />
        )}
      </div>

      {dialog === "secret" && (
        <SecretEditor
          secret={null}
          projects={sm.projects}
          defaultProjectId={view.kind === "secrets" ? view.projectId : null}
          onSave={async (input) => select((await secrets.saveSecret(input)).id)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "project" && (
        <NameDialog
          title="New project"
          description="A project groups secrets, and machine accounts are granted access per project."
          label="Name"
          initial=""
          submitLabel="Create"
          onSave={async (name) =>
            go({
              kind: "secrets",
              projectId: (await secrets.saveProject(name)).id,
            })
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "machine" && (
        <NameDialog
          title="New machine account"
          description="A machine account is an identity for a cluster or service. Grant it projects, then give it tokens."
          label="Name"
          initial=""
          submitLabel="Create"
          onSave={async (name) =>
            select((await secrets.saveMachineAccount(name)).id)
          }
          onClose={() => setDialog(null)}
        />
      )}
      {renaming && (
        <NameDialog
          title="Rename project"
          description="Names are encrypted with the organization's key."
          label="Name"
          initial={renaming.name}
          submitLabel="Save"
          onSave={(name) => secrets.saveProject(name, renaming.id)}
          onClose={() => setDialog(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          body="Machine accounts lose their access to it. A project with secrets cannot be deleted: move or delete its secrets first."
          confirmLabel="Delete project"
          onConfirm={async () => {
            try {
              await secrets.removeProject(deleting.id)
            } catch (error) {
              throw new Error(
                error instanceof Error &&
                  "status" in error &&
                  error.status === 409
                  ? "This project still has secrets. Move or delete them first, then delete the project."
                  : secrets.message(error)
              )
            }
            if (view.kind === "secrets" && view.projectId === deleting.id)
              go({ kind: "secrets", projectId: null })
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}
