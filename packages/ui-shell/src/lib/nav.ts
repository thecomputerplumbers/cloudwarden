import type * as React from "react"

/**
 * A single destination in an application's navigation. Consumers own routing,
 * so `href` is only ever handed back to the element supplied through `render`
 * — nothing here imports a router.
 */
export type NavItem = {
  href: string
  label: string
  icon?: React.ComponentType<{ className?: string }>
  /** Rendered at the trailing edge of the item, e.g. an unread count. */
  badge?: React.ReactNode
  description?: string
  /** Hides the item without removing it from the source list. */
  hidden?: boolean
  items?: NavItem[]
}

export type NavGroup = {
  label?: string
  items: NavItem[]
}

/**
 * Marks the deepest matching item as active. `/` only matches itself so a
 * home link does not light up on every page.
 */
export function isNavItemActive(href: string, pathname: string) {
  if (href === "/") return pathname === "/"
  return pathname === href || pathname.startsWith(`${href}/`)
}

/** Drops hidden entries, recursively. */
export function visibleNavItems(items: NavItem[]): NavItem[] {
  return items
    .filter((item) => !item.hidden)
    .map((item) =>
      item.items ? { ...item, items: visibleNavItems(item.items) } : item
    )
}

/**
 * Builds a breadcrumb trail for `pathname` out of a flat or nested nav tree.
 * Returns the matched items from shallowest to deepest.
 */
export function navTrail(items: NavItem[], pathname: string): NavItem[] {
  for (const item of items) {
    if (!isNavItemActive(item.href, pathname)) continue
    const deeper = item.items ? navTrail(item.items, pathname) : []
    return [item, ...deeper]
  }
  return []
}
