import * as React from "react"
import { cn } from "cn"

/** Centres and pads a page's content column. */
function Container({
  className,
  width = "default",
  ...props
}: React.ComponentProps<"div"> & {
  width?: "prose" | "default" | "wide" | "full"
}) {
  return (
    <div
      data-slot="container"
      data-width={width}
      className={cn(
        "mx-auto w-full px-5 sm:px-8",
        width === "prose" && "max-w-2xl",
        width === "default" && "max-w-6xl",
        width === "wide" && "max-w-7xl",
        className
      )}
      {...props}
    />
  )
}

/** A titled band of a page, with breathing room above it. */
function Section({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="section"
      className={cn("py-10 sm:py-14", className)}
      {...props}
    />
  )
}

/**
 * The block at the top of a page: an optional eyebrow, a title, a line of
 * description, and actions pinned to the trailing edge on wide screens.
 */
function PageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-header"
      className={cn(
        "flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between",
        className
      )}
      {...props}
    />
  )
}

function PageHeaderContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-header-content"
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
      {...props}
    />
  )
}

/** The small line above a title: a category, a status, a step count. */
function Eyebrow({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="eyebrow"
      className={cn(
        "text-xs font-medium tracking-wide text-muted-foreground uppercase",
        className
      )}
      {...props}
    />
  )
}

function PageHeaderTitle({ className, ...props }: React.ComponentProps<"h1">) {
  return (
    <h1
      data-slot="page-header-title"
      className={cn(
        "font-heading text-2xl leading-tight font-semibold tracking-tight text-balance sm:text-3xl",
        className
      )}
      {...props}
    />
  )
}

function PageHeaderDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="page-header-description"
      className={cn(
        "max-w-2xl text-sm leading-6 text-pretty text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function PageHeaderActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-header-actions"
      className={cn("flex shrink-0 flex-wrap items-center gap-2", className)}
      {...props}
    />
  )
}

export {
  Container,
  Eyebrow,
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
  Section,
}
