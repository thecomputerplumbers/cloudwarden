"use client"

import { CheckIcon } from "lucide-react"
import { useSyncExternalStore } from "react"

/** One quiet confirmation at a time, at the bottom of the screen. */
let current: { id: number; text: string } | null = null
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined

export function toast(text: string) {
  current = { id: Date.now(), text }
  for (const listener of listeners) listener()
  clearTimeout(timer)
  timer = setTimeout(() => {
    current = null
    for (const listener of listeners) listener()
  }, 1800)
}

/** How long a copied secret stays on the clipboard before it is cleared. */
const CLEAR_AFTER_MS = 60_000

export async function copy(value: string, label: string, secret = false) {
  await navigator.clipboard.writeText(value)
  toast(`${label} copied${secret ? " · clears in 1 min" : ""}`)
  if (secret)
    setTimeout(async () => {
      try {
        if ((await navigator.clipboard.readText()) === value)
          await navigator.clipboard.writeText("")
      } catch {
        // Reading the clipboard needs permission; without it the copy is left alone.
      }
    }, CLEAR_AFTER_MS)
}

export function Toaster() {
  const value = useSyncExternalStore(
    (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    () => current,
    () => null
  )
  if (!value) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center"
    >
      <div
        key={value.id}
        className="flex animate-in items-center gap-2 rounded-full bg-foreground px-4 py-2 text-sm text-background shadow-lift fade-in slide-in-from-bottom-2"
      >
        <CheckIcon className="size-4 text-brand" />
        {value.text}
      </div>
    </div>
  )
}
