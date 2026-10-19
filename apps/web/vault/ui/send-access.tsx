"use client"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Spinner } from "@workspace/ui/components/spinner"
import {
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  LockKeyholeIcon,
} from "lucide-react"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import * as api from "../api.ts"
import { ApiError } from "../api.ts"
import {
  decryptFile,
  decryptOptional,
  decryptString,
} from "../crypto/enc-string.ts"
import type { SymmetricKey } from "../crypto/keys.ts"
import { fromBase64Url, sendKey, sendPasswordHash } from "../crypto/send.ts"
import { Wordmark } from "./brand.tsx"
import { copy } from "./toast.tsx"

/** A Send's access ID is its ID's 16 bytes, base64url. */
function sendIdOf(accessId: string) {
  const hex = Array.from(fromBase64Url(accessId), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

interface Opened {
  name: string
  text: { text: string; hidden: boolean } | null
  file: { id: string; name: string; size: string } | null
  expirationDate: string | null
  creator: string | null
  key: SymmetricKey
  passwordHash: string | null
}

async function open(
  accessId: string,
  material: Uint8Array,
  password: string | null
): Promise<Opened> {
  const [key, passwordHash] = await Promise.all([
    sendKey(material),
    password ? sendPasswordHash(password, material) : null,
  ])
  const send = await api.accessSend(accessId, passwordHash)
  return {
    name: await decryptString(send.name, key),
    text: send.text
      ? {
          text: (await decryptOptional(send.text.text, key)) ?? "",
          hidden: send.text.hidden,
        }
      : null,
    file: send.file
      ? {
          id: send.file.id,
          name: await decryptString(send.file.fileName, key),
          size: send.file.sizeName,
        }
      : null,
    expirationDate: send.expirationDate,
    creator: send.creatorIdentifier,
    key,
    passwordHash,
  }
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex h-14 items-center px-5">
        <Wordmark />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[10vh] pb-10">
        <div className="w-full max-w-lg">{children}</div>
      </main>
      <footer className="px-5 py-4 text-center font-mono text-[0.7rem] tracking-[0.08em] text-muted-foreground uppercase">
        End-to-end encrypted · Bitwarden Send
      </footer>
    </div>
  )
}

function Problem({ title, detail }: { title: string; detail: string }) {
  return (
    <Frame>
      <div className="space-y-1.5 text-center">
        <h1 className="text-xl font-bold tracking-[-0.02em] font-wide">
          {title}
        </h1>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
    </Frame>
  )
}

export function SendAccess({
  accessId,
  keyText,
}: {
  accessId: string
  keyText: string
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "password"; error: string | null }
    | { kind: "open"; send: Opened }
    | { kind: "gone" }
    | { kind: "broken" }
  >({ kind: "loading" })
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const attempt = async (withPassword: string | null) => {
    let material: Uint8Array
    try {
      material = fromBase64Url(keyText)
    } catch {
      return setState({ kind: "broken" })
    }
    try {
      setState({
        kind: "open",
        send: await open(accessId, material, withPassword),
      })
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 400)
      )
        setState({
          kind: "password",
          error: withPassword ? "That password is not right." : null,
        })
      else if (error instanceof ApiError && error.status === 429)
        setState({
          kind: "password",
          error: "Too many tries. Wait a minute, then try again.",
        })
      else if (error instanceof ApiError) setState({ kind: "gone" })
      else setState({ kind: "broken" })
    }
  }

  useEffect(() => {
    let active = true
    let material: Uint8Array
    try {
      material = fromBase64Url(keyText)
    } catch {
      return void setTimeout(() => active && setState({ kind: "broken" }))
    }
    open(accessId, material, null)
      .then((send) => active && setState({ kind: "open", send }))
      .catch((error: unknown) => {
        if (!active) return
        if (error instanceof ApiError && error.status === 401)
          setState({ kind: "password", error: null })
        else if (error instanceof ApiError) setState({ kind: "gone" })
        else setState({ kind: "broken" })
      })
    return () => {
      active = false
    }
  }, [accessId, keyText])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    await attempt(password)
    setBusy(false)
  }

  async function download(send: Opened) {
    setBusy(true)
    setDownloadError(null)
    try {
      const { url } = await api.sendFileLink(
        sendIdOf(accessId),
        send.file!.id,
        send.passwordHash
      )
      const response = await fetch(url)
      if (!response.ok) throw new Error("The file could not be downloaded.")
      const plain = await decryptFile(
        new Uint8Array(await response.arrayBuffer()),
        send.key
      )
      const href = URL.createObjectURL(
        new Blob([plain as Uint8Array<ArrayBuffer>])
      )
      const link = document.createElement("a")
      link.href = href
      link.download = send.file!.name
      link.click()
      setTimeout(() => URL.revokeObjectURL(href), 1000)
    } catch (error) {
      setDownloadError(
        error instanceof ApiError
          ? "This Send can't be downloaded any more."
          : error instanceof Error
            ? error.message
            : String(error)
      )
    } finally {
      setBusy(false)
    }
  }

  if (state.kind === "loading")
    return (
      <Frame>
        <div className="flex justify-center p-10">
          <Spinner />
        </div>
      </Frame>
    )
  if (state.kind === "gone")
    return (
      <Problem
        title="This Send is not available"
        detail="It may have expired, been deleted, reached its access limit, or been turned off."
      />
    )
  if (state.kind === "broken")
    return (
      <Problem
        title="This link is incomplete"
        detail="The part after the # holds the key. Copy the whole link and try again."
      />
    )
  if (state.kind === "password")
    return (
      <Frame>
        <form onSubmit={submit} className="space-y-5">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="flex size-12 items-center justify-center rounded-lg bg-brand-soft">
              <LockKeyholeIcon className="size-5 text-primary" />
            </span>
            <h1 className="text-xl font-bold tracking-[-0.02em] font-wide">
              This Send is protected
            </h1>
            <p className="text-sm text-muted-foreground">
              Enter the password the sender gave you.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cw-send-password">Password</Label>
            <Input
              id="cw-send-password"
              type="password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10"
            />
          </div>
          {state.error ? (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {state.error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            className="h-10 w-full"
            disabled={busy}
          >
            {busy ? <Spinner /> : null}
            Open
          </Button>
        </form>
      </Frame>
    )

  const { send } = state
  const hidden = send.text?.hidden && !revealed
  return (
    <Frame>
      <article className="space-y-4">
        <div className="space-y-1">
          <h1 className="text-xl font-bold tracking-[-0.02em] break-words font-wide">
            {send.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {send.creator ? `Shared by ${send.creator}` : "Shared with you"}
            {send.expirationDate
              ? ` · until ${new Date(send.expirationDate).toLocaleString()}`
              : ""}
          </p>
        </div>
        {send.text ? (
          <div className="overflow-hidden rounded-md border bg-card">
            <pre
              className={
                hidden
                  ? "p-4 font-mono text-sm tracking-[0.3em] text-muted-foreground"
                  : "max-h-[50vh] overflow-auto p-4 font-mono text-sm break-words whitespace-pre-wrap"
              }
            >
              {hidden ? "••••••••••••" : send.text.text}
            </pre>
            <div className="flex justify-end gap-1 border-t bg-surface-1 p-1.5">
              {send.text.hidden ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRevealed(!revealed)}
                >
                  {revealed ? <EyeOffIcon /> : <EyeIcon />}
                  {revealed ? "Hide" : "Show"}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copy(send.text!.text, "Text", true)}
              >
                <CopyIcon /> Copy
              </Button>
            </div>
          </div>
        ) : null}
        {send.file ? (
          <div className="flex items-center gap-3 rounded-md border bg-card p-4">
            <span className="flex size-10 items-center justify-center rounded-md bg-surface-1 text-muted-foreground">
              <FileIcon className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{send.file.name}</p>
              <p className="text-xs text-muted-foreground">{send.file.size}</p>
            </div>
            <Button onClick={() => void download(send)} disabled={busy}>
              {busy ? <Spinner /> : <DownloadIcon />}
              Download
            </Button>
          </div>
        ) : null}
        {downloadError ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {downloadError}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Decrypted in this browser. The server never saw the contents or the
          key in this link.
        </p>
      </article>
    </Frame>
  )
}
