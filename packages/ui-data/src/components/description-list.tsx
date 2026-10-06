import * as React from "react"
import { cn } from "cn"

/**
 * Key/value pairs — the detail panel under a record. Two columns once there
 * is room, stacked before that, which keeps long values readable on a phone.
 */
function DescriptionList({
  className,
  layout = "columns",
  ...props
}: React.ComponentProps<"dl"> & { layout?: "columns" | "rows" }) {
  return (
    <dl
      data-slot="description-list"
      data-layout={layout}
      className={cn(
        "text-sm",
        layout === "columns"
          ? "grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]"
          : "divide-y divide-border",
        className
      )}
      {...props}
    />
  )
}

function DescriptionTerm({ className, ...props }: React.ComponentProps<"dt">) {
  return (
    <dt
      data-slot="description-term"
      className={cn(
        "text-muted-foreground in-data-[layout=rows]:pt-3",
        className
      )}
      {...props}
    />
  )
}

function DescriptionDetails({
  className,
  ...props
}: React.ComponentProps<"dd">) {
  return (
    <dd
      data-slot="description-details"
      className={cn(
        "min-w-0 break-words in-data-[layout=rows]:pb-3",
        className
      )}
      {...props}
    />
  )
}

/**
 * One pair, for the `rows` layout where term and value share a line.
 * In the `columns` layout use `DescriptionTerm`/`DescriptionDetails` directly
 * so the grid can align every column.
 */
function DescriptionRow({
  term,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  term: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div
      data-slot="description-row"
      className={cn(
        "flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2",
        className
      )}
      {...props}
    >
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 text-right break-words">{children}</dd>
    </div>
  )
}

export { DescriptionDetails, DescriptionList, DescriptionRow, DescriptionTerm }
