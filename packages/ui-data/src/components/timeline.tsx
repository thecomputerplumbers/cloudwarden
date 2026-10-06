import * as React from "react"
import { cn } from "cn"

import {
  StatusDot,
  type StatusTone,
} from "@workspace/ui-data/components/status"

/**
 * A vertical run of events: an audit log, a job's progress, a billing
 * history. The connecting line is drawn on the list so it never dangles past
 * the final item.
 */
function Timeline({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="timeline"
      className={cn(
        "relative flex flex-col gap-6 border-l border-border pl-6",
        className
      )}
      {...props}
    />
  )
}

function TimelineItem({
  className,
  tone = "neutral",
  marker,
  children,
  ...props
}: React.ComponentProps<"li"> & {
  tone?: StatusTone
  /** Replaces the default dot — an icon, an avatar, a step number. */
  marker?: React.ReactNode
}) {
  return (
    <li
      data-slot="timeline-item"
      data-tone={tone}
      className={cn("relative flex flex-col gap-1", className)}
      {...props}
    >
      <span className="absolute top-1 -left-6 flex size-3 -translate-x-1/2 items-center justify-center rounded-full bg-background">
        {marker ?? <StatusDot tone={tone} ring={false} />}
      </span>
      {children}
    </li>
  )
}

function TimelineTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="timeline-title"
      className={cn("text-sm font-medium", className)}
      {...props}
    />
  )
}

function TimelineDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="timeline-description"
      className={cn("text-sm leading-6 text-muted-foreground", className)}
      {...props}
    />
  )
}

/** The timestamp. Pass a `<time dateTime>` through `render` if you need one. */
function TimelineTime({ className, ...props }: React.ComponentProps<"time">) {
  return (
    <time
      data-slot="timeline-time"
      className={cn("text-xs text-muted-foreground tabular-nums", className)}
      {...props}
    />
  )
}

export {
  Timeline,
  TimelineDescription,
  TimelineItem,
  TimelineTime,
  TimelineTitle,
}
