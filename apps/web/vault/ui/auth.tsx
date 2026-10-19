"use client"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Spinner } from "@workspace/ui/components/spinner"
import { LockKeyholeIcon, MailIcon } from "lucide-react"
import { useState, type FormEvent, type ReactNode } from "react"
import { BrandMark, Wordmark } from "./brand.tsx"
import * as vault from "../store.ts"

const PROVIDERS: Record<number, string> = {
  0: "authenticator app",
  1: "email",
  7: "security key",
}

const POINTS = [
  ["Encrypted in this browser", "AES-256; the server stores only ciphertext"],
  ["Works with every Bitwarden app", "Desktop, mobile, browser and CLI"],
  ["Runs on your Cloudflare account", "Your Worker, your database, your keys"],
]

/**
 * The frame shared by sign-in and unlock: a graphite panel drawn like a
 * schematic, with one copper line routed through it, and a focused form.
 */
function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-background lg:grid-cols-[1fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-[oklch(0.17_0.006_265)] text-[oklch(0.95_0.004_75)] lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(oklch(1 0 0 / 4%) 1px, transparent 1px), linear-gradient(90deg, oklch(1 0 0 / 4%) 1px, transparent 1px)",
            backgroundSize: "32px 32px",
            maskImage:
              "radial-gradient(ellipse 80% 70% at 30% 40%, black, transparent)",
          }}
        />
        <svg
          aria-hidden="true"
          viewBox="0 0 640 900"
          preserveAspectRatio="xMaxYMid slice"
          className="absolute inset-0 size-full"
        >
          <path
            d="M-10 192H384a32 32 0 0 1 32 32V544a32 32 0 0 0 32 32H660"
            fill="none"
            stroke="oklch(0.7 0.13 52)"
            strokeWidth="2"
            opacity="0.55"
          />
          <circle cx="416" cy="384" r="5" fill="oklch(0.72 0.13 52)" />
        </svg>
        <Wordmark className="relative text-lg" />
        <div className="relative max-w-md space-y-8">
          <h1 className="text-[2.6rem] leading-[1.05] font-bold tracking-[-0.025em] text-balance font-wide">
            Your vault, on infrastructure you own.
          </h1>
          <dl className="space-y-4">
            {POINTS.map(([title, detail]) => (
              <div
                key={title}
                className="border-l border-[oklch(0.7_0.13_52/50%)] pl-4"
              >
                <dt className="text-[0.95rem] font-medium">{title}</dt>
                <dd className="font-mono text-xs text-[oklch(0.7_0.008_265)]">
                  {detail}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <p className="relative font-mono text-[0.7rem] tracking-[0.08em] text-[oklch(0.6_0.008_265)] uppercase">
          Zero-knowledge · Bitwarden-compatible
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
      className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
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
        <span className="text-lg font-bold tracking-[-0.01em] font-wide">
          Cloudwarden
        </span>
      </div>
      <form onSubmit={submit} className="space-y-6">
        <div className="space-y-1.5">
          <h2 className="text-2xl font-bold tracking-[-0.02em] font-wide">
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
          <span className="flex size-14 items-center justify-center rounded-lg bg-brand-soft">
            <LockKeyholeIcon className="size-6 text-primary" />
          </span>
          <div className="space-y-1">
            <h2 className="text-2xl font-bold tracking-[-0.02em] font-wide">
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
