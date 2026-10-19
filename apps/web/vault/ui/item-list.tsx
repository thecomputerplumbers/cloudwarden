"use client"

import { cn } from "@workspace/ui/lib/utils"
import { SearchIcon, StarIcon } from "lucide-react"
import { useEffect, useRef, type ReactNode } from "react"
import type { VaultItem } from "../crypto/cipher.ts"
import { vaultOf } from "../filter.ts"
import type { Vault } from "../store.ts"
import { VaultDot } from "./brand.tsx"
import { ItemIcon, subtitleOf } from "./item-icon.tsx"

export function ItemList({
  title,
  items,
  vaults,
  query,
  onQuery,
  selectedId,
  onSelect,
  actions,
}: {
  title: string
  items: VaultItem[]
  vaults: Vault[]
  query: string
  onQuery: (query: string) => void
  selectedId: string | null
  onSelect: (id: string) => void
  actions: ReactNode
}) {
  const search = useRef<HTMLInputElement>(null)
  const colorOf = (item: VaultItem) =>
    vaults.find((entry) => entry.id === vaultOf(item))?.color ?? 1
  const showVault = vaults.length > 1

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        search.current?.focus()
        search.current?.select()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const move = (step: number) => {
    if (!items.length) return
    const index = items.findIndex((item) => item.id === selectedId)
    const next =
      items[Math.min(items.length - 1, Math.max(0, index + step))] ?? items[0]!
    onSelect(next.id)
    document
      .getElementById(`cw-item-${next.id}`)
      ?.scrollIntoView({ block: "nearest" })
  }

  return (
    <section
      aria-label={title}
      className="flex h-full min-w-0 flex-col border-r bg-surface-1"
    >
      <header className="shrink-0 space-y-3 p-3 pb-2">
        <div className="flex h-8 items-center justify-between gap-2 px-1">
          <h2 className="truncate text-sm font-semibold">
            {title}{" "}
            <span className="font-normal text-muted-foreground tabular-nums">
              {items.length}
            </span>
          </h2>
          {actions}
        </div>
        <label className="flex h-9 items-center gap-2 rounded-lg border bg-background px-3 text-sm shadow-panel focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
          <SearchIcon className="size-4 text-muted-foreground" />
          <input
            ref={search}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault()
                move(1)
              }
              if (event.key === "ArrowUp") {
                event.preventDefault()
                move(-1)
              }
              if (event.key === "Escape") onQuery("")
            }}
            placeholder="Search vault"
            aria-label="Search vault"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded border bg-muted px-1.5 font-sans text-[0.65rem] text-muted-foreground sm:inline">
            ⌘K
          </kbd>
        </label>
      </header>
      <ul
        role="listbox"
        aria-label={`${title} items`}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault()
            move(1)
          }
          if (event.key === "ArrowUp") {
            event.preventDefault()
            move(-1)
          }
        }}
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3 outline-none"
      >
        {items.map((item) => {
          const active = item.id === selectedId
          return (
            <li
              key={item.id}
              id={`cw-item-${item.id}`}
              role="option"
              aria-selected={active}
              style={{
                contentVisibility: "auto",
                containIntrinsicSize: "0 56px",
              }}
            >
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring",
                  active && "bg-brand-soft shadow-panel hover:bg-brand-soft"
                )}
              >
                <ItemIcon item={item} color={colorOf(item)} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "truncate text-sm font-medium",
                        item.error && "text-destructive"
                      )}
                    >
                      {item.name || "Untitled"}
                    </span>
                    {item.favorite && (
                      <StarIcon className="size-3 shrink-0 fill-warning text-warning" />
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {subtitleOf(item)}
                  </span>
                </span>
                {showVault && <VaultDot color={colorOf(item)} />}
              </button>
            </li>
          )
        })}
        {!items.length && (
          <li className="px-4 py-16 text-center text-sm text-muted-foreground">
            {query ? "Nothing matches that search." : "Nothing here yet."}
          </li>
        )}
      </ul>
    </section>
  )
}
