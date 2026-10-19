import { useSyncExternalStore } from "react"

/**
 * Links into the vault. Emails use Bitwarden's web vault routes
 * (`/#/finish-signup/?…`, `/#/accept-organization/?…`), which Bitwarden's apps
 * also build, so the native vault answers the same hashes.
 */
export type VaultLink =
  | { kind: "signup" }
  | { kind: "finish-signup"; email: string; token: string }
  | {
      kind: "invite"
      email: string
      orgName: string
      orgId: string
      memberId: string
      token: string
      existingUser: boolean
    }
  | { kind: "unsupported" }

export function parseLink(hash: string): VaultLink | null {
  if (!hash.startsWith("#/")) return null
  const [path = "", query = ""] = hash.slice(2).split("?", 2)
  const route = path.replace(/\/+$/, "")
  const params = new URLSearchParams(query)
  const get = (name: string) => params.get(name) ?? ""
  if (route === "signup" || route === "register") return { kind: "signup" }
  if (route === "finish-signup" && get("email") && get("token"))
    return { kind: "finish-signup", email: get("email"), token: get("token") }
  if (
    route === "accept-organization" &&
    get("email") &&
    get("organizationId") &&
    get("organizationUserId") &&
    get("token")
  )
    return {
      kind: "invite",
      email: get("email"),
      orgName: get("organizationName") || "an organization",
      orgId: get("organizationId"),
      memberId: get("organizationUserId"),
      token: get("token"),
      existingUser: get("orgUserHasExistingUser") !== "false",
    }
  return { kind: "unsupported" }
}

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) window.addEventListener("hashchange", notify)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener("hashchange", notify)
  }
}

/** The current link, from the URL hash. */
export const useLinkHash = () =>
  useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => ""
  )

/** Moves to a link without a history entry, so Back leaves the vault rather than replaying a sign-up step. */
export function navigate(link: VaultLink | null) {
  history.replaceState(null, "", window.location.pathname + linkHash(link))
  notify()
}

function linkHash(link: VaultLink | null) {
  if (!link || link.kind === "unsupported") return ""
  if (link.kind === "signup") return "#/signup"
  if (link.kind === "finish-signup")
    return `#/finish-signup/?${new URLSearchParams({ email: link.email, token: link.token })}`
  return `#/accept-organization/?${new URLSearchParams({
    email: link.email,
    organizationName: link.orgName,
    organizationId: link.orgId,
    organizationUserId: link.memberId,
    token: link.token,
    orgUserHasExistingUser: String(link.existingUser),
  })}`
}
