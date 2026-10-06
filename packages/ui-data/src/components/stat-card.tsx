import * as React from "react"
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

import { Card, CardContent, CardHeader } from "@workspace/ui/components/card"

/** Lays stat cards out in an even grid that reflows on narrow screens. */
function StatGrid({
  className,
  columns = 3,
  ...props
}: React.ComponentProps<"div"> & { columns?: 2 | 3 | 4 }) {
  return (
    <div
      data-slot="stat-grid"
      className={cn(
        "grid gap-4 sm:grid-cols-2",
        columns === 3 && "lg:grid-cols-3",
        columns === 4 && "lg:grid-cols-4",
        className
      )}
      {...props}
    />
  )
}

function StatCard({ className, ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card data-slot="stat-card" className={cn("gap-3", className)} {...props} />
  )
}

function StatCardHeader({
  className,
  ...props
}: React.ComponentProps<typeof CardHeader>) {
  return (
    <CardHeader
      data-slot="stat-card-header"
      className={cn("flex-row items-center gap-2", className)}
      {...props}
    />
  )
}

function StatLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stat-label"
      className={cn("text-sm font-medium text-muted-foreground", className)}
      {...props}
    />
  )
}

function StatCardContent({
  className,
  ...props
}: React.ComponentProps<typeof CardContent>) {
  return (
    <CardContent
      data-slot="stat-card-content"
      className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-1", className)}
      {...props}
    />
  )
}

/**
 * The number itself. `tabular-nums` keeps the digits from shifting when a
 * value updates in place.
 */
function StatValue({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stat-value"
      className={cn(
        "font-heading text-2xl leading-none font-semibold tabular-nums",
        className
      )}
      {...props}
    />
  )
}

/** Units, periods, comparisons — the quiet text beside the value. */
function StatUnit({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="stat-unit"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

const statDeltaVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      direction: {
        up: "bg-chart-2/15 text-foreground",
        down: "bg-destructive/10 text-destructive",
        flat: "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { direction: "flat" },
  }
)

const deltaIcons = { up: ArrowUp, down: ArrowDown, flat: ArrowRight } as const

/**
 * A period-over-period change. Direction drives both the arrow and the tone,
 * and the arrow carries the meaning for anyone who cannot see the colour.
 *
 * `intent` flips the tone when up is the bad outcome — churn, error rate,
 * latency — without changing which way the arrow points.
 */
function StatDelta({
  className,
  direction = "flat",
  intent = "up-is-good",
  children,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> &
  VariantProps<typeof statDeltaVariants> & {
    intent?: "up-is-good" | "down-is-good"
    children?: React.ReactNode
  }) {
  const resolved = direction ?? "flat"
  const Icon = deltaIcons[resolved]
  const tone =
    resolved === "flat" || intent === "up-is-good"
      ? resolved
      : resolved === "up"
        ? "down"
        : "up"

  return (
    <span
      data-slot="stat-delta"
      data-direction={resolved}
      className={cn(statDeltaVariants({ direction: tone }), className)}
      {...props}
    >
      <Icon aria-hidden="true" />
      {children}
    </span>
  )
}

export {
  StatCard,
  StatCardContent,
  StatCardHeader,
  StatDelta,
  StatGrid,
  StatLabel,
  StatUnit,
  StatValue,
  statDeltaVariants,
}
