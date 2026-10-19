"use client"

import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Spinner } from "@workspace/ui/components/spinner"
import { formatRelativeTime } from "@workspace/ui-data/lib/format"
import { cn } from "@workspace/ui/lib/utils"
import {
  ArrowLeftIcon,
  GaugeIcon,
  DownloadIcon,
  KeyRoundIcon,
  LifeBuoyIcon,
  MailIcon,
  MonitorSmartphoneIcon,
  SmartphoneIcon,
  UploadIcon,
  UsbIcon,
} from "lucide-react"
import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import { renderSVG } from "uqr"
import * as api from "../api.ts"
import type { KdfConfig } from "../crypto/kdf.ts"
import * as vault from "../store.ts"
import * as transfer from "../transfer.ts"
import { copy, toast } from "./toast.tsx"

const MIN_PASSWORD = 12

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

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

/** A labelled input, wired to its label and hint. */
function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & React.ComponentProps<typeof Input>) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        className="h-9"
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

/** Runs a form's action, keeping its error in the dialog. */
function useAction(action: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (event?: FormEvent) => {
    event?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, run }
}

function SettingsDialog({
  title,
  description,
  onClose,
  children,
}: {
  title: string
  description: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="pr-8">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription render={<div />}>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

function Footer({
  busy,
  label,
  onClose,
  destructive,
}: {
  busy: boolean
  label: string
  onClose: () => void
  destructive?: boolean
}) {
  return (
    <DialogFooter>
      <Button type="button" variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button
        type="submit"
        disabled={busy}
        variant={destructive ? "destructive" : "default"}
      >
        {busy ? <Spinner /> : null}
        {label}
      </Button>
    </DialogFooter>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h2 className="text-base font-semibold tracking-[-0.01em] font-wide">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="divide-y overflow-hidden rounded-md border bg-card">
        {children}
      </div>
    </section>
  )
}

function Row({
  icon,
  title,
  detail,
  badge,
  action,
}: {
  icon?: ReactNode
  title: ReactNode
  detail?: ReactNode
  badge?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-3">
      {icon ? (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-1 text-muted-foreground">
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {title}
          {badge}
        </p>
        {detail ? (
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 gap-1">{action}</div> : null}
    </div>
  )
}

const describeKdf = (kdf: KdfConfig) =>
  kdf.kdf === 0
    ? `PBKDF2-SHA256, ${kdf.iterations.toLocaleString()} iterations`
    : `Argon2id, ${kdf.iterations} iterations, ${kdf.memory} MiB, ${kdf.parallelism} threads`

// Master password ----------------------------------------------------------

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [hint, setHint] = useState("")
  const { busy, error, setError, run } = useAction(async () => {
    await vault.changeMasterPassword({
      current,
      next,
      hint: hint.trim() || null,
    })
    toast("Master password changed. Your other devices were signed out.")
    onClose()
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (next.length < MIN_PASSWORD)
      return setError(
        `Use at least ${MIN_PASSWORD} characters for your master password.`
      )
    if (next !== confirm)
      return setError("The two new master passwords do not match.")
    if (next === current)
      return setError("That is already your master password.")
    if (hint.trim() && hint.trim() === next)
      return setError("Your hint can't be your master password.")
    void run()
  }
  return (
    <SettingsDialog
      title="Change master password"
      description="Your vault stays as it is; only the key that unlocks it changes. Every other device is signed out."
      onClose={onClose}
    >
      <form onSubmit={submit} className="grid gap-4">
        <Field
          label="Current master password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <Field
          label="New master password"
          type="password"
          autoComplete="new-password"
          required
          hint={`At least ${MIN_PASSWORD} characters.`}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <Field
          label="Confirm new master password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <Field
          label="Master password hint (optional)"
          maxLength={50}
          value={hint}
          onChange={(e) => setHint(e.target.value)}
        />
        <ErrorLine text={error} />
        <Footer busy={busy} label="Change password" onClose={onClose} />
      </form>
    </SettingsDialog>
  )
}

function KdfDialog({ onClose }: { onClose: () => void }) {
  const kdf = vault.currentKdf()
  const [type, setType] = useState<0 | 1>(kdf.kdf)
  const [iterations, setIterations] = useState(
    String(kdf.kdf === 0 ? kdf.iterations : 600_000)
  )
  const [argonIterations, setArgonIterations] = useState(
    String(kdf.kdf === 1 ? kdf.iterations : 3)
  )
  const [memory, setMemory] = useState(String(kdf.kdf === 1 ? kdf.memory : 64))
  const [parallelism, setParallelism] = useState(
    String(kdf.kdf === 1 ? kdf.parallelism : 4)
  )
  const [password, setPassword] = useState("")
  const next = (): KdfConfig | string => {
    const number = (value: string) => Number.parseInt(value, 10)
    if (type === 0) {
      const count = number(iterations)
      return count >= 600_000 && count <= 2_000_000
        ? { kdf: 0, iterations: count }
        : "Use between 600,000 and 2,000,000 iterations."
    }
    const [i, m, p] = [
      number(argonIterations),
      number(memory),
      number(parallelism),
    ]
    if (!(i >= 2 && i <= 10)) return "Use between 2 and 10 iterations."
    if (!(m >= 16 && m <= 1024)) return "Use between 16 and 1,024 MiB."
    if (!(p >= 1 && p <= 16)) return "Use between 1 and 16 threads."
    return { kdf: 1, iterations: i, memory: m, parallelism: p }
  }
  const { busy, error, setError, run } = useAction(async () => {
    const settings = next() as KdfConfig
    await vault.changeMasterPassword({
      current: password,
      next: password,
      hint: undefined,
      kdf: settings,
    })
    toast("Key derivation updated. Your other devices were signed out.")
    onClose()
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const settings = next()
    if (typeof settings === "string") return setError(settings)
    void run()
  }
  return (
    <SettingsDialog
      title="Key derivation"
      description="How your master password is stretched into a key. Stronger settings slow down guessing, and unlocking on slower devices."
      onClose={onClose}
    >
      <form onSubmit={submit} className="grid gap-4">
        <div
          role="radiogroup"
          aria-label="Algorithm"
          className="grid grid-cols-2 gap-1 rounded-md bg-surface-1 p-1"
        >
          {(
            [
              [0, "PBKDF2-SHA256"],
              [1, "Argon2id"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={type === value}
              onClick={() => setType(value)}
              className={cn(
                "h-8 rounded text-sm transition-colors",
                type === value
                  ? "bg-background font-medium shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {type === 0 ? (
          <Field
            label="Iterations"
            inputMode="numeric"
            value={iterations}
            hint="600,000 is Bitwarden's default."
            onChange={(e) => setIterations(e.target.value)}
          />
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <Field
              label="Iterations"
              inputMode="numeric"
              value={argonIterations}
              onChange={(e) => setArgonIterations(e.target.value)}
            />
            <Field
              label="Memory (MiB)"
              inputMode="numeric"
              value={memory}
              onChange={(e) => setMemory(e.target.value)}
            />
            <Field
              label="Threads"
              inputMode="numeric"
              value={parallelism}
              onChange={(e) => setParallelism(e.target.value)}
            />
          </div>
        )}
        <Field
          label="Master password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorLine text={error} />
        <Footer busy={busy} label="Save" onClose={onClose} />
      </form>
    </SettingsDialog>
  )
}

// Import and export ---------------------------------------------------------

type ExportFormat = "json" | "protected" | "csv"

const EXPORT_FORMATS: { id: ExportFormat; label: string; detail: string }[] = [
  {
    id: "protected",
    label: "JSON, password-protected",
    detail: "Encrypted with a password you choose. Opens in Bitwarden too.",
  },
  {
    id: "json",
    label: "JSON",
    detail: "Unencrypted. Anyone with the file can read every password.",
  },
  {
    id: "csv",
    label: "CSV",
    detail: "Unencrypted, logins and secure notes only.",
  },
]

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>("protected")
  const [filePassword, setFilePassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [password, setPassword] = useState("")
  const { busy, error, setError, run } = useAction(async () => {
    await api.verifyPassword(
      await vault.sessionToken(),
      await vault.masterPasswordHash(password)
    )
    const { items, folders } = await vault.personalVault()
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")
    if (format === "csv")
      download(
        `cloudwarden_export_${stamp}.csv`,
        transfer.exportCsv(items, folders),
        "text/csv"
      )
    else
      download(
        `cloudwarden_export_${stamp}.json`,
        format === "json"
          ? transfer.exportJson(items, folders)
          : await transfer.exportProtectedJson(items, folders, filePassword),
        "application/json"
      )
    toast(`Exported ${items.length} items.`)
    onClose()
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (format === "protected") {
      if (filePassword.length < 8)
        return setError("Use at least 8 characters for the file password.")
      if (filePassword !== confirmPassword)
        return setError("The two file passwords do not match.")
    }
    void run()
  }
  return (
    <SettingsDialog
      title="Export vault"
      description="Your personal vault's items and folders, in Bitwarden's format. Organization items stay with their organization."
      onClose={onClose}
    >
      <form onSubmit={submit} className="grid gap-4">
        <div role="radiogroup" aria-label="Format" className="grid gap-2">
          {EXPORT_FORMATS.map((entry) => (
            <label
              key={entry.id}
              className={cn(
                "flex cursor-pointer gap-3 rounded-md border px-3 py-2.5 transition-colors",
                format === entry.id && "border-primary bg-brand-soft"
              )}
            >
              <input
                type="radio"
                name="cw-export-format"
                checked={format === entry.id}
                onChange={() => setFormat(entry.id)}
                className="mt-1 accent-[var(--primary)]"
              />
              <span>
                <span className="block text-sm font-medium">{entry.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {entry.detail}
                </span>
              </span>
            </label>
          ))}
        </div>
        {format === "protected" ? (
          <>
            <Field
              label="File password"
              type="password"
              autoComplete="new-password"
              required
              value={filePassword}
              onChange={(e) => setFilePassword(e.target.value)}
            />
            <Field
              label="Confirm file password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </>
        ) : null}
        <Field
          label="Master password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorLine text={error} />
        <Footer busy={busy} label="Export" onClose={onClose} />
      </form>
    </SettingsDialog>
  )
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<{ name: string; content: string } | null>(
    null
  )
  const [needsPassword, setNeedsPassword] = useState(false)
  const [filePassword, setFilePassword] = useState("")
  const [parsed, setParsed] = useState<transfer.ImportResult | null>(null)
  const read = useAction(async () => {
    if (!file) throw new Error("Choose a file to import.")
    try {
      setParsed(
        await transfer.parseImport(
          file.content,
          needsPassword ? filePassword : undefined
        )
      )
    } catch (failure) {
      if (failure instanceof transfer.ExportPasswordNeeded)
        return setNeedsPassword(true)
      throw failure
    }
  })
  const save = useAction(async () => {
    await vault.importItems(parsed!.items)
    toast(`Imported ${parsed!.items.length} items.`)
    onClose()
  })
  const folders = new Set(
    parsed?.items.map((item) => item.folder).filter(Boolean)
  ).size
  return (
    <SettingsDialog
      title="Import items"
      description="From a Bitwarden, Vaultwarden or Cloudwarden export (.json or .csv). Items go into your personal vault, encrypted here first."
      onClose={onClose}
    >
      {!parsed ? (
        <form onSubmit={read.run} className="grid gap-4">
          <Field
            label="Export file"
            type="file"
            accept=".json,.csv,application/json,text/csv"
            required
            className="h-auto py-1.5"
            onChange={async (e) => {
              const chosen = e.target.files?.[0]
              setNeedsPassword(false)
              setFile(
                chosen
                  ? { name: chosen.name, content: await chosen.text() }
                  : null
              )
            }}
          />
          {needsPassword ? (
            <Field
              label="File password"
              type="password"
              autoFocus
              required
              hint="This export is password-protected."
              value={filePassword}
              onChange={(e) => setFilePassword(e.target.value)}
            />
          ) : null}
          <ErrorLine text={read.error} />
          <Footer busy={read.busy} label="Continue" onClose={onClose} />
        </form>
      ) : (
        <form onSubmit={save.run} className="grid gap-4">
          <p className="text-sm">
            <strong>{parsed.items.length}</strong>{" "}
            {parsed.items.length === 1 ? "item" : "items"}
            {folders
              ? ` in ${folders} ${folders === 1 ? "folder" : "folders"}`
              : ""}{" "}
            from <span className="font-mono text-xs">{file?.name}</span>.
            {parsed.skipped
              ? ` ${parsed.skipped} of a kind this vault doesn't hold will be left out.`
              : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            Folders with the same name are reused. Importing twice makes
            duplicates.
          </p>
          <ErrorLine text={save.error} />
          <Footer
            busy={save.busy}
            label={`Import ${parsed.items.length}`}
            onClose={onClose}
          />
        </form>
      )}
    </SettingsDialog>
  )
}

// Two-step login -----------------------------------------------------------

/** Asks for the master password, then hands its hash to the next step. */
function PasswordStep({
  onVerified,
  onClose,
}: {
  onVerified: (hash: string) => Promise<void>
  onClose: () => void
}) {
  const [password, setPassword] = useState("")
  const { busy, error, run } = useAction(async () =>
    onVerified(await vault.masterPasswordHash(password))
  )
  return (
    <form onSubmit={run} className="grid gap-4">
      <Field
        label="Master password"
        type="password"
        autoComplete="current-password"
        autoFocus
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <ErrorLine text={error} />
      <Footer busy={busy} label="Continue" onClose={onClose} />
    </form>
  )
}

function Disable({
  label,
  onDisable,
}: {
  label: string
  onDisable: () => Promise<void>
}) {
  const { busy, error, run } = useAction(onDisable)
  return (
    <div className="grid gap-2">
      <ErrorLine text={error} />
      <Button
        type="button"
        variant="outline"
        className="text-destructive"
        disabled={busy}
        onClick={() => void run()}
      >
        {busy ? <Spinner /> : null}
        {label}
      </Button>
    </div>
  )
}

function AuthenticatorDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void
  onChanged: () => void
}) {
  const state = vault.useVault()
  const [setup, setSetup] = useState<
    | ({ enabled: boolean; key: string } & { userVerificationToken: string })
    | null
  >(null)
  const [code, setCode] = useState("")
  const { busy, error, run } = useAction(async () => {
    await api.enableAuthenticator(await vault.sessionToken(), {
      key: setup!.key,
      token: code.replace(/\s/g, ""),
      userVerificationToken: setup!.userVerificationToken,
    })
    toast("Authenticator app turned on.")
    onChanged()
    onClose()
  })
  const uri = setup
    ? `otpauth://totp/${encodeURIComponent(`Cloudwarden:${state.email}`)}?secret=${setup.key}&issuer=Cloudwarden`
    : ""
  return (
    <SettingsDialog
      title="Authenticator app"
      description="Codes from an app such as 2FAS, Aegis, or Google Authenticator, asked for when you sign in."
      onClose={onClose}
    >
      {!setup ? (
        <PasswordStep
          onClose={onClose}
          onVerified={async (hash) =>
            setSetup(
              await api.getAuthenticator(await vault.sessionToken(), hash)
            )
          }
        />
      ) : setup.enabled ? (
        <div className="grid gap-4">
          <p className="text-sm">Your authenticator app is turned on.</p>
          <Disable
            label="Turn off"
            onDisable={async () => {
              await api.disableTwoFactor(await vault.sessionToken(), {
                type: 0,
                userVerificationToken: setup.userVerificationToken,
              })
              toast("Authenticator app turned off.")
              onChanged()
              onClose()
            }}
          />
        </div>
      ) : (
        <form onSubmit={run} className="grid gap-4">
          <div
            className="mx-auto size-44 rounded-md bg-white p-2 [&_svg]:size-full"
            role="img"
            aria-label="QR code for your authenticator app"
            // uqr renders a self-contained SVG from the otpauth URI.
            dangerouslySetInnerHTML={{
              __html: renderSVG(uri, { border: 1 }),
            }}
          />
          <div className="space-y-1 text-center">
            <p className="text-xs text-muted-foreground">
              Scan it, or enter this key:
            </p>
            <button
              type="button"
              onClick={() => copy(setup.key, "Key", true)}
              className="font-mono text-sm tracking-wider break-all hover:text-primary"
            >
              {setup.key.match(/.{1,4}/g)?.join(" ")}
            </button>
          </div>
          <Field
            label="Code from the app"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="h-10 text-center font-mono text-lg tracking-[0.3em]"
          />
          <ErrorLine text={error} />
          <Footer busy={busy} label="Turn on" onClose={onClose} />
        </form>
      )}
    </SettingsDialog>
  )
}

function EmailDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void
  onChanged: () => void
}) {
  const state = vault.useVault()
  const [setup, setSetup] = useState<{
    enabled: boolean
    email: string | null
    userVerificationToken: string
  } | null>(null)
  const [email, setEmail] = useState(state.email ?? "")
  const [sent, setSent] = useState(false)
  const [code, setCode] = useState("")
  const send = useAction(async () => {
    await api.sendEmailFactorCode(await vault.sessionToken(), {
      email: email.trim(),
      userVerificationToken: setup!.userVerificationToken,
    })
    setSent(true)
  })
  const confirm = useAction(async () => {
    await api.enableEmailFactor(await vault.sessionToken(), {
      email: email.trim(),
      token: code.replace(/\s/g, ""),
      userVerificationToken: setup!.userVerificationToken,
    })
    toast("Email codes turned on.")
    onChanged()
    onClose()
  })
  return (
    <SettingsDialog
      title="Email"
      description="A code sent to your email each time you sign in."
      onClose={onClose}
    >
      {!setup ? (
        <PasswordStep
          onClose={onClose}
          onVerified={async (hash) =>
            setSetup(await api.getEmailFactor(await vault.sessionToken(), hash))
          }
        />
      ) : setup.enabled ? (
        <div className="grid gap-4">
          <p className="text-sm">
            Codes go to <strong>{setup.email}</strong>.
          </p>
          <Disable
            label="Turn off"
            onDisable={async () => {
              await api.disableTwoFactor(await vault.sessionToken(), {
                type: 1,
                userVerificationToken: setup.userVerificationToken,
              })
              toast("Email codes turned off.")
              onChanged()
              onClose()
            }}
          />
        </div>
      ) : !sent ? (
        <form onSubmit={send.run} className="grid gap-4">
          <Field
            label="Send codes to"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <ErrorLine text={send.error} />
          <Footer busy={send.busy} label="Send code" onClose={onClose} />
        </form>
      ) : (
        <form onSubmit={confirm.run} className="grid gap-4">
          <p className="text-sm">
            Enter the code we sent to <strong>{email.trim()}</strong>.
          </p>
          <Field
            label="Code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="h-10 text-center font-mono text-lg tracking-[0.3em]"
          />
          <ErrorLine text={confirm.error} />
          <Footer busy={confirm.busy} label="Turn on" onClose={onClose} />
        </form>
      )}
    </SettingsDialog>
  )
}

const fromBase64Url = (value: string) =>
  Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0)
  )
const toBase64Url = (buffer: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")

/** Registers a security key from the server's options (WebAuthn JSON, base64url). */
async function createCredential(options: Record<string, unknown>) {
  const { status: _status, errorMessage: _error, ...json } = options
  const publicKey = json as unknown as PublicKeyCredentialCreationOptionsJSON
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...publicKey,
      challenge: fromBase64Url(publicKey.challenge),
      user: { ...publicKey.user, id: fromBase64Url(publicKey.user.id) },
      excludeCredentials: (publicKey.excludeCredentials ?? []).map((entry) => ({
        ...entry,
        id: fromBase64Url(entry.id),
      })),
    } as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null
  if (!credential) throw new Error("No security key was registered.")
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  }
}

function SecurityKeysDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void
  onChanged: () => void
}) {
  const [setup, setSetup] = useState<{
    keys: api.SecurityKey[]
    userVerificationToken: string
  } | null>(null)
  const [name, setName] = useState("")
  const add = useAction(async () => {
    const token = await vault.sessionToken()
    const slot = [1, 2, 3, 4, 5].find(
      (id) => !setup!.keys.some((key) => key.id === id)
    )
    if (!slot) throw new Error("You can register up to five security keys.")
    const options = await api.securityKeyChallenge(
      token,
      setup!.userVerificationToken
    )
    const deviceResponse = await createCredential(options).catch(
      (error: unknown) => {
        throw new Error(
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "The security key prompt was cancelled or timed out."
            : message(error)
        )
      }
    )
    const result = await api.addSecurityKey(token, {
      id: slot,
      name: name.trim(),
      deviceResponse,
      userVerificationToken: setup!.userVerificationToken,
    })
    setSetup({ ...setup!, keys: result.keys })
    setName("")
    toast("Security key added. Your other devices were signed out.")
    onChanged()
  })
  const remove = async (id: number) => {
    const result = await api.removeSecurityKey(await vault.sessionToken(), {
      id,
      userVerificationToken: setup!.userVerificationToken,
    })
    setSetup({ ...setup!, keys: result.keys })
    toast("Security key removed.")
    onChanged()
  }
  return (
    <SettingsDialog
      title="Security keys"
      description="A hardware key or passkey, asked for when you sign in. Up to five."
      onClose={onClose}
    >
      {!setup ? (
        <PasswordStep
          onClose={onClose}
          onVerified={async (hash) =>
            setSetup(
              await api.getSecurityKeys(await vault.sessionToken(), hash)
            )
          }
        />
      ) : (
        <div className="grid gap-4">
          {setup.keys.length ? (
            <ul className="divide-y rounded-md border">
              {setup.keys.map((key) => (
                <li
                  key={key.id}
                  className="flex items-center gap-3 px-3 py-2 text-sm"
                >
                  <UsbIcon className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{key.name}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() =>
                      void remove(key.id).catch((error: unknown) =>
                        toast(message(error))
                      )
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {setup.keys.length < 5 ? (
            <form onSubmit={add.run} className="grid gap-4">
              <Field
                label="Name for a new key"
                required
                maxLength={100}
                placeholder="YubiKey 5C"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <ErrorLine text={add.error} />
              <Footer busy={add.busy} label="Add key" onClose={onClose} />
            </form>
          ) : (
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          )}
        </div>
      )}
    </SettingsDialog>
  )
}

function RecoveryDialog({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState<string | null>(null)
  return (
    <SettingsDialog
      title="Recovery code"
      description="If you lose your second factor, this code signs you in once and turns two-step login off. Keep it somewhere safe, away from your vault."
      onClose={onClose}
    >
      {!code ? (
        <PasswordStep
          onClose={onClose}
          onVerified={async (hash) =>
            setCode(
              (await api.recoveryCode(await vault.sessionToken(), hash)).code
            )
          }
        />
      ) : (
        <div className="grid gap-4">
          <button
            type="button"
            onClick={() => copy(code, "Recovery code", true)}
            className="rounded-md border bg-surface-1 px-4 py-3 text-center font-mono text-lg tracking-wider break-all hover:text-primary"
          >
            {code.match(/.{1,4}/g)?.join(" ")}
          </button>
          <DialogFooter>
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </DialogFooter>
        </div>
      )}
    </SettingsDialog>
  )
}

// Devices ------------------------------------------------------------------

// Bitwarden's device types.
const DEVICE_KINDS: [number[], string][] = [
  [[0, 1, 15], "Mobile app"],
  [[2, 3, 4, 5, 19, 20], "Browser extension"],
  [[6, 7, 8, 16], "Desktop app"],
  [[9, 10, 11, 12, 13, 14, 17, 18, 26], "Web browser"],
  [[23, 24, 25], "Command line"],
]
const deviceKind = (type: number) =>
  DEVICE_KINDS.find(([types]) => types.includes(type))?.[1] ?? "Device"

// ---------------------------------------------------------------------------

async function loadSecurity() {
  const token = await vault.sessionToken()
  const [factors, list] = await Promise.all([
    api.twoFactorProviders(token),
    api.devices(token),
  ])
  return {
    providers: new Set(
      factors.data.filter((p) => p.enabled).map((p) => p.type)
    ),
    devices: [...list.data].sort((a, b) =>
      b.lastActivityDate.localeCompare(a.lastActivityDate)
    ),
  }
}

type Open =
  | "password"
  | "kdf"
  | "authenticator"
  | "email"
  | "keys"
  | "recovery"
  | "export"
  | "import"
  | null

export function AccountSettings({ onExit }: { onExit: () => void }) {
  const state = vault.useVault()
  const [open, setOpen] = useState<Open>(null)
  const [providers, setProviders] = useState<Set<number> | null>(null)
  const [devices, setDevices] = useState<api.Device[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const here = api.deviceId()

  // Bumped after a change, to read two-step login and devices again.
  const [version, setVersion] = useState(0)
  const changed = () => setVersion((value) => value + 1)
  useEffect(() => {
    let active = true
    loadSecurity()
      .then((result) => {
        if (!active) return
        setProviders(result.providers)
        setDevices(result.devices)
        setError(null)
      })
      .catch((failure: unknown) => active && setError(message(failure)))
    return () => {
      active = false
    }
  }, [version])

  const close = () => setOpen(null)
  const status = (type: number) =>
    providers?.has(type) ? (
      <Badge variant="secondary" className="text-success">
        On
      </Badge>
    ) : null
  const manage = (type: number, which: Open) => (
    <Button
      size="sm"
      variant="outline"
      disabled={!providers}
      onClick={() => setOpen(which)}
    >
      {providers?.has(type) ? "Manage" : "Set up"}
    </Button>
  )

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="shrink-0 border-b">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3 md:px-6">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to vault"
            onClick={onExit}
          >
            <ArrowLeftIcon />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold tracking-[-0.015em] font-wide">
              Account settings
            </h1>
            <p className="truncate text-sm text-muted-foreground">
              {state.email}
            </p>
          </div>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-8 px-4 py-6 md:px-6">
          <ErrorLine text={error} />
          <Section
            title="Master password"
            description="The one password that unlocks your vault. Nobody, including your Cloudwarden admin, can recover it."
          >
            <Row
              icon={<KeyRoundIcon className="size-4" />}
              title="Master password"
              detail="Changing it signs out your other devices."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setOpen("password")}
                >
                  Change
                </Button>
              }
            />
            <Row
              icon={<GaugeIcon className="size-4" />}
              title="Key derivation"
              detail={describeKdf(vault.currentKdf())}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setOpen("kdf")}
                >
                  Change
                </Button>
              }
            />
          </Section>

          <Section
            title="Two-step login"
            description="Ask for a second factor after your master password when you sign in on a new device."
          >
            <Row
              icon={<SmartphoneIcon className="size-4" />}
              title="Authenticator app"
              badge={status(0)}
              detail="Six-digit codes from an app on your phone."
              action={manage(0, "authenticator")}
            />
            <Row
              icon={<UsbIcon className="size-4" />}
              title="Security keys"
              badge={status(7)}
              detail="A hardware key such as a YubiKey, or a passkey."
              action={manage(7, "keys")}
            />
            <Row
              icon={<MailIcon className="size-4" />}
              title="Email"
              badge={status(1)}
              detail="A code sent to your inbox."
              action={manage(1, "email")}
            />
            {providers?.size ? (
              <Row
                icon={<LifeBuoyIcon className="size-4" />}
                title="Recovery code"
                detail="Signs you in if you lose your second factor."
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setOpen("recovery")}
                  >
                    View
                  </Button>
                }
              />
            ) : null}
          </Section>

          <Section
            title="Import and export"
            description="Move items in from another password manager's Bitwarden-format export, or take a copy of your vault."
          >
            <Row
              icon={<UploadIcon className="size-4" />}
              title="Import items"
              detail="Bitwarden JSON (plain or password-protected) or CSV."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setOpen("import")}
                >
                  Import
                </Button>
              }
            />
            <Row
              icon={<DownloadIcon className="size-4" />}
              title="Export vault"
              detail="Your personal vault, as JSON or CSV."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setOpen("export")}
                >
                  Export
                </Button>
              }
            />
          </Section>

          <Section
            title="Devices"
            description="Where your account is signed in. Removing a device signs it out."
          >
            {!devices ? (
              <div className="flex justify-center p-6">
                <Spinner />
              </div>
            ) : devices.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No devices.</p>
            ) : (
              devices.map((device) => (
                <Row
                  key={device.id}
                  icon={<MonitorSmartphoneIcon className="size-4" />}
                  title={device.name}
                  badge={
                    device.identifier === here ? (
                      <Badge variant="secondary">This browser</Badge>
                    ) : null
                  }
                  detail={`${deviceKind(device.type)} · active ${formatRelativeTime(new Date(device.lastActivityDate))}`}
                  action={
                    device.identifier === here ? null : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={async () => {
                          try {
                            await api.removeDevice(
                              await vault.sessionToken(),
                              device.identifier
                            )
                            toast(`${device.name} signed out.`)
                            changed()
                          } catch (failure) {
                            toast(message(failure))
                          }
                        }}
                      >
                        Remove
                      </Button>
                    )
                  }
                />
              ))
            )}
          </Section>
        </div>
      </main>
      {open === "password" && <ChangePasswordDialog onClose={close} />}
      {open === "kdf" && <KdfDialog onClose={close} />}
      {open === "authenticator" && (
        <AuthenticatorDialog onClose={close} onChanged={changed} />
      )}
      {open === "email" && <EmailDialog onClose={close} onChanged={changed} />}
      {open === "keys" && (
        <SecurityKeysDialog onClose={close} onChanged={changed} />
      )}
      {open === "recovery" && <RecoveryDialog onClose={close} />}
      {open === "export" && <ExportDialog onClose={close} />}
      {open === "import" && <ImportDialog onClose={close} />}
    </div>
  )
}
