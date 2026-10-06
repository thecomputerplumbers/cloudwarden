"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@workspace/ui/components/button"

/**
 * Light/dark switch.
 *
 * The resolved theme is only known in the browser, so the icon would differ
 * between the server render and the first client render. `useSyncExternalStore`
 * reports `false` on the server and `true` once hydrated, which lets the
 * button render a stable icon first and swap after — without a `setState`
 * inside an effect.
 */
function ThemeToggle({
  className,
  size = "icon-sm",
  variant = "ghost",
  ...props
}: React.ComponentProps<typeof Button>) {
  const { resolvedTheme, setTheme } = useTheme()
  const hydrated = useHydrated()
  const dark = hydrated && resolvedTheme === "dark"

  return (
    <Button
      data-slot="theme-toggle"
      size={size}
      variant={variant}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      className={className}
      onClick={() => setTheme(dark ? "light" : "dark")}
      {...props}
    >
      {dark ? <Moon /> : <Sun />}
    </Button>
  )
}

const noopSubscribe = () => () => {}

/** False during the server render and the hydrating render, true after. */
function useHydrated() {
  return React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  )
}

export { ThemeToggle, useHydrated }
