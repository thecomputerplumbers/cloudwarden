import { cn } from "@workspace/ui/lib/utils"

/** Cloudwarden's mark: a shield whose upper edge is a cloud line. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={cn("size-7", className)}
    >
      <defs>
        <linearGradient
          id="cw-mark"
          x1="4"
          y1="3"
          x2="28"
          y2="29"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="var(--brand)" />
          <stop offset="1" stopColor="var(--primary)" />
        </linearGradient>
      </defs>
      <path
        d="M16 2.5c2.6 0 4.8 1.6 5.7 3.9a5 5 0 0 1 5.8 4.9V15c0 7.3-5 12.3-11.5 14.5C9.5 27.3 4.5 22.3 4.5 15v-3.7a5 5 0 0 1 5.8-4.9A6.1 6.1 0 0 1 16 2.5Z"
        fill="url(#cw-mark)"
      />
      <path
        d="m11.5 16.2 3.2 3.2 6-6.4"
        fill="none"
        stroke="var(--brand-foreground)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 font-semibold tracking-tight",
        className
      )}
    >
      <BrandMark />
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
