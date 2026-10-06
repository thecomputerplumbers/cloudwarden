import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/**
 * Semantic tones shared by every status indicator here, so a "running" job
 * looks the same in a table cell, a badge and a timeline.
 */
export type StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "pending"

const toneClasses: Record<StatusTone, string> = {
  neutral: "[--status:var(--color-muted-foreground)]",
  info: "[--status:var(--color-chart-2)]",
  success: "[--status:var(--color-chart-3)]",
  warning: "[--status:var(--color-chart-1)]",
  danger: "[--status:var(--color-destructive)]",
  pending: "[--status:var(--color-chart-4)]",
}

const statusDotVariants = cva(
  "inline-block shrink-0 rounded-full bg-(--status)",
  {
    variants: {
      size: { sm: "size-1.5", default: "size-2", lg: "size-2.5" },
      ring: { true: "ring-3 ring-(--status)/20", false: "" },
      pulse: { true: "animate-pulse", false: "" },
    },
    defaultVariants: { size: "default", ring: true, pulse: false },
  }
)

/**
 * A coloured dot. Decorative on its own — always pair it with the status word
 * so the state does not depend on colour alone.
 */
function StatusDot({
  className,
  tone = "neutral",
  size,
  ring,
  pulse,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof statusDotVariants> & { tone?: StatusTone }) {
  return (
    <span
      data-slot="status-dot"
      data-tone={tone}
      aria-hidden="true"
      className={cn(
        toneClasses[tone],
        statusDotVariants({ size, ring, pulse }),
        className
      )}
      {...props}
    />
  )
}

/** Dot plus label. This is the one to reach for in a table cell. */
function StatusBadge({
  className,
  tone = "neutral",
  pulse,
  children,
  ...props
}: React.ComponentProps<"span"> & { tone?: StatusTone; pulse?: boolean }) {
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      className={cn(
        toneClasses[tone],
        "inline-flex items-center gap-1.5 rounded-full bg-(--status)/10 py-0.5 pr-2.5 pl-2 text-xs font-medium whitespace-nowrap text-foreground",
        className
      )}
      {...props}
    >
      <StatusDot tone={tone} size="sm" ring={false} pulse={pulse} />
      {children}
    </span>
  )
}

/**
 * Maps common state strings onto tones so call sites do not each invent their
 * own mapping. Unknown values fall back to `neutral`.
 */
export function statusTone(status: string): StatusTone {
  switch (status.toLowerCase()) {
    case "active":
    case "complete":
    case "completed":
    case "succeeded":
    case "success":
    case "paid":
    case "ready":
      return "success"
    case "pending":
    case "processing":
    case "running":
    case "queued":
      return "pending"
    case "trialing":
    case "draft":
    case "scheduled":
      return "info"
    case "past_due":
    case "incomplete":
    case "unpaid":
    case "warning":
    case "degraded":
      return "warning"
    case "failed":
    case "error":
    case "canceled":
    case "cancelled":
    case "revoked":
      return "danger"
    default:
      return "neutral"
  }
}

export { StatusBadge, StatusDot, statusDotVariants }
