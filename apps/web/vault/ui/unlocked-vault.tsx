"use client"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { cn } from "@workspace/ui/lib/utils"
import {
  CreditCardIcon,
  IdCardIcon,
  KeyRoundIcon,
  MenuIcon,
  PlusIcon,
  StickyNoteIcon,
  TerminalSquareIcon,
} from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import type { ItemKind, VaultItem } from "../crypto/cipher.ts"
import { visibleItems, type ItemFilter } from "../filter.ts"
import * as vault from "../store.ts"
import { ItemDetail } from "./item-detail.tsx"
import { KIND_LABELS } from "./item-kinds.ts"
import { ItemList } from "./item-list.tsx"
import { NewOrganizationDialog } from "./new-organization.tsx"
import { Sidebar } from "./sidebar.tsx"
import { VaultLoading } from "./vault-loading.tsx"

const ItemEditor = lazy(() =>
  import("./item-editor.tsx").then(({ ItemEditor }) => ({
    default: ItemEditor,
  }))
)
const AccountSettings = lazy(() =>
  import("./account-settings.tsx").then(({ AccountSettings }) => ({
    default: AccountSettings,
  }))
)
const Sends = lazy(() =>
  import("./sends.tsx").then(({ Sends }) => ({ default: Sends }))
)
const OrgAdmin = lazy(() =>
  import("./org-admin.tsx").then(({ OrgAdmin }) => ({ default: OrgAdmin }))
)
const SecretsApp = lazy(() =>
  import("./secrets/secrets-app.tsx").then(({ SecretsApp }) => ({
    default: SecretsApp,
  }))
)

const NEW_KINDS: { kind: ItemKind; icon: typeof KeyRoundIcon }[] = [
  { kind: "login", icon: KeyRoundIcon },
  { kind: "card", icon: CreditCardIcon },
  { kind: "identity", icon: IdCardIcon },
  { kind: "note", icon: StickyNoteIcon },
  { kind: "sshKey", icon: TerminalSquareIcon },
]

const VIEW_TITLES: Record<ItemFilter["view"], string> = {
  all: "All items",
  favorites: "Favorites",
  login: "Logins",
  card: "Cards",
  identity: "Identities",
  note: "Secure notes",
  sshKey: "SSH keys",
  trash: "Trash",
}

/** Locks the vault after this long without input. */
const IDLE_LOCK_MS = 15 * 60_000

function useIdleLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    let timer = setTimeout(vault.lock, IDLE_LOCK_MS)
    const reset = () => (
      clearTimeout(timer),
      (timer = setTimeout(vault.lock, IDLE_LOCK_MS))
    )
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const
    for (const event of events)
      window.addEventListener(event, reset, { passive: true })
    return () => {
      clearTimeout(timer)
      for (const event of events) window.removeEventListener(event, reset)
    }
  }, [active])
}

export function Unlocked() {
  const state = vault.useVault()
  const [filter, setFilter] = useState<ItemFilter>({ view: "all", query: "" })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{
    item: VaultItem | null
    kind: ItemKind
  } | null>(null)
  const [pane, setPane] = useState<"nav" | "list" | "detail">("list")
  const [area, setArea] = useState<
    "vault" | "secrets" | "admin" | "settings" | "sends"
  >("vault")
  const [creatingOrg, setCreatingOrg] = useState(false)
  const [openOrgId, setOpenOrgId] = useState<string | undefined>()
  useIdleLock(true)
  // Secrets Manager is for organization owners and admins whose key unwrapped.
  const adminOrgs = state.vaults.filter(
    (entry) => entry.admin && entry.readable
  )

  const items = useMemo(
    () => visibleItems(state.items, state.excluded, filter),
    [state.items, state.excluded, filter]
  )
  const selected = state.items.find((item) => item.id === selectedId) ?? null
  const folder = state.folders.find((entry) => entry.id === filter.folderId)
  const collection = state.collections.find(
    (entry) => entry.id === filter.collectionId
  )
  const title = folder?.name ?? collection?.name ?? VIEW_TITLES[filter.view]
  const defaultVault =
    state.vaults.find(
      (entry) => !state.excluded.has(entry.id) && entry.readable
    )?.id ?? vault.PERSONAL

  const select = (id: string) => (setSelectedId(id), setPane("detail"))
  const newOrgDialog = creatingOrg ? (
    <NewOrganizationDialog
      onClose={() => setCreatingOrg(false)}
      onCreated={(id) => (
        setCreatingOrg(false),
        setOpenOrgId(id),
        setArea("admin")
      )}
    />
  ) : null

  if (area === "settings")
    return (
      <Suspense fallback={<VaultLoading message="Opening settings" />}>
        <AccountSettings onExit={() => setArea("vault")} />
      </Suspense>
    )
  if (area === "sends")
    return (
      <Suspense fallback={<VaultLoading message="Opening Send" />}>
        <Sends onExit={() => setArea("vault")} />
      </Suspense>
    )
  if (area === "admin" && adminOrgs.length)
    return (
      <Suspense
        fallback={<VaultLoading message="Opening organization admin" />}
      >
        <OrgAdmin
          key={openOrgId}
          organizations={adminOrgs}
          initialId={openOrgId}
          onExit={() => setArea("vault")}
          onNewOrganization={() => setCreatingOrg(true)}
        />
        {newOrgDialog}
      </Suspense>
    )
  if (area === "secrets" && adminOrgs.length)
    return (
      <Suspense fallback={<VaultLoading message="Opening Secrets Manager" />}>
        <SecretsApp organizations={adminOrgs} onExit={() => setArea("vault")} />
      </Suspense>
    )

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <div
        className={cn(
          "w-full shrink-0 border-r border-sidebar-border md:block md:w-60",
          pane === "nav" ? "block" : "hidden"
        )}
      >
        <Sidebar
          filter={filter}
          onFilter={(next) => (setFilter(next), setPane("list"))}
          onSettings={() => setArea("settings")}
          onSends={() => setArea("sends")}
          onNewOrganization={() => setCreatingOrg(true)}
          {...(adminOrgs.length
            ? {
                onSecrets: () => setArea("secrets"),
                onAdmin: () => setArea("admin"),
              }
            : {})}
        />
      </div>
      <div
        className={cn(
          "w-full shrink-0 md:block md:w-[21rem]",
          pane === "list" ? "block" : "hidden"
        )}
      >
        <ItemList
          title={title}
          items={items}
          vaults={state.vaults}
          query={filter.query}
          onQuery={(query) => setFilter({ ...filter, query })}
          selectedId={selectedId}
          onSelect={select}
          leading={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Menu"
              className="-ml-1.5 md:hidden"
              onClick={() => setPane("nav")}
            >
              <MenuIcon />
            </Button>
          }
          actions={
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="sm" />}>
                  <PlusIcon /> New
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  {NEW_KINDS.map(({ kind, icon: Icon }) => (
                    <DropdownMenuItem
                      key={kind}
                      onClick={() => setEditor({ item: null, kind })}
                    >
                      <Icon /> {KIND_LABELS[kind]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          }
        />
      </div>
      <div
        className={cn(
          "min-w-0 flex-1 md:block",
          pane === "detail" ? "block" : "hidden"
        )}
      >
        <ItemDetail
          item={selected}
          onEdit={(item) =>
            setEditor({
              item,
              kind: item.kind === "unknown" ? "note" : item.kind,
            })
          }
          onBack={() => setPane("list")}
        />
      </div>
      {editor && (
        <Suspense
          fallback={
            <p
              role="status"
              className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md bg-background px-4 py-2 shadow-panel"
            >
              Opening item…
            </p>
          }
        >
          <ItemEditor
            key={editor.item?.id ?? `new-${editor.kind}`}
            open
            item={editor.item}
            kind={editor.kind}
            vaultId={defaultVault}
            onClose={() => setEditor(null)}
            onSaved={(item) => (
              setEditor(null),
              setSelectedId(item.id),
              setPane("detail")
            )}
          />
        </Suspense>
      )}
      {state.error && (
        <div
          role="alert"
          className="fixed top-3 left-1/2 z-40 -translate-x-1/2 rounded-full border border-destructive/30 bg-background px-4 py-1.5 text-sm text-destructive shadow-lift"
        >
          {state.error}
        </div>
      )}
      {newOrgDialog}
    </div>
  )
}
