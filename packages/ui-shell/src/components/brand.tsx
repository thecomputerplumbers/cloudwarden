import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cn } from "cn"

/**
 * The wordmark. `render={<Link href="/" />}` turns it into the home link;
 * left alone it is a plain `span`, which is what you want in a footer or on
 * the page it already points at.
 */
function Brand({
  className,
  render,
  ...props
}: useRender.ComponentProps<"span"> & React.ComponentProps<"span">) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(
          "flex items-center gap-2 rounded-lg text-sm font-medium tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "brand" },
  })
}

/** The glyph beside the wordmark — an icon, an SVG, a single letter. */
function BrandMark({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="brand-mark"
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-[0.7rem] font-semibold text-primary-foreground",
        "[&_svg:not([class*='size-'])]:size-3.5",
        className
      )}
      {...props}
    />
  )
}

function BrandWordmark({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="brand-wordmark"
      className={cn("truncate font-heading", className)}
      {...props}
    />
  )
}

export { Brand, BrandMark, BrandWordmark }
