import type { VaultItem } from "./crypto/cipher.ts"

export const PERSONAL_VAULT = "personal"

/** What the sidebar and search box select. Vault selection is separate: it is saved per account. */
export interface ItemFilter {
  view:
    | "all"
    | "favorites"
    | "login"
    | "card"
    | "identity"
    | "note"
    | "sshKey"
    | "trash"
  folderId?: string | null
  collectionId?: string
  query: string
}

export const vaultOf = (item: Pick<VaultItem, "organizationId">) =>
  item.organizationId ?? PERSONAL_VAULT

const hostOf = (uri: string) => {
  try {
    return new URL(uri.includes("://") ? uri : `https://${uri}`).hostname
  } catch {
    return uri
  }
}

/** Whether an item matches a search: its name, username, URI hosts, card brand, or notes, ignoring case. */
export function matches(item: VaultItem, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const haystack = [
    item.name,
    item.login?.username,
    ...(item.login?.uris ?? []).map((entry) => hostOf(entry.uri)),
    item.card?.brand,
    item.identity?.email,
    item.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/** The items to list: in a selected vault, in the chosen view, folder or collection, and matching the search. */
export function visibleItems(
  items: VaultItem[],
  excluded: ReadonlySet<string>,
  filter: ItemFilter
) {
  return items.filter((item) => {
    if (excluded.has(vaultOf(item))) return false
    if (filter.view === "trash") {
      if (!item.deleted) return false
    } else {
      if (item.deleted) return false
      if (filter.view === "favorites" && !item.favorite) return false
      if (
        filter.view !== "all" &&
        filter.view !== "favorites" &&
        item.kind !== filter.view
      )
        return false
    }
    if (filter.folderId !== undefined && item.folderId !== filter.folderId)
      return false
    if (
      filter.collectionId !== undefined &&
      !item.collectionIds.includes(filter.collectionId)
    )
      return false
    return matches(item, filter.query)
  })
}

/** Toggles one vault in a selection. The last selected vault cannot be turned off: an empty vault view helps nobody. */
export function toggleVault(
  excluded: ReadonlySet<string>,
  vaultIds: string[],
  vaultId: string
) {
  const next = new Set(excluded)
  if (next.has(vaultId)) next.delete(vaultId)
  else if (vaultIds.filter((id) => !next.has(id)).length > 1) next.add(vaultId)
  return next
}

/** Shows only one vault: every other one is excluded. */
export const onlyVault = (vaultIds: string[], vaultId: string) =>
  new Set(vaultIds.filter((id) => id !== vaultId))
