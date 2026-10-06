import * as React from "react"

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

/**
 * Whether the viewport is phone-width.
 *
 * `useSyncExternalStore` rather than state-in-an-effect: the media query is
 * an external store, so React can read it during render on the client and
 * take `false` on the server, which is what keeps the first paint from
 * flipping after hydration.
 *
 * (shadcn generates this file with a `useEffect`; it is rewritten here
 * because that form trips `react(set-state-in-effect)` under oxlint.)
 */
export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false
  )
}

function subscribe(onChange: () => void) {
  const query = window.matchMedia(QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}
