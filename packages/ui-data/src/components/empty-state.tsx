import * as React from "react"
import { cn } from "cn"

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"

/**
 * The shorthand for the common empty state: an icon, a line about what is
 * missing, a line about what to do, and the action itself.
 *
 * ```tsx
 * <EmptyState
 *   icon={Inbox}
 *   title="No invoices yet"
 *   description="Invoices appear here once a customer completes checkout."
 *   action={<Button>Create a test payment</Button>}
 * />
 * ```
 *
 * When you need something other than this shape, compose `Empty` from
 * `@workspace/ui` directly.
 */
function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  bordered = true,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Empty>, "title"> & {
  icon?: React.ComponentType<{ className?: string }>
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  /** Draws the dashed outline. Turn it off inside a card or a table cell. */
  bordered?: boolean
}) {
  return (
    <Empty
      data-slot="empty-state"
      className={cn(bordered && "border", "py-10", className)}
      {...props}
    >
      <EmptyHeader>
        {Icon ? (
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
        ) : null}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? (
          <EmptyDescription>{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {(action || children) && (
        <EmptyContent>
          {action}
          {children}
        </EmptyContent>
      )}
    </Empty>
  )
}

export { EmptyState }
