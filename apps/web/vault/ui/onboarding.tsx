"use client"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Spinner } from "@workspace/ui/components/spinner"
import { MailCheckIcon } from "lucide-react"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import * as api from "../api.ts"
import * as vault from "../store.ts"
import { AuthFrame, ErrorLine, Notice } from "./auth.tsx"

const MIN_LENGTH = 12

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

function Heading({ title, detail }: { title: string; detail: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h2 className="text-2xl font-bold tracking-[-0.02em] font-wide">
        {title}
      </h2>
      <p className="text-sm text-muted-foreground">{detail}</p>
    </div>
  )
}

function Field({
  id,
  label,
  hint,
  ...input
}: {
  id: string
  label: string
  hint?: string
} & React.ComponentProps<typeof Input>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="h-10"
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...input}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

function BackLink({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="w-full text-center text-sm text-muted-foreground hover:text-foreground"
    >
      {label}
    </button>
  )
}

/** First step of signing up: the email to verify, and a name. */
export function StartSignup({
  onToken,
  onBack,
}: {
  /** The server does not verify email first and returned a registration token. */
  onToken: (email: string, token: string) => void
  onBack: () => void
}) {
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const token = await api.startSignup(email.trim(), name.trim())
      if (typeof token === "string" && token) onToken(email.trim(), token)
      else setSent(true)
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  if (sent)
    return (
      <AuthFrame>
        <div className="space-y-6 text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-lg bg-brand-soft">
            <MailCheckIcon className="size-6 text-primary" />
          </span>
          <Heading
            title="Check your email"
            detail={
              <>
                We sent a link to <strong>{email.trim()}</strong>. Open it
                within 15 minutes to choose your master password.
              </>
            }
          />
          <BackLink onBack={onBack} label="Back to sign in" />
        </div>
      </AuthFrame>
    )

  return (
    <AuthFrame>
      <form onSubmit={submit} className="space-y-6">
        <Heading
          title="Create an account"
          detail="We'll email you a link to set your master password."
        />
        <Field
          id="cw-signup-email"
          label="Email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          maxLength={254}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          id="cw-signup-name"
          label="Name"
          autoComplete="name"
          maxLength={50}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <ErrorLine text={error} />
        <Button type="submit" size="lg" className="h-10 w-full" disabled={busy}>
          {busy ? <Spinner /> : null}
          Continue
        </Button>
        <BackLink onBack={onBack} label="Already have an account? Sign in" />
      </form>
    </AuthFrame>
  )
}

/**
 * Choosing the master password, which finishes creating the account. Reached
 * from a verified sign-up link or from an invitation to an organization.
 */
export function CreateAccount({
  email,
  verificationToken,
  invite,
  onCreated,
  onBack,
}: {
  email: string
  verificationToken?: string
  invite?: { orgName: string; memberId: string; token: string }
  onCreated: () => void
  onBack: () => void
}) {
  const [checked, setChecked] = useState<"checking" | "ok" | "expired">(
    verificationToken ? "checking" : "ok"
  )
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [hint, setHint] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!verificationToken) return
    let active = true
    api
      .checkSignupLink(email, verificationToken)
      .then(() => active && setChecked("ok"))
      .catch(() => active && setChecked("expired"))
    return () => {
      active = false
    }
  }, [email, verificationToken])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (password.length < MIN_LENGTH)
      return setError(
        `Use at least ${MIN_LENGTH} characters for your master password.`
      )
    if (password !== confirm)
      return setError("The two master passwords do not match.")
    if (hint && hint.trim() === password)
      return setError("Your hint can't be your master password.")
    setBusy(true)
    try {
      await vault.createAccount({
        email,
        name: name.trim(),
        password,
        hint: hint.trim(),
        ...(verificationToken
          ? { emailVerificationToken: verificationToken }
          : {}),
        ...(invite
          ? { invite: { memberId: invite.memberId, token: invite.token } }
          : {}),
      })
      onCreated()
    } catch (failure) {
      setError(message(failure))
      setBusy(false)
    }
  }

  if (checked !== "ok")
    return (
      <AuthFrame>
        {checked === "checking" ? (
          <div className="flex justify-center">
            <Spinner />
          </div>
        ) : (
          <div className="space-y-6">
            <Heading
              title="This link has expired"
              detail="Sign-up links work for 15 minutes. Start again and we'll send a new one."
            />
            <BackLink onBack={onBack} label="Start again" />
          </div>
        )}
      </AuthFrame>
    )

  return (
    <AuthFrame>
      <form onSubmit={submit} className="space-y-5">
        <Heading
          title={invite ? `Join ${invite.orgName}` : "Set your master password"}
          detail={
            <>
              Creating an account for <strong>{email}</strong>.
            </>
          }
        />
        <Notice>
          Your master password encrypts your vault. Nobody can reset it for you,
          so choose one you'll remember.
        </Notice>
        {invite ? (
          <Field
            id="cw-new-name"
            label="Name"
            autoComplete="name"
            maxLength={50}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        ) : null}
        <Field
          id="cw-new-password"
          label="Master password"
          type="password"
          autoComplete="new-password"
          autoFocus
          required
          hint={`At least ${MIN_LENGTH} characters.`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Field
          id="cw-new-confirm"
          label="Confirm master password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <Field
          id="cw-new-hint"
          label="Master password hint (optional)"
          maxLength={50}
          hint="Anyone who knows your email can request this hint."
          value={hint}
          onChange={(e) => setHint(e.target.value)}
        />
        <ErrorLine text={error} />
        <Button type="submit" size="lg" className="h-10 w-full" disabled={busy}>
          {busy ? <Spinner /> : null}
          Create account
        </Button>
        <BackLink onBack={onBack} label="Cancel" />
      </form>
    </AuthFrame>
  )
}
