"use client"

import { lazy, Suspense, useEffect, useState } from "react"
import * as vault from "../store.ts"
import { SignIn, Unlock } from "./auth.tsx"
import { Toaster, toast } from "./toast.tsx"
import { VaultLoading } from "./vault-loading.tsx"

const loadUnlocked = () => import("./unlocked-vault.tsx")
const Unlocked = lazy(() =>
  loadUnlocked().then(({ Unlocked }) => ({ default: Unlocked }))
)

export function VaultApp() {
  const state = vault.useVault()
  const [loadedVault, setLoadedVault] = useState<
    typeof import("./unlocked-vault.tsx").Unlocked | null
  >(null)
  const VaultView = loadedVault ?? Unlocked
  useEffect(() => {
    // Emails still carry Bitwarden web vault links (#/accept-organization,
    // #/finish-signup, ...), whose screens this vault does not have yet.
    if (window.location.hash.startsWith("#/")) {
      history.replaceState(null, "", window.location.pathname)
      toast(
        "That link is for a screen this vault does not have yet. Use a Bitwarden app for now."
      )
    }
    vault.restore()
  }, [])
  // Fetch the unlocked UI while authentication and key derivation are running.
  useEffect(() => {
    if (state.status !== "loading" && state.status !== "unlocked") return
    let active = true
    void loadUnlocked()
      .then(({ Unlocked }) => {
        if (active) setLoadedVault(() => Unlocked)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [state.status])
  return (
    <>
      {state.status === "unlocked" ? (
        <Suspense fallback={<VaultLoading message="Opening your vault" />}>
          <VaultView />
        </Suspense>
      ) : state.status === "locked" ? (
        <Unlock />
      ) : state.status === "loading" && state.items.length === 0 ? (
        <VaultLoading message="Decrypting your vault" />
      ) : (
        <SignIn />
      )}
      <Toaster />
    </>
  )
}
