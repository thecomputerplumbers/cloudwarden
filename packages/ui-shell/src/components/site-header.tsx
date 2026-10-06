import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const siteHeaderVariants = cva(
  "mx-auto flex w-full items-center justify-between gap-3",
  {
    variants: {
      variant: {
        /** A floating pill that reads as an object laid on the page. */
        floating:
          "h-14 rounded-full border border-border/60 bg-background/70 px-3 pl-4 shadow-sm backdrop-blur-xl sm:px-4 sm:pl-5",
        /** Edge-to-edge bar with a hairline underneath. */
        bar: "h-14 border-b border-border px-4 sm:px-6",
        /** No chrome; useful when the page supplies its own framing. */
        plain: "h-14 px-4 sm:px-6",
      },
      width: {
        default: "max-w-6xl",
        wide: "max-w-7xl",
        full: "max-w-none",
      },
    },
    defaultVariants: { variant: "floating", width: "default" },
  }
)

/**
 * The top-level marketing or app header. Compose it:
 *
 * ```tsx
 * <SiteHeader>
 *   <Brand render={<Link href="/" />}>
 *     <BrandMark>A</BrandMark>
 *     <BrandWordmark>Acme</BrandWordmark>
 *   </Brand>
 *   <SiteHeaderNav>
 *     <SiteHeaderLink render={<Link href="/pricing" />}>Pricing</SiteHeaderLink>
 *   </SiteHeaderNav>
 * </SiteHeader>
 * ```
 */
function SiteHeader({
  className,
  containerClassName,
  variant,
  width,
  sticky = false,
  children,
  ...props
}: React.ComponentProps<"header"> &
  VariantProps<typeof siteHeaderVariants> & {
    /** Applied to the inner container rather than the outer padding element. */
    containerClassName?: string
    sticky?: boolean
  }) {
  return (
    <header
      data-slot="site-header"
      className={cn(
        "relative z-30 px-4 pt-4 sm:px-6 sm:pt-5",
        sticky && "sticky top-0",
        variant === "bar" && "px-0 pt-0 sm:px-0 sm:pt-0",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          siteHeaderVariants({ variant, width }),
          containerClassName
        )}
      >
        {children}
      </div>
    </header>
  )
}

function SiteHeaderNav({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      data-slot="site-header-nav"
      className={cn("flex shrink-0 items-center gap-1", className)}
      {...props}
    />
  )
}

/** A navigation link in the header. Pass `render={<Link href="…" />}`. */
function SiteHeaderLink({
  className,
  render,
  active = false,
  ...props
}: useRender.ComponentProps<"a"> &
  React.ComponentProps<"a"> & { active?: boolean }) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        className: cn(
          "flex items-center gap-2 rounded-full px-3 py-2 text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none",
          "hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
          "data-active:bg-muted data-active:text-foreground",
          "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "site-header-link", active },
  })
}

/** The trailing cluster: theme toggle, account menu, primary call to action. */
function SiteHeaderActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="site-header-actions"
      className={cn("flex shrink-0 items-center gap-1.5", className)}
      {...props}
    />
  )
}

export {
  SiteHeader,
  SiteHeaderActions,
  SiteHeaderLink,
  SiteHeaderNav,
  siteHeaderVariants,
}
