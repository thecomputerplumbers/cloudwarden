import { cn } from "@workspace/ui/lib/utils"

/**
 * Cloudwarden's mark: a key whose shaft bends like a pipe elbow, on a copper
 * tile. The glyph is drawn in the tile's foreground so it inverts with the theme.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={cn("size-7 shrink-0", className)}
    >
      <rect width="32" height="32" rx="7.5" fill="var(--brand)" />
      <g
        fill="none"
        stroke="var(--brand-foreground)"
        strokeWidth="3.1"
        strokeLinecap="square"
      >
        <circle cx="11.6" cy="11.4" r="4.6" />
        <path d="M16.2 11.4h4.2a4 4 0 0 1 4 4v9M24.4 20h-3.6M24.4 24.4h-3.6" />
      </g>
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex items-center gap-2.5 font-bold tracking-[-0.01em] font-wide",
        className
      )}
    >
      <BrandMark className="size-6" />
      <span>Cloudwarden</span>
    </span>
  )
}

/** The dot that marks which vault an item or collection belongs to. */
export function VaultDot({
  color,
  className,
}: {
  color: number
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ background: `var(--vault-${color})` }}
    />
  )
}
