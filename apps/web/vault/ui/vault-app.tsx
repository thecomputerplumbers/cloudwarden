"use client"

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { normalizeEmail } from "../crypto/kdf.ts"
import * as vault from "../store.ts"
import { SignIn, Unlock } from "./auth.tsx"
import { navigate, parseLink, useLinkHash } from "./links.ts"
import { CreateAccount, StartSignup } from "./onboarding.tsx"
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
  const hash = useLinkHash()
  const link = useMemo(() => parseLink(hash), [hash])
  useEffect(() => vault.restore(), [])
  useEffect(() => {
    if (link?.kind !== "unsupported") return
    navigate(null)
    toast(
      "That link is for a screen this vault does not have yet. Use a Bitwarden app for now."
    )
  }, [link])
  // Once signed in, an invitation is accepted for the account it was sent to.
  const accepted = useRef<string | null>(null)
  useEffect(() => {
    if (state.status !== "unlocked" || !link) return
    navigate(null)
    if (link.kind !== "invite" || accepted.current === link.token) return
    accepted.current = link.token
    if (state.email !== normalizeEmail(link.email))
      return void toast(
        `That invitation is for ${link.email}. Sign in with that account to accept it.`
      )
    vault
      .acceptInvite(link)
      .then(() =>
        toast(
          `You joined ${link.orgName}. Its items appear once an admin confirms you.`
        )
      )
      .catch((error: unknown) =>
        toast(
          `Couldn't accept the invitation: ${error instanceof Error ? error.message : String(error)}`
        )
      )
  }, [state.status, state.email, link])
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
      ) : state.status === "loading" && state.items.length === 0 ? (
        <VaultLoading message="Decrypting your vault" />
      ) : link?.kind === "signup" ? (
        <StartSignup
          onToken={(email, token) =>
            navigate({ kind: "finish-signup", email, token })
          }
          onBack={() => navigate(null)}
        />
      ) : link?.kind === "finish-signup" ? (
        <CreateAccount
          email={link.email}
          verificationToken={link.token}
          onCreated={() => navigate(null)}
          onBack={() => navigate({ kind: "signup" })}
        />
      ) : link?.kind === "invite" && !link.existingUser ? (
        <CreateAccount
          email={link.email}
          invite={link}
          // Signing in accepts the invitation; if it fails, sign in by hand.
          onCreated={() => navigate({ ...link, existingUser: true })}
          onBack={() => navigate(null)}
        />
      ) : state.status === "locked" ? (
        <Unlock
          notice={
            link?.kind === "invite"
              ? `Unlock to join ${link.orgName}.`
              : undefined
          }
        />
      ) : (
        <SignIn
          // Remount once the link is read, so the invited email fills in.
          key={link?.kind === "invite" ? link.email : ""}
          email={link?.kind === "invite" ? link.email : undefined}
          notice={
            link?.kind === "invite"
              ? `Sign in to join ${link.orgName}.`
              : undefined
          }
          onCreateAccount={() => navigate({ kind: "signup" })}
        />
      )}
      <Toaster />
    </>
  )
}
