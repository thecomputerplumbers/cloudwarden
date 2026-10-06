import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

import { Separator } from "@workspace/ui/components/separator"

/**
 * A siderail is the secondary column beside the main column: summaries,
 * related links, an account panel, a call to action. It is not the primary
 * navigation — reach for `Sidebar` from `@workspace/ui` for that.
 *
 * `SiderailLayout` gives you the two-column frame; on small screens the rail
 * stacks underneath the content unless `side` places it first.
 */
function SiderailLayout({
  className,
  side = "inline-end",
  width = "default",
  ...props
}: React.ComponentProps<"div"> & {
  side?: "inline-start" | "inline-end"
  width?: "sm" | "default" | "lg"
}) {
  return (
    <div
      data-slot="siderail-layout"
      data-side={side}
      data-width={width}
      className={cn(
        "grid items-start gap-8 data-[width=default]:[--siderail-width:19rem] data-[width=lg]:[--siderail-width:23rem] data-[width=sm]:[--siderail-width:16rem]",
        "lg:grid-cols-[minmax(0,1fr)_var(--siderail-width)] lg:data-[side=inline-start]:grid-cols-[var(--siderail-width)_minmax(0,1fr)]",
        className
      )}
      {...props}
    />
  )
}

/** The main column of a `SiderailLayout`. */
function SiderailContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="siderail-content"
      className={cn("min-w-0 lg:order-1", className)}
      {...props}
    />
  )
}

const siderailVariants = cva(
  "flex min-w-0 flex-col gap-6 text-sm [--siderail-offset:--spacing(6)] lg:sticky lg:top-(--siderail-offset) lg:order-2 in-data-[side=inline-start]:lg:order-none",
  {
    variants: {
      variant: {
        /** Flush against the page, separated by a hairline. */
        default:
          "lg:border-l lg:border-border/70 lg:pl-8 in-data-[side=inline-start]:lg:border-r in-data-[side=inline-start]:lg:border-l-0 in-data-[side=inline-start]:lg:pr-8 in-data-[side=inline-start]:lg:pl-0",
        /** A panel with its own surface — good over a decorated background. */
        panel:
          "rounded-2xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10",
        /** No chrome at all; you supply the framing. */
        plain: "",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

function Siderail({
  className,
  variant,
  ...props
}: React.ComponentProps<"aside"> & VariantProps<typeof siderailVariants>) {
  return (
    <aside
      data-slot="siderail"
      className={cn(siderailVariants({ variant }), className)}
      {...props}
    />
  )
}

function SiderailSection({
  className,
  ...props
}: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="siderail-section"
      className={cn("flex flex-col gap-2.5", className)}
      {...props}
    />
  )
}

function SiderailHeading({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="siderail-heading"
      className={cn(
        "text-xs font-medium tracking-wide text-muted-foreground uppercase",
        className
      )}
      {...props}
    />
  )
}

function SiderailSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="siderail-separator"
      className={cn("my-1", className)}
      {...props}
    />
  )
}

/**
 * A row in the rail. Pass `render={<Link href="…" />}` to make it a link;
 * it stays a plain `div` otherwise.
 */
function SiderailItem({
  className,
  render,
  active = false,
  ...props
}: useRender.ComponentProps<"div"> &
  React.ComponentProps<"div"> & { active?: boolean }) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "-mx-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors",
          "data-active:bg-muted data-active:text-foreground",
          "[a&]:hover:bg-muted [a&]:hover:text-foreground",
          "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "siderail-item", active },
  })
}

/** Trailing content inside a `SiderailItem` — a count, a timestamp, a chevron. */
function SiderailItemMeta({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="siderail-item-meta"
      className={cn(
        "ml-auto text-xs text-muted-foreground/80 tabular-nums",
        className
      )}
      {...props}
    />
  )
}

/** Quiet prose in the rail: a caveat, a hint, a policy note. */
function SiderailNote({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="siderail-note"
      className={cn("text-sm leading-6 text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Siderail,
  SiderailContent,
  SiderailHeading,
  SiderailItem,
  SiderailItemMeta,
  SiderailLayout,
  SiderailNote,
  SiderailSection,
  SiderailSeparator,
  siderailVariants,
}
