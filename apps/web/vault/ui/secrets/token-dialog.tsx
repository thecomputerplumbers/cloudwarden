"use client"

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
import { cn } from "@workspace/ui/lib/utils"
import { CopyIcon, TriangleAlertIcon } from "lucide-react"
import { useState, type FormEvent } from "react"
import {
  message,
  newAccessToken,
  type MachineAccount,
  type Secret,
} from "../../sm-store.ts"
import { copy } from "../toast.tsx"
import { ErrorLine } from "./dialogs.tsx"

const EXPIRY = [
  { label: "Never", days: null },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
] as const

/** A random value for the reader's own bearer token, which External Secrets Operator sends to it. */
function randomReaderToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

/** The Kubernetes side, as in docs/secrets-manager.md: the reader's credentials and one ExternalSecret. */
export function kubernetesSnippet(
  token: string,
  readerToken: string,
  exampleKey: string
) {
  return `apiVersion: v1
kind: Secret
metadata:
  name: cloudwarden-secrets-reader
  namespace: cloudwarden
type: Opaque
stringData:
  CLOUDWARDEN_ACCESS_TOKEN: "${token}"
  # The reader's own bearer token; External Secrets Operator sends it. Any long random string.
  READER_TOKEN: "${readerToken}"
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: app-secrets
spec:
  refreshInterval: 1m
  secretStoreRef:
    name: cloudwarden
    kind: SecretStore
  target:
    name: app-secrets
  data:
    - secretKey: ${exampleKey}
      remoteRef:
        key: ${exampleKey}
`
}

export function TokenDialog({
  account,
  secrets,
  onClose,
}: {
  account: MachineAccount
  secrets: Secret[]
  onClose: () => void
}) {
  const [name, setName] = useState("")
  const [days, setDays] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [readerToken] = useState(randomReaderToken)
  const granted = new Set(account.access.map((grant) => grant.projectId))
  const exampleKey =
    secrets.find((secret) => granted.has(secret.projectId))?.key ??
    "DATABASE_URL"

  async function create(event: FormEvent) {
    event.preventDefault()
    if (!name.trim())
      return setError(
        "Name the token after where it will be used, like the cluster."
      )
    setBusy(true)
    setError(null)
    try {
      const expiresAt = days
        ? new Date(Date.now() + days * 86_400_000).toISOString()
        : null
      setToken(await newAccessToken(account.id, name.trim(), expiresAt))
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl">
        <DialogHeader className="pr-8">
          <DialogTitle>
            {token ? "Access token created" : "New access token"}
          </DialogTitle>
          <DialogDescription>
            {token
              ? `For ${account.name}. It can read the projects this machine account is granted.`
              : `Lets a machine, like the in-cluster reader, read the projects ${account.name} is granted.`}
          </DialogDescription>
        </DialogHeader>
        {!token ? (
          <form
            id="cw-token"
            onSubmit={create}
            className="-mx-4 min-h-0 space-y-4 overflow-y-auto border-t px-4 pt-4"
          >
            <div className="space-y-1.5">
              <Label
                htmlFor="cw-token-name"
                className="text-xs text-muted-foreground"
              >
                Name
              </Label>
              <Input
                id="cw-token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="momoney-prod external-secrets"
                className="h-9"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Expires</p>
              <div
                className="flex flex-wrap gap-1.5"
                role="radiogroup"
                aria-label="Expires"
              >
                {EXPIRY.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    role="radio"
                    aria-checked={days === option.days}
                    onClick={() => setDays(option.days)}
                    className={cn(
                      "h-8 rounded-lg border px-3 text-sm transition-colors",
                      days === option.days
                        ? "border-ring bg-brand-soft"
                        : "hover:bg-muted"
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            {!account.access.length && (
              <p className="rounded-lg bg-warning/15 px-3 py-2 text-sm">
                This machine account has no project access yet, so the token
                would read nothing. Grant a project first.
              </p>
            )}
            <ErrorLine text={error} />
          </form>
        ) : (
          <div className="-mx-4 min-h-0 space-y-4 overflow-y-auto border-t px-4 pt-4">
            <div className="flex gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
              <p>
                <span className="font-medium">
                  Copy it now. You won't see this token again.
                </span>{" "}
                It is made in your browser and only its hash is stored, so
                cloudwarden cannot show it to you later.
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Access token</p>
              <div className="flex items-center gap-2 rounded-lg border bg-surface-1 p-2 pl-3">
                <code
                  data-testid="cw-new-token"
                  className="min-w-0 flex-1 font-mono text-xs break-all"
                >
                  {token}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => copy(token, "Access token", true)}
                >
                  <CopyIcon /> Copy
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Kubernetes: the reader's Secret and an ExternalSecret
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    copy(
                      kubernetesSnippet(token, readerToken, exampleKey),
                      "Manifests",
                      true
                    )
                  }
                >
                  <CopyIcon /> Copy
                </Button>
              </div>
              <pre className="max-h-64 overflow-auto rounded-lg border bg-surface-1 p-3 font-mono text-xs leading-relaxed">
                {kubernetesSnippet(token, readerToken, exampleKey)}
              </pre>
              <p className="text-xs text-muted-foreground">
                The SecretStore that points External Secrets Operator at the
                reader is in the reader's Helm chart and
                docs/secrets-manager.md.
              </p>
            </div>
          </div>
        )}
        <DialogFooter>
          {!token ? (
            <>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" form="cw-token" disabled={busy}>
                {busy ? <Spinner /> : null}
                Create token
              </Button>
            </>
          ) : (
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
