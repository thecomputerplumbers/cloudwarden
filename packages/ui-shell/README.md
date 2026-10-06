# @workspace/ui-shell

The furniture a page sits in: shells, siderails, headers, footers, titles.

`@workspace/ui` holds the primitives — a button, a card, a sidebar. This holds
the arrangements of them that every page repeats.

## Components

| File           | Exports                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `app-shell`    | `AppShell`, `AppShellHeader`, `AppShellMain`, `AppShellTitle`, `AppSidebar*`                       |
| `siderail`     | `SiderailLayout`, `SiderailContent`, `Siderail`, `SiderailSection`, `SiderailItem`, `SiderailNote` |
| `site-header`  | `SiteHeader`, `SiteHeaderNav`, `SiteHeaderLink`, `SiteHeaderActions`                               |
| `site-footer`  | `SiteFooter`, `SiteFooterColumns`, `SiteFooterColumn`, `SiteFooterLink`, `SiteFooterMeta`          |
| `page-header`  | `Container`, `Section`, `PageHeader`, `PageHeaderTitle`, `PageHeaderDescription`, `Eyebrow`        |
| `nav-menu`     | `NavMenu`, `NavMenuGroups`, `NavStrip`                                                             |
| `brand`        | `Brand`, `BrandMark`, `BrandWordmark`                                                              |
| `ornaments`    | `OrnamentedSurface`, `FloatingOrnaments`, `GrainOverlay`                                           |
| `theme-toggle` | `ThemeToggle`, `useHydrated`                                                                       |
| `lib/nav`      | `NavItem`, `NavGroup`, `isNavItemActive`, `navTrail`, `visibleNavItems`                            |

## Sidebar or siderail?

A **sidebar** navigates away from the page — it is `Sidebar` from
`@workspace/ui`, and `AppShell` arranges it. A **siderail** is the secondary
column _of_ the page: a summary, related links, an account panel, a call to
action. `SiderailLayout` gives you the two columns; below `lg` the rail stacks
under the content.

## Routing stays yours

Nothing here imports a router. Anything that can be a link takes Base UI's
`render` prop, so you hand it the element:

```tsx
<SiteHeaderLink render={<Link href="/pricing" />}>Pricing</SiteHeaderLink>
```

`NavMenu` takes the same idea one level up — a declarative `NavItem[]`, the
current `pathname`, and a `renderLink` callback:

```tsx
<NavMenu
  items={nav}
  pathname={usePathname()}
  renderLink={(item) => <Link href={item.href} />}
/>
```

## Ornaments

`FloatingOrnaments` draws soft washes behind a page using the `--chart-*`
tokens rather than hard-coded hexes, so an ornamented page re-themes with the
rest of the app. It is inert: no pointer events, hidden from assistive
technology. Wrap the page in `OrnamentedSurface` so it has something to
position against.
