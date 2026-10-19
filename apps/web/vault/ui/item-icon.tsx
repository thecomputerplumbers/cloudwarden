import { cn } from "@workspace/ui/lib/utils"
import {
  CreditCardIcon,
  FileQuestionIcon,
  IdCardIcon,
  KeyRoundIcon,
  StickyNoteIcon,
  TerminalSquareIcon,
} from "lucide-react"
import { useState } from "react"
import type { VaultItem } from "../crypto/cipher.ts"

const ICONS = {
  login: KeyRoundIcon,
  card: CreditCardIcon,
  identity: IdCardIcon,
  note: StickyNoteIcon,
  sshKey: TerminalSquareIcon,
  unknown: FileQuestionIcon,
}

/** Hosts whose icon failed to load this session, so rows don't retry them. */
const missingIcons = new Set<string>()

function hostOf(item: VaultItem) {
  const uri = item.login?.uris.find((entry) => entry.uri)?.uri
  if (!uri) return null
  try {
    const host = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : `https://${uri}`
    ).hostname
    // The icon route serves public DNS names only; skip IPs and bare hosts.
    return host.includes(".") && !/^[\d.]+$/.test(host) ? host : null
  } catch {
    return null
  }
}

/**
 * A login shows its website's icon (fetched through our own Worker, so the
 * domain never reaches a third party) or its initial; other kinds show their
 * kind icon. `vault` adds a corner badge in that vault's color.
 */
export function ItemIcon({
  item,
  vault,
  size = "md",
}: {
  item: VaultItem
  vault?: number
  size?: "md" | "lg"
}) {
  const Icon = ICONS[item.kind]
  const big = size === "lg"
  const host = item.kind === "login" ? hostOf(item) : null
  const [failed, setFailed] = useState(false)
  const showImage = host && !failed && !missingIcons.has(host)
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground",
        // Most site icons are drawn for light backgrounds.
        showImage && "border-transparent bg-white",
        big ? "size-11 text-base" : "size-8 text-[0.8rem]"
      )}
    >
      {showImage ? (
        // A tiny icon from our own Worker; next/image's optimizer adds nothing.
        // oxlint-disable-next-line next/no-img-element
        <img
          src={`/icons/${host}/icon.png`}
          alt=""
          loading="lazy"
          decoding="async"
          className={cn("rounded-[3px]", big ? "size-6" : "size-[1.125rem]")}
          onError={() => (missingIcons.add(host), setFailed(true))}
        />
      ) : item.kind === "login" && item.name ? (
        <span className="font-semibold text-foreground/75 uppercase font-wide">
          {item.name.trim().slice(0, 1)}
        </span>
      ) : (
        <Icon className={big ? "size-5" : "size-4"} strokeWidth={1.75} />
      )}
      {vault !== undefined && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-background"
          style={{ background: `var(--vault-${vault})` }}
        />
      )}
    </span>
  )
}

/** The line under an item's name: what tells two similar items apart. */
export function subtitleOf(item: VaultItem) {
  if (item.error) return "Could not be decrypted"
  if (item.login)
    return (
      item.login.username ||
      item.login.uris[0]?.uri.replace(/^https?:\/\//, "") ||
      "Login"
    )
  if (item.card)
    return (
      [
        item.card.brand,
        item.card.number ? `•••• ${item.card.number.slice(-4)}` : null,
      ]
        .filter(Boolean)
        .join(" ") || "Card"
    )
  if (item.identity)
    return (
      [item.identity.firstName, item.identity.lastName]
        .filter(Boolean)
        .join(" ") ||
      item.identity.email ||
      "Identity"
    )
  if (item.sshKey) return item.sshKey.keyFingerprint || "SSH key"
  // A note's text is often the secret itself, so the list never previews it.
  return "Secure note"
}
