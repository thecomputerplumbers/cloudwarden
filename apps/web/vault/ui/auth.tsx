"use client"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Spinner } from "@workspace/ui/components/spinner"
import {
  KeyRoundIcon,
  LockKeyholeIcon,
  MailIcon,
  ShieldCheckIcon,
} from "lucide-react"
import { useState, type FormEvent, type ReactNode } from "react"
import { BrandMark, Wordmark } from "./brand.tsx"
import * as vault from "../store.ts"

const PROVIDERS: Record<number, string> = {
  0: "authenticator app",
  1: "email",
  7: "security key",
}

/** The frame shared by sign-in and unlock: a quiet brand panel and a focused form. */
function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-[oklch(0.2_0.03_250)] text-[oklch(0.95_0.01_240)] lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-70"
          style={{
            background:
              "radial-gradient(60rem 40rem at -10% -20%, oklch(0.55 0.12 195 / 55%), transparent 60%), radial-gradient(40rem 30rem at 110% 120%, oklch(0.5 0.14 280 / 40%), transparent 60%)",
          }}
        />
        <Wordmark className="relative text-lg" />
        <div className="relative max-w-md space-y-5">
          <h1 className="text-4xl leading-tight font-semibold tracking-tight text-balance">
            Every secret, one calm place.
          </h1>
          <p className="text-pretty text-[oklch(0.82_0.02_240)]">
            End-to-end encrypted in your browser before it leaves. Cloudwarden
            never sees your master password or your vault.
          </p>
          <ul className="space-y-3 text-sm text-[oklch(0.85_0.02_240)]">
            {[
              [
                ShieldCheckIcon,
                "Zero-knowledge, AES-256 and RSA, compatible with every Bitwarden app",
              ],
              [
                KeyRoundIcon,
                "Your vaults and every organization's, together or one at a time",
              ],
              [LockKeyholeIcon, "Locks itself; the keys never touch storage"],
            ].map(([Icon, text]) => {
              const I = Icon as typeof ShieldCheckIcon
              return (
                <li key={text as string} className="flex items-start gap-3">
                  <I className="mt-0.5 size-4 shrink-0 text-[oklch(0.8_0.12_192)]" />
                  {text as string}
                </li>
              )
            })}
          </ul>
        </div>
        <p className="relative text-xs text-[oklch(0.7_0.02_240)]">
          Your data stays yours.
        </p>
      </aside>
      <main className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  )
}

function ErrorLine({ text }: { text: string | null }) {
  return text ? (
    <p
      role="alert"
      className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {text}
    </p>
  ) : null
}

export function SignIn() {
  const state = vault.useVault()
  const [email, setEmail] = useState(state.email ?? "")
  const [password, setPassword] = useState("")
  const [providers, setProviders] = useState<number[] | null>(null)
  const [provider, setProvider] = useState(0)
  const [code, setCode] = useState("")
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const challenge = await vault.signIn({
        email,
        password,
        ...(providers
          ? {
              twoFactor: { provider, token: code.replace(/\s/g, ""), remember },
            }
          : {}),
      })
      if (challenge) {
        setProviders(challenge.providers)
        const first =
          challenge.providers.find((id) => id in PROVIDERS) ??
          challenge.providers[0] ??
          0
        setProvider(first)
        if (first === 1) await vault.sendEmailCode(email, password)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame>
      <div className="mb-8 flex items-center gap-3 lg:hidden">
        <BrandMark className="size-9" />
        <span className="text-lg font-semibold tracking-tight">
          Cloudwarden
        </span>
      </div>
      <form onSubmit={submit} className="space-y-6">
        <div className="space-y-1.5">
          <h2 className="text-2xl font-semibold tracking-tight">
            {providers ? "Confirm it's you" : "Sign in"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {providers
              ? `Enter the code from your ${PROVIDERS[provider] ?? "second factor"}.`
              : "Use your Cloudwarden email and master password."}
          </p>
        </div>
        {!providers ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="cw-email">Email</Label>
              <Input
                id="cw-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-10"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cw-password">Master password</Label>
              <Input
                id="cw-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-10"
              />
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <Label htmlFor="cw-code">Verification code</Label>
            <Input
              id="cw-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="h-12 text-center font-mono text-xl tracking-[0.4em]"
            />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="accent-[var(--primary)]"
              />
              Remember this browser
            </label>
            {providers.length > 1 && (
              <div className="flex flex-wrap gap-2 text-sm">
                {providers
                  .filter((id) => id !== provider && id in PROVIDERS)
                  .map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="text-primary hover:underline"
                      onClick={async () => {
                        setProvider(id)
                        if (id === 1) await vault.sendEmailCode(email, password)
                      }}
                    >
                      {id === 1 ? (
                        <MailIcon className="mr-1 inline size-3.5" />
                      ) : null}
                      Use {PROVIDERS[id]} instead
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}
        <ErrorLine text={error} />
        <Button type="submit" size="lg" className="h-10 w-full" disabled={busy}>
          {busy ? <Spinner /> : null}
          {providers ? "Verify" : "Sign in"}
        </Button>
        {providers && (
          <button
            type="button"
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
            onClick={() => (setProviders(null), setCode(""))}
          >
            Back
          </button>
        )}
      </form>
    </AuthFrame>
  )
}

export function Unlock() {
  const state = vault.useVault()
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await vault.unlock(password)
    } catch {
      setPassword("")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthFrame>
      <form onSubmit={submit} className="space-y-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-brand-soft">
            <LockKeyholeIcon className="size-6 text-primary" />
          </span>
          <div className="space-y-1">
            <h2 className="text-2xl font-semibold tracking-tight">
              Vault locked
            </h2>
            <p className="text-sm text-muted-foreground">{state.email}</p>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="cw-unlock">Master password</Label>
          <Input
            id="cw-unlock"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-10"
          />
        </div>
        <ErrorLine text={state.error} />
        <Button type="submit" size="lg" className="h-10 w-full" disabled={busy}>
          {busy ? <Spinner /> : null}
          Unlock
        </Button>
        <button
          type="button"
          onClick={() => vault.signOut()}
          className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
        >
          Sign in with another account
        </button>
      </form>
    </AuthFrame>
  )
}
