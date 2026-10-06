import * as React from "react"
import { cn } from "cn"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@workspace/ui/components/sidebar"
import { Separator } from "@workspace/ui/components/separator"

/**
 * The signed-in layout: a collapsible sidebar beside a scrolling content
 * column. This is a thin arrangement of `Sidebar` from `@workspace/ui` — when
 * you need finer control, drop to those parts directly.
 *
 * ```tsx
 * <AppShell
 *   sidebar={
 *     <AppSidebar>
 *       <AppSidebarHeader>…</AppSidebarHeader>
 *       <AppSidebarContent>…</AppSidebarContent>
 *     </AppSidebar>
 *   }
 * >
 *   <AppShellHeader>
 *     <AppShellTitle>Library</AppShellTitle>
 *   </AppShellHeader>
 *   <AppShellMain>…</AppShellMain>
 * </AppShell>
 * ```
 */
function AppShell({
  sidebar,
  children,
  className,
  defaultSidebarOpen = true,
  ...props
}: React.ComponentProps<typeof SidebarProvider> & {
  sidebar?: React.ReactNode
  defaultSidebarOpen?: boolean
}) {
  return (
    <SidebarProvider
      defaultOpen={defaultSidebarOpen}
      className={cn("min-h-svh", className)}
      {...props}
    >
      {sidebar}
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  )
}

/**
 * The bar across the top of the content column. It carries the sidebar
 * trigger so the sidebar stays reachable once it is collapsed.
 */
function AppShellHeader({
  className,
  children,
  trigger = true,
  ...props
}: React.ComponentProps<"header"> & { trigger?: boolean }) {
  return (
    <header
      data-slot="app-shell-header"
      className={cn(
        "sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur-sm",
        className
      )}
      {...props}
    >
      {trigger && (
        <>
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />
        </>
      )}
      {children}
    </header>
  )
}

function AppShellTitle({ className, ...props }: React.ComponentProps<"h1">) {
  return (
    <h1
      data-slot="app-shell-title"
      className={cn("truncate font-heading text-sm font-medium", className)}
      {...props}
    />
  )
}

/** The trailing cluster in the shell header. */
function AppShellHeaderActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="app-shell-header-actions"
      className={cn("ml-auto flex items-center gap-1.5", className)}
      {...props}
    />
  )
}

function AppShellMain({
  className,
  width = "wide",
  ...props
}: React.ComponentProps<"main"> & {
  width?: "prose" | "default" | "wide" | "full"
}) {
  return (
    <main
      data-slot="app-shell-main"
      data-width={width}
      className={cn(
        "mx-auto w-full flex-1 px-4 py-6 sm:px-6 sm:py-8",
        width === "prose" && "max-w-2xl",
        width === "default" && "max-w-5xl",
        width === "wide" && "max-w-7xl",
        className
      )}
      {...props}
    />
  )
}

/** Re-exported so an app shell can be assembled from one import. */
export {
  AppShell,
  AppShellHeader,
  AppShellHeaderActions,
  AppShellMain,
  AppShellTitle,
  Sidebar as AppSidebar,
  SidebarContent as AppSidebarContent,
  SidebarFooter as AppSidebarFooter,
  SidebarHeader as AppSidebarHeader,
}
