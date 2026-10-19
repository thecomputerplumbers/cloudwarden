import { VaultApp } from "@/vault/ui/vault-app"

export const metadata = { title: "Vault" }

/** The native vault. Everything runs in the browser: keys and decrypted items never reach the server. */
export default function VaultPage() {
  return <VaultApp />
}
