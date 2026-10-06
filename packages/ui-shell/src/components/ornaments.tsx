import * as React from "react"
import { cn } from "cn"

/**
 * Soft colour washes behind a page. Purely decorative and inert: it never
 * takes pointer events and is hidden from assistive technology.
 *
 * Colours come from the chart tokens so an ornamented page re-themes with
 * the rest of the app instead of pinning hard-coded hexes into the layout.
 */
function FloatingOrnaments({
  className,
  intensity = "default",
  ...props
}: React.ComponentProps<"div"> & { intensity?: "quiet" | "default" | "loud" }) {
  return (
    <div
      data-slot="floating-ornaments"
      data-intensity={intensity}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        "[--ornament-opacity:0.5] data-[intensity=loud]:[--ornament-opacity:0.7] data-[intensity=quiet]:[--ornament-opacity:0.3]",
        "dark:[--ornament-opacity:0.16] dark:data-[intensity=loud]:[--ornament-opacity:0.24] dark:data-[intensity=quiet]:[--ornament-opacity:0.1]",
        className
      )}
      {...props}
    >
      <div
        className="absolute -top-24 -left-24 size-72 rounded-full bg-chart-1 blur-3xl in-data-[intensity=quiet]:size-48"
        style={{ opacity: "var(--ornament-opacity)" }}
      />
      <div
        className="absolute -top-16 -right-28 size-80 rounded-full bg-chart-2 blur-3xl"
        style={{ opacity: "var(--ornament-opacity)" }}
      />
      {intensity !== "quiet" && (
        <div
          className="absolute -bottom-32 left-[38%] size-80 rounded-full bg-chart-3 blur-3xl"
          style={{ opacity: "var(--ornament-opacity)" }}
        />
      )}
    </div>
  )
}

/**
 * A faint paper tooth over the whole surface. Takes the edge off large flat
 * backgrounds without costing an image request.
 */
function GrainOverlay({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="grain-overlay"
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 opacity-[0.035] mix-blend-multiply dark:opacity-[0.06] dark:mix-blend-screen",
        className
      )}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23g)'/%3E%3C/svg%3E\")",
      }}
      {...props}
    />
  )
}

/** Wraps a page so ornaments can be positioned against it. */
function OrnamentedSurface({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="ornamented-surface"
      className={cn(
        "relative isolate min-h-svh overflow-hidden bg-background",
        className
      )}
      {...props}
    />
  )
}

export { FloatingOrnaments, GrainOverlay, OrnamentedSurface }
