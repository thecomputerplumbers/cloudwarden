import { cn } from "@workspace/ui/lib/utils"
import {
  CreditCardIcon,
  FileQuestionIcon,
  IdCardIcon,
  KeyRoundIcon,
  StickyNoteIcon,
  TerminalSquareIcon,
} from "lucide-react"
import type { VaultItem } from "../crypto/cipher.ts"

const ICONS = {
  login: KeyRoundIcon,
  card: CreditCardIcon,
  identity: IdCardIcon,
  note: StickyNoteIcon,
  sshKey: TerminalSquareIcon,
  unknown: FileQuestionIcon,
}

/** A login shows its initial; other kinds show their icon. Tinted with its vault's color. */
export function ItemIcon({
  item,
  color,
  size = "md",
}: {
  item: VaultItem
  color: number
  size?: "md" | "lg"
}) {
  const Icon = ICONS[item.kind]
  const big = size === "lg"
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl font-semibold uppercase",
        big ? "size-12 text-lg" : "size-9 text-sm"
      )}
      style={{
        background: `color-mix(in oklch, var(--vault-${color}) 16%, transparent)`,
        color: `var(--vault-${color})`,
      }}
    >
      {item.kind === "login" && item.name ? (
        item.name.trim().slice(0, 1)
      ) : (
        <Icon className={big ? "size-5" : "size-4"} />
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
  return item.notes?.split("\n")[0]?.slice(0, 80) || "Secure note"
}
