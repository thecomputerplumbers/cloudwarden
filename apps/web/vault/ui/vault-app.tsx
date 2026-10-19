"use client"

import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { Spinner } from "@workspace/ui/components/spinner"
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
import { useEffect, useMemo, useState } from "react"
import type { ItemKind, VaultItem } from "../crypto/cipher.ts"
import { visibleItems, type ItemFilter } from "../filter.ts"
import * as vault from "../store.ts"
import { SignIn, Unlock } from "./auth.tsx"
import { BrandMark } from "./brand.tsx"
import { ItemDetail } from "./item-detail.tsx"
import { ItemEditor, KIND_LABELS } from "./item-editor.tsx"
import { ItemList } from "./item-list.tsx"
import { Sidebar } from "./sidebar.tsx"
import { Toaster } from "./toast.tsx"

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

function Unlocked() {
  const state = vault.useVault()
  const [filter, setFilter] = useState<ItemFilter>({ view: "all", query: "" })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{
    item: VaultItem | null
    kind: ItemKind
  } | null>(null)
  const [pane, setPane] = useState<"nav" | "list" | "detail">("list")
  useIdleLock(true)

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

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <div
        className={cn(
          "w-full shrink-0 border-r md:block md:w-64",
          pane === "nav" ? "block" : "hidden"
        )}
      >
        <Sidebar
          filter={filter}
          onFilter={(next) => (setFilter(next), setPane("list"))}
        />
      </div>
      <div
        className={cn(
          "w-full shrink-0 md:block md:w-[22rem]",
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
          actions={
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
      )}
      {state.error && (
        <div
          role="alert"
          className="fixed top-3 left-1/2 z-40 -translate-x-1/2 rounded-full border border-destructive/30 bg-background px-4 py-1.5 text-sm text-destructive shadow-lift"
        >
          {state.error}
        </div>
      )}
    </div>
  )
}

export function VaultApp() {
  const state = vault.useVault()
  useEffect(() => vault.restore(), [])
  return (
    <>
      {state.status === "unlocked" ? (
        <Unlocked />
      ) : state.status === "locked" ? (
        <Unlock />
      ) : state.status === "loading" && state.items.length === 0 ? (
        <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-background">
          <BrandMark className="size-10 animate-pulse" />
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Decrypting your vault
          </p>
        </div>
      ) : (
        <SignIn />
      )}
      <Toaster />
    </>
  )
}
