import type { ItemKind } from "../crypto/cipher.ts"

export const KIND_LABELS: Record<ItemKind, string> = {
  login: "Login",
  card: "Card",
  identity: "Identity",
  note: "Secure note",
  sshKey: "SSH key",
}
