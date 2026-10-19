"use client"

import { Checkbox } from "@workspace/ui/components/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { cn } from "@workspace/ui/lib/utils"
import {
  ChevronsUpDownIcon,
  CreditCardIcon,
  FolderIcon,
  IdCardIcon,
  KeyRoundIcon,
  LayersIcon,
  LockIcon,
  LogOutIcon,
  RefreshCwIcon,
  ServerCogIcon,
  SettingsIcon,
  StarIcon,
  StickyNoteIcon,
  TerminalSquareIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react"
import type { ReactNode } from "react"
import { onlyVault, toggleVault, vaultOf, type ItemFilter } from "../filter.ts"
import * as vault from "../store.ts"
import { Wordmark, VaultDot } from "./brand.tsx"

const VIEWS: {
  view: ItemFilter["view"]
  label: string
  icon: typeof KeyRoundIcon
}[] = [
  { view: "all", label: "All items", icon: LayersIcon },
  { view: "favorites", label: "Favorites", icon: StarIcon },
  { view: "login", label: "Logins", icon: KeyRoundIcon },
  { view: "card", label: "Cards", icon: CreditCardIcon },
  { view: "identity", label: "Identities", icon: IdCardIcon },
  { view: "note", label: "Secure notes", icon: StickyNoteIcon },
  { view: "sshKey", label: "SSH keys", icon: TerminalSquareIcon },
]

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-0.5">
      <div className="flex h-7 items-center justify-between px-2.5">
        <h3 className="label-caps text-muted-foreground/80">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function Row({
  active,
  onClick,
  icon,
  label,
  count,
  className,
}: {
  active?: boolean
  onClick: () => void
  icon: ReactNode
  label: string
  count?: number
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[0.84rem] text-sidebar-foreground/80 transition-colors outline-none hover:bg-sidebar-accent/70 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        active &&
          "bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-primary hover:bg-sidebar-accent",
        className
      )}
    >
      <span className="flex size-4 items-center justify-center text-muted-foreground group-aria-[current=page]:text-primary">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="font-mono text-[0.7rem] text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
    </button>
  )
}

export function Sidebar({
  filter,
  onFilter,
  onSecrets,
  onSettings,
}: {
  filter: ItemFilter
  onFilter: (filter: ItemFilter) => void
  onSettings: () => void
  /** Opens Secrets Manager; absent when the account administers no organization. */
  onSecrets?: () => void
}) {
  const state = vault.useVault()
  const ids = state.vaults.map((entry) => entry.id)
  const selected = ids.filter((id) => !state.excluded.has(id))
  const live = state.items.filter((item) => !item.deleted)
  const inSelection = live.filter((item) => !state.excluded.has(vaultOf(item)))
  const countIn = (vaultId: string) =>
    live.filter((item) => vaultOf(item) === vaultId).length
  const go = (patch: Partial<ItemFilter>) =>
    onFilter({ view: "all", query: filter.query, ...patch })
  const collections = state.collections.filter(
    (collection) => !state.excluded.has(collection.vaultId)
  )
  const vaultColor = (vaultId: string) =>
    state.vaults.find((entry) => entry.id === vaultId)?.color ?? 1
  const isPlain =
    filter.folderId === undefined && filter.collectionId === undefined

  return (
    <nav aria-label="Vault" className="flex h-full flex-col bg-sidebar">
      <div className="flex h-14 shrink-0 items-center px-4">
        <Wordmark className="text-[0.95rem]" />
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 pb-4">
        <Section
          title={
            selected.length === ids.length
              ? "All vaults"
              : `${selected.length} of ${ids.length} vaults`
          }
          action={
            selected.length !== ids.length ? (
              <button
                type="button"
                onClick={() => vault.setExcluded(new Set())}
                className="text-xs text-primary hover:underline"
              >
                Show all
              </button>
            ) : null
          }
        >
          {state.vaults.map((entry) => {
            const on = !state.excluded.has(entry.id)
            return (
              <div
                key={entry.id}
                className="group/vault flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[0.84rem] text-sidebar-foreground/80 hover:bg-sidebar-accent/70"
              >
                <Checkbox
                  checked={on}
                  onCheckedChange={() =>
                    vault.setExcluded(
                      toggleVault(state.excluded, ids, entry.id)
                    )
                  }
                  aria-label={`Show ${entry.name}`}
                  disabled={on && selected.length === 1}
                />
                <VaultDot color={entry.color} />
                <button
                  type="button"
                  className={cn(
                    "min-w-0 flex-1 truncate text-left",
                    !on && "text-muted-foreground"
                  )}
                  onClick={() =>
                    vault.setExcluded(
                      toggleVault(state.excluded, ids, entry.id)
                    )
                  }
                >
                  {entry.name}
                  {!entry.readable && (
                    <span className="ml-1 text-xs text-destructive">
                      · locked
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => vault.setExcluded(onlyVault(ids, entry.id))}
                  className="hidden text-xs text-primary group-hover/vault:inline hover:underline"
                  title={`Show only ${entry.name}`}
                >
                  Only
                </button>
                <span className="font-mono text-[0.7rem] text-muted-foreground tabular-nums group-hover/vault:hidden">
                  {countIn(entry.id)}
                </span>
              </div>
            )
          })}
        </Section>

        <Section title="Library">
          {VIEWS.map(({ view, label, icon: Icon }) => (
            <Row
              key={view}
              active={filter.view === view && isPlain}
              onClick={() => go({ view })}
              icon={<Icon className="size-4" />}
              label={label}
              count={
                view === "all"
                  ? inSelection.length
                  : view === "favorites"
                    ? inSelection.filter((item) => item.favorite).length
                    : inSelection.filter((item) => item.kind === view).length
              }
            />
          ))}
        </Section>

        {state.folders.length > 0 && !state.excluded.has(vault.PERSONAL) && (
          <Section title="Folders">
            {state.folders.map((folder) => (
              <Row
                key={folder.id}
                active={filter.folderId === folder.id}
                onClick={() => go({ folderId: folder.id })}
                icon={<FolderIcon className="size-4" />}
                label={folder.name}
                count={
                  inSelection.filter((item) => item.folderId === folder.id)
                    .length
                }
              />
            ))}
          </Section>
        )}

        {collections.length > 0 && (
          <Section title="Collections">
            {collections.map((collection) => (
              <Row
                key={collection.id}
                active={filter.collectionId === collection.id}
                onClick={() => go({ collectionId: collection.id })}
                icon={
                  <span className="relative">
                    <UsersIcon className="size-4" />
                    <VaultDot
                      color={vaultColor(collection.vaultId)}
                      className="absolute -right-0.5 -bottom-0.5 size-1.5 ring-1 ring-sidebar"
                    />
                  </span>
                }
                label={collection.name}
                count={
                  inSelection.filter((item) =>
                    item.collectionIds.includes(collection.id)
                  ).length
                }
              />
            ))}
          </Section>
        )}

        <Section title="Other">
          <Row
            active={filter.view === "trash"}
            onClick={() => go({ view: "trash" })}
            icon={<Trash2Icon className="size-4" />}
            label="Trash"
            count={
              state.items.filter(
                (item) => item.deleted && !state.excluded.has(vaultOf(item))
              ).length
            }
          />
          {onSecrets && (
            <Row
              onClick={onSecrets}
              icon={<ServerCogIcon className="size-4" />}
              label="Secrets Manager"
            />
          )}
        </Section>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-sidebar-border p-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md p-1.5 text-left transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              />
            }
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground text-xs font-semibold text-background uppercase">
              {(state.name || state.email || "?").slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {state.name || "Account"}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {state.email}
              </span>
            </span>
            <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-60">
            <DropdownMenuItem onClick={onSettings}>
              <SettingsIcon /> Account settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => vault.resync()}>
              <RefreshCwIcon className={cn(state.syncing && "animate-spin")} />
              Sync now
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => vault.lock()}>
              <LockIcon /> Lock
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => vault.signOut()}
            >
              <LogOutIcon /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <IconButton label="Lock" onClick={() => vault.lock()}>
          <LockIcon className="size-4" />
        </IconButton>
      </div>
    </nav>
  )
}

export function IconButton({
  label,
  onClick,
  children,
  className,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      {children}
    </button>
  )
}
