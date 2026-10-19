"use client"

import { lazy, Suspense, useEffect, useState } from "react"
import * as vault from "../store.ts"
import { SignIn, Unlock } from "./auth.tsx"
import { Toaster } from "./toast.tsx"
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
    // Bitwarden-style links in emails (#/accept-organization, #/settings, ...)
    // belong to the web client, which now lives at /legacy/.
    if (window.location.hash.startsWith("#/")) {
      window.location.replace(`/legacy/${window.location.hash}`)
      return
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
