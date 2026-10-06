import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cn } from "cn"

function SiteFooter({
  className,
  containerClassName,
  width = "default",
  children,
  ...props
}: React.ComponentProps<"footer"> & {
  containerClassName?: string
  width?: "default" | "wide" | "full"
}) {
  return (
    <footer
      data-slot="site-footer"
      data-width={width}
      className={cn(
        "relative mt-16 border-t border-border/70 px-4 py-10 text-sm sm:px-6",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          "mx-auto w-full",
          width === "default" && "max-w-6xl",
          width === "wide" && "max-w-7xl",
          containerClassName
        )}
      >
        {children}
      </div>
    </footer>
  )
}

/** The link columns. Collapses to a single column on narrow screens. */
function SiteFooterColumns({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="site-footer-columns"
      className={cn(
        "grid gap-8 sm:grid-cols-2 lg:grid-cols-[1.5fr_repeat(3,1fr)]",
        className
      )}
      {...props}
    />
  )
}

function SiteFooterColumn({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="site-footer-column"
      className={cn("flex min-w-0 flex-col gap-2.5", className)}
      {...props}
    />
  )
}

function SiteFooterHeading({
  className,
  ...props
}: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="site-footer-heading"
      className={cn(
        "text-xs font-medium tracking-wide text-muted-foreground uppercase",
        className
      )}
      {...props}
    />
  )
}

function SiteFooterLink({
  className,
  render,
  ...props
}: useRender.ComponentProps<"a"> & React.ComponentProps<"a">) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        className: cn(
          "w-fit rounded-sm text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "site-footer-link" },
  })
}

/** The bottom line: copyright, legal links, build info. */
function SiteFooterMeta({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="site-footer-meta"
      className={cn(
        "mt-10 flex flex-col gap-3 border-t border-border/70 pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between",
        className
      )}
      {...props}
    />
  )
}

export {
  SiteFooter,
  SiteFooterColumn,
  SiteFooterColumns,
  SiteFooterHeading,
  SiteFooterLink,
  SiteFooterMeta,
}
