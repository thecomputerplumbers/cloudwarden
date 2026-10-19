"use client"

import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"
import { cn } from "@workspace/ui/lib/utils"
import {
  ArrowLeftIcon,
  BotIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import { useState, type ReactNode } from "react"
import * as secrets from "../../sm-store.ts"
import type { MachineAccount, Project, Secret } from "../../sm-store.ts"
import { FieldRow, Group } from "../item-detail.tsx"
import {
  ConfirmDialog,
  ErrorLine,
  NameDialog,
  SecretEditor,
} from "./dialogs.tsx"
import { TokenDialog } from "./token-dialog.tsx"

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : null

function DetailFrame({
  onBack,
  actions,
  children,
}: {
  onBack: () => void
  actions: ReactNode
  children: ReactNode
}) {
  return (
    <article className="flex h-full min-w-0 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to the list"
          onClick={onBack}
          className="md:hidden"
        >
          <ArrowLeftIcon />
        </Button>
        <div className="flex-1" />
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-5 p-6">{children}</div>
      </div>
    </article>
  )
}

function Title({
  icon,
  title,
  subtitle,
  mono = false,
}: {
  icon: ReactNode
  title: string
  subtitle: string
  /** Secret keys are identifiers, set in monospace; names are not. */
  mono?: boolean
}) {
  return (
    <div className="flex items-center gap-4">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-primary">
        {icon}
      </span>
      <div className="min-w-0">
        <h1
          className={cn(
            "truncate text-xl font-semibold tracking-tight",
            mono && "font-mono"
          )}
        >
          {title}
        </h1>
        <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  )
}

export function EmptyDetail({ text }: { text: string }) {
  return (
    <div className="hidden h-full flex-col items-center justify-center gap-2 bg-background px-6 text-center text-sm text-muted-foreground md:flex">
      <p className="font-medium text-foreground">Nothing selected</p>
      <p className="max-w-xs">{text}</p>
    </div>
  )
}

export function SecretDetail({
  secret,
  projects,
  onBack,
}: {
  secret: Secret
  projects: Project[]
  onBack: () => void
}) {
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null)
  const project = projects.find((entry) => entry.id === secret.projectId)
  return (
    <DetailFrame
      onBack={onBack}
      actions={
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete secret"
            onClick={() => setDialog("delete")}
          >
            <Trash2Icon />
          </Button>
          <Button size="sm" onClick={() => setDialog("edit")}>
            <PencilIcon /> Edit
          </Button>
        </>
      }
    >
      <Title
        icon={<KeyRoundIcon className="size-5" />}
        mono
        title={secret.key}
        subtitle={project?.name ?? "Project"}
      />
      <Group>
        <FieldRow label="Key" value={secret.key} mono />
        <FieldRow label="Value" value={secret.value} secret />
      </Group>
      {secret.note && (
        <div className="rounded-xl border bg-card p-4 shadow-panel">
          <p className="mb-1 text-xs text-muted-foreground">Note</p>
          <p className="text-sm whitespace-pre-wrap">{secret.note}</p>
        </div>
      )}
      <p className="px-1 text-xs text-muted-foreground">
        Updated {new Date(secret.revisionDate).toLocaleString()}
      </p>
      {dialog === "edit" && (
        <SecretEditor
          secret={secret}
          projects={projects}
          defaultProjectId={secret.projectId}
          onSave={(input) => secrets.saveSecret(input, secret.id)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title={`Delete ${secret.key}?`}
          body="Machines reading it will stop getting it at their next refresh. This cannot be undone."
          confirmLabel="Delete secret"
          onConfirm={async () => {
            await secrets.removeSecret(secret.id)
            onBack()
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </DetailFrame>
  )
}

type Level = "none" | "read" | "write"
const LEVELS: { level: Level; label: string }[] = [
  { level: "none", label: "No access" },
  { level: "read", label: "Read" },
  { level: "write", label: "Read & write" },
]

const levelsOf = (account: MachineAccount) =>
  Object.fromEntries(
    account.access.map((grant) => [
      grant.projectId,
      grant.write ? "write" : "read",
    ])
  ) as Record<string, Level>

export function MachineAccountDetail({
  account,
  projects,
  secretsList,
  onBack,
}: {
  account: MachineAccount
  projects: Project[]
  secretsList: Secret[]
  onBack: () => void
}) {
  const [dialog, setDialog] = useState<
    "rename" | "delete" | "token" | { revoke: string } | null
  >(null)
  const [levels, setLevels] = useState<Record<string, Level>>(() =>
    levelsOf(account)
  )
  const [saving, setSaving] = useState(false)
  // Captured once per account shown: whether a token has expired does not need to tick.
  const [now] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)
  const saved = levelsOf(account)
  const dirty = projects.some(
    (project) =>
      (levels[project.id] ?? "none") !== (saved[project.id] ?? "none")
  )
  const revoking =
    typeof dialog === "object" && dialog
      ? account.tokens.find((token) => token.id === dialog.revoke)
      : undefined

  async function saveAccess() {
    setSaving(true)
    setError(null)
    try {
      const grants = projects
        .filter((project) => (levels[project.id] ?? "none") !== "none")
        .map((project) => ({
          projectId: project.id,
          write: levels[project.id] === "write",
        }))
      await secrets.saveGrants(account.id, grants)
    } catch (failure) {
      setError(secrets.message(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <DetailFrame
      onBack={onBack}
      actions={
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete machine account"
            onClick={() => setDialog("delete")}
          >
            <Trash2Icon />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDialog("rename")}
          >
            <PencilIcon /> Rename
          </Button>
        </>
      }
    >
      <Title
        icon={<BotIcon className="size-5" />}
        title={account.name}
        subtitle={`${account.access.length} project${account.access.length === 1 ? "" : "s"} · ${account.tokens.length} token${account.tokens.length === 1 ? "" : "s"}`}
      />

      <section className="space-y-2">
        <div className="flex items-end justify-between gap-3 px-1">
          <div>
            <h2 className="text-sm font-semibold">Project access</h2>
            <p className="text-xs text-muted-foreground">
              What this machine's tokens can read, and write.
            </p>
          </div>
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void saveAccess()}
          >
            {saving ? <Spinner /> : null}
            Save access
          </Button>
        </div>
        <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-panel">
          {projects.map((project) => {
            const level = levels[project.id] ?? "none"
            return (
              <div
                key={project.id}
                className="flex flex-wrap items-center gap-3 px-4 py-2.5"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  {project.name}
                  <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                    {
                      secretsList.filter(
                        (secret) => secret.projectId === project.id
                      ).length
                    }{" "}
                    secrets
                  </span>
                </span>
                <div
                  role="radiogroup"
                  aria-label={`Access to ${project.name}`}
                  className="flex rounded-lg border bg-surface-1 p-0.5"
                >
                  {LEVELS.map((option) => (
                    <button
                      key={option.level}
                      type="button"
                      role="radio"
                      aria-checked={level === option.level}
                      onClick={() =>
                        setLevels({ ...levels, [project.id]: option.level })
                      }
                      className={cn(
                        "h-7 rounded-md px-2.5 text-xs whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        level === option.level
                          ? "bg-background font-medium text-foreground shadow-panel"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
          {!projects.length && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              Create a project first; access is granted per project.
            </p>
          )}
        </div>
        <ErrorLine text={error} />
      </section>

      <section className="space-y-2">
        <div className="flex items-end justify-between gap-3 px-1">
          <div>
            <h2 className="text-sm font-semibold">Access tokens</h2>
            <p className="text-xs text-muted-foreground">
              Each token is shown once, when it is made.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDialog("token")}
          >
            <PlusIcon /> New access token
          </Button>
        </div>
        <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-panel">
          {account.tokens.map((token) => {
            const expired =
              token.expiresAt && new Date(token.expiresAt).getTime() < now
            return (
              <div
                key={token.id}
                className="flex items-center gap-3 px-4 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{token.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    Created {when(token.creationDate)} ·{" "}
                    {token.lastUsedDate
                      ? `last used ${when(token.lastUsedDate)}`
                      : "never used"}{" "}
                    ·{" "}
                    <span className={cn(expired && "text-destructive")}>
                      {token.expiresAt
                        ? `${expired ? "expired" : "expires"} ${when(token.expiresAt)}`
                        : "no expiry"}
                    </span>
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDialog({ revoke: token.id })}
                >
                  Revoke
                </Button>
              </div>
            )
          })}
          {!account.tokens.length && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No tokens yet. Make one for each place this machine runs.
            </p>
          )}
        </div>
      </section>

      {dialog === "rename" && (
        <NameDialog
          title="Rename machine account"
          description="Names are encrypted with the organization's key."
          label="Name"
          initial={account.name}
          submitLabel="Save"
          onSave={(name) => secrets.saveMachineAccount(name, account.id)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title={`Delete ${account.name}?`}
          body="Its access and every one of its tokens go with it; machines using them stop at their next refresh."
          confirmLabel="Delete machine account"
          onConfirm={async () => {
            await secrets.removeMachineAccount(account.id)
            onBack()
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "token" && (
        <TokenDialog
          account={account}
          secrets={secretsList}
          onClose={() => setDialog(null)}
        />
      )}
      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          body="It stops working immediately. Machines using it need a new token."
          confirmLabel="Revoke token"
          onConfirm={() => secrets.revokeAccessToken(account.id, revoking.id)}
          onClose={() => setDialog(null)}
        />
      )}
    </DetailFrame>
  )
}
