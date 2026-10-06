"use client"

import * as React from "react"
import { cn } from "cn"

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar"

import { isNavItemActive, visibleNavItems } from "@workspace/ui-shell/lib/nav"
import type { NavGroup, NavItem } from "@workspace/ui-shell/lib/nav"

/**
 * Renders a declarative nav tree into sidebar menu rows.
 *
 * Routing stays with the consumer: `renderLink` receives an item and returns
 * the element the row should render as, which in a Next app is a `<Link>`.
 *
 * ```tsx
 * <NavMenu
 *   items={nav}
 *   pathname={usePathname()}
 *   renderLink={(item) => <Link href={item.href} />}
 * />
 * ```
 */
function NavMenu({
  items,
  pathname,
  renderLink,
  label,
  className,
  ...props
}: Omit<React.ComponentProps<typeof SidebarGroup>, "children"> & {
  items: NavItem[]
  pathname: string
  renderLink: (item: NavItem) => React.ReactElement
  label?: React.ReactNode
}) {
  const visible = visibleNavItems(items)

  return (
    <SidebarGroup className={className} {...props}>
      {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
      <SidebarMenu>
        {visible.map((item) => {
          const active = isNavItemActive(item.href, pathname)
          const Icon = item.icon

          return (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton
                isActive={active}
                tooltip={item.label}
                render={renderLink(item)}
              >
                {Icon ? <Icon /> : null}
                <span>{item.label}</span>
              </SidebarMenuButton>
              {item.badge != null && (
                <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
              )}
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}

/** The same thing for a list of labelled groups. */
function NavMenuGroups({
  groups,
  ...props
}: Omit<React.ComponentProps<typeof NavMenu>, "items" | "label"> & {
  groups: NavGroup[]
}) {
  return (
    <>
      {groups.map((group, index) => (
        <NavMenu
          key={group.label ?? index}
          label={group.label}
          items={group.items}
          {...props}
        />
      ))}
    </>
  )
}

/**
 * A horizontal nav strip for marketing headers and settings pages — the same
 * `NavItem[]` shape, laid out in a row.
 */
function NavStrip({
  items,
  pathname,
  renderLink,
  className,
  ...props
}: Omit<React.ComponentProps<"nav">, "children"> & {
  items: NavItem[]
  pathname: string
  renderLink: (item: NavItem) => React.ReactElement
}) {
  return (
    <nav
      data-slot="nav-strip"
      className={cn("flex items-center gap-1 overflow-x-auto", className)}
      {...props}
    >
      {visibleNavItems(items).map((item) => {
        const active = isNavItemActive(item.href, pathname)
        const Icon = item.icon

        return React.cloneElement(
          renderLink(item),
          {
            key: item.href,
            "data-active": active || undefined,
            className: cn(
              "flex items-center gap-2 rounded-full px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none",
              "hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
              "data-active:bg-muted data-active:text-foreground",
              "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
            ),
          } as React.HTMLAttributes<HTMLElement>,
          <>
            {Icon ? <Icon /> : null}
            <span>{item.label}</span>
          </>
        )
      })}
    </nav>
  )
}

export { NavMenu, NavMenuGroups, NavStrip }
