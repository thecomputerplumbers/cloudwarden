import type { ReactNode } from "react"
import {
  AppShell,
  AppShellHeader,
  AppShellMain,
  AppShellTitle,
} from "@workspace/ui-shell/components/app-shell"
import { AppSidebar } from "@/components/app-sidebar"
export function AccountPage({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <AppShell sidebar={<AppSidebar />}>
      <AppShellHeader>
        <AppShellTitle>{title}</AppShellTitle>
      </AppShellHeader>
      <AppShellMain width="default">
        <div className="flex max-w-2xl flex-col gap-8">{children}</div>
      </AppShellMain>
    </AppShell>
  )
}
