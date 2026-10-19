"use client"

import { Button } from "@workspace/ui/components/button"
import { Kbd } from "@workspace/ui/components/kbd"
import { formatRelativeTime } from "@workspace/ui-data/lib/format"
import { cn } from "@workspace/ui/lib/utils"
import {
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  PencilIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import type { VaultItem } from "../crypto/cipher.ts"
import { vaultOf } from "../filter.ts"
import { parseTotp, totpCode } from "../totp.ts"
import * as vault from "../store.ts"
import { VaultDot } from "./brand.tsx"
import { ItemIcon } from "./item-icon.tsx"
import { copy } from "./toast.tsx"

export function Group({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y overflow-hidden rounded-md border bg-card">
      {children}
    </div>
  )
}

export function FieldRow({
  label,
  value,
  secret = false,
  mono = false,
  canView = true,
  href,
  trailing,
  live = false,
}: {
  label: string
  value: string | null | undefined
  secret?: boolean
  mono?: boolean
  canView?: boolean
  href?: string
  trailing?: ReactNode
  /** A value that changes on its own, like a one-time code. */
  live?: boolean
}) {
  const [shown, setShown] = useState(false)
  if (!value) return null
  const masked = secret && !shown
  // Keys and certificates span lines; show them whole once revealed.
  const multiline = !masked && value.includes("\n")
  return (
    <div className="group flex min-h-14 items-center gap-3 px-4 py-2 transition-colors hover:bg-surface-1">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="label-caps text-muted-foreground">{label}</p>
        <p
          className={cn(
            "text-[0.9rem]",
            !multiline && "truncate",
            (mono || secret) && "font-mono text-[0.84rem]",
            masked && "tracking-[0.04em] text-muted-foreground",
            multiline &&
              "text-[0.78rem] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap",
            live && "text-base font-semibold tracking-[0.06em] text-primary"
          )}
        >
          {masked ? (
            "•".repeat(Math.min(14, Math.max(8, value.length)))
          ) : href ? (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary hover:underline"
            >
              {value}
            </a>
          ) : (
            value
          )}
        </p>
      </div>
      {trailing}
      <div className="flex items-center gap-0.5 text-muted-foreground opacity-70 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {secret && canView && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={shown ? `Hide ${label}` : `Show ${label}`}
            onClick={() => setShown(!shown)}
          >
            {shown ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        )}
        {href && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Open ${value}`}
            render={<a href={href} target="_blank" rel="noreferrer noopener" />}
          >
            <ExternalLinkIcon />
          </Button>
        )}
        {canView && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Copy ${label}`}
            onClick={() => copy(value, label, secret)}
          >
            <CopyIcon />
          </Button>
        )}
      </div>
    </div>
  )
}

/** The current one-time code, refreshed as it rolls over, with the time left drawn as a ring. */
function TotpRow({ secret }: { secret: string }) {
  const [now, setNow] = useState(() => Date.now())
  const [value, setValue] = useState<{
    code: string
    remaining: number
    period: number
  } | null>(null)
  const config = parseTotp(secret)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    const parsed = parseTotp(secret)
    if (parsed) void totpCode(parsed, now).then(setValue)
  }, [now, secret])
  if (!config)
    return <FieldRow label="One-time code" value="Not a valid TOTP secret" />
  if (!value) return null
  const pretty =
    value.code.length === 6
      ? `${value.code.slice(0, 3)} ${value.code.slice(3)}`
      : value.code
  const fraction = value.remaining / value.period
  return (
    <FieldRow
      label="One-time code"
      value={pretty}
      mono
      live
      trailing={
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
          {value.remaining}s
          <svg
            viewBox="0 0 20 20"
            className="size-5 -rotate-90"
            aria-label={`${value.remaining} seconds left`}
          >
            <circle
              cx="10"
              cy="10"
              r="8"
              fill="none"
              stroke="var(--border)"
              strokeWidth="2.5"
            />
            <circle
              cx="10"
              cy="10"
              r="8"
              fill="none"
              stroke={
                value.remaining <= 5 ? "var(--destructive)" : "var(--primary)"
              }
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${fraction * 50.27} 50.27`}
              className="transition-[stroke-dasharray] duration-1000 ease-linear"
            />
          </svg>
        </span>
      }
    />
  )
}

const hrefOf = (uri: string) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : `https://${uri}`
const safeHref = (uri: string) => {
  const href = hrefOf(uri)
  return /^https?:\/\//i.test(href) ? href : undefined
}

export function ItemDetail({
  item,
  onEdit,
  onBack,
}: {
  item: VaultItem | null
  onEdit: (item: VaultItem) => void
  onBack?: () => void
}) {
  const state = vault.useVault()
  const [busy, setBusy] = useState(false)
  // The vault opens with summaries; decrypt this item's secrets now that it is open.
  useEffect(() => {
    if (item && !item.complete) void vault.loadItem(item).catch(() => {})
  }, [item])
  if (!item)
    return (
      <div className="hidden h-full flex-col items-center justify-center gap-5 bg-background text-center text-sm text-muted-foreground md:flex">
        <div className="space-y-1">
          <p className="font-medium text-foreground">Choose an item</p>
          <p>Its details appear here.</p>
        </div>
        <dl className="grid grid-cols-[auto_auto] items-center gap-x-3 gap-y-2 text-left text-xs">
          <dt className="justify-self-end">
            <Kbd>⌘K</Kbd>
          </dt>
          <dd>Search the vault</dd>
          <dt className="justify-self-end">
            <Kbd>↑</Kbd> <Kbd>↓</Kbd>
          </dt>
          <dd>Move through the list</dd>
        </dl>
      </div>
    )
  const owner = state.vaults.find((entry) => entry.id === vaultOf(item))
  const folder = state.folders.find((entry) => entry.id === item.folderId)
  const collections = state.collections.filter((entry) =>
    item.collectionIds.includes(entry.id)
  )
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="flex h-full min-w-0 flex-col bg-background">
      <header className="shrink-0 border-b">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3 md:px-6">
          {onBack && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back to the list"
              onClick={onBack}
              className="-ml-1 md:hidden"
            >
              <ArrowLeftIcon />
            </Button>
          )}
          <ItemIcon key={item.id} item={item} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold tracking-[-0.015em] font-wide">
              {item.name || "Untitled"}
            </h1>
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
              <VaultDot color={owner?.color ?? 1} />
              <span className="truncate">
                {owner?.name ?? "Vault"}
                {folder && ` · ${folder.name}`}
              </span>
              {item.deleted && (
                <span className="shrink-0 text-destructive">· In trash</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {item.deleted ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => run(() => vault.restoreItem(item))}
              >
                <ArchiveRestoreIcon /> Restore
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={
                    item.favorite ? "Remove from favorites" : "Add to favorites"
                  }
                  disabled={
                    busy || !item.canEdit || !!item.error || !item.complete
                  }
                  onClick={() => run(() => vault.toggleFavorite(item))}
                >
                  <StarIcon
                    className={cn(item.favorite && "fill-warning text-warning")}
                  />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Move to trash"
                  disabled={busy || !item.canEdit}
                  onClick={() => run(() => vault.trash(item))}
                >
                  <Trash2Icon />
                </Button>
                <Button
                  size="sm"
                  disabled={!item.canEdit || !!item.error || !item.complete}
                  onClick={() => onEdit(item)}
                >
                  <PencilIcon /> Edit
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-4 px-4 py-5 md:px-6">
          {item.error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              This item could not be decrypted: {item.error}
            </p>
          )}

          {item.complete && item.login && (
            <Group>
              <FieldRow label="Username" value={item.login.username} />
              <FieldRow
                label="Password"
                value={item.login.password}
                secret
                canView={item.canViewPassword}
              />
              {item.login.totp && <TotpRow secret={item.login.totp} />}
            </Group>
          )}
          {item.complete && item.login && item.login.uris.length > 0 && (
            <Group>
              {item.login.uris.map((entry, index) => (
                <FieldRow
                  key={index}
                  label={index === 0 ? "Website" : `Website ${index + 1}`}
                  value={entry.uri}
                  href={safeHref(entry.uri)}
                />
              ))}
            </Group>
          )}
          {item.complete && item.card && (
            <Group>
              <FieldRow label="Cardholder" value={item.card.cardholderName} />
              <FieldRow label="Number" value={item.card.number} secret mono />
              <FieldRow label="Brand" value={item.card.brand} />
              <FieldRow
                label="Expires"
                value={
                  [item.card.expMonth, item.card.expYear]
                    .filter(Boolean)
                    .join(" / ") || null
                }
              />
              <FieldRow label="Security code" value={item.card.code} secret />
            </Group>
          )}
          {item.complete && item.identity && (
            <Group>
              <FieldRow
                label="Name"
                value={
                  [
                    item.identity.title,
                    item.identity.firstName,
                    item.identity.middleName,
                    item.identity.lastName,
                  ]
                    .filter(Boolean)
                    .join(" ") || null
                }
              />
              <FieldRow label="Email" value={item.identity.email} />
              <FieldRow label="Phone" value={item.identity.phone} />
              <FieldRow label="Company" value={item.identity.company} />
              <FieldRow
                label="Address"
                value={
                  [
                    item.identity.address1,
                    item.identity.address2,
                    item.identity.city,
                    item.identity.state,
                    item.identity.postalCode,
                    item.identity.country,
                  ]
                    .filter(Boolean)
                    .join(", ") || null
                }
              />
              <FieldRow label="SSN" value={item.identity.ssn} secret />
              <FieldRow
                label="Passport"
                value={item.identity.passportNumber}
                secret
              />
              <FieldRow
                label="License"
                value={item.identity.licenseNumber}
                secret
              />
            </Group>
          )}
          {item.complete && item.sshKey && (
            <Group>
              <FieldRow
                label="Fingerprint"
                value={item.sshKey.keyFingerprint}
                mono
              />
              <FieldRow label="Public key" value={item.sshKey.publicKey} mono />
              <FieldRow
                label="Private key"
                value={item.sshKey.privateKey}
                secret
              />
            </Group>
          )}
          {item.complete && item.fields.length > 0 && (
            <Group>
              {item.fields.map((entry, index) => (
                <FieldRow
                  key={index}
                  label={entry.name || "Field"}
                  value={
                    entry.type === 2
                      ? entry.value === "true"
                        ? "Yes"
                        : "No"
                      : entry.value
                  }
                  secret={entry.type === 1}
                />
              ))}
            </Group>
          )}
          {item.complete && item.notes && (
            <div className="rounded-md border bg-card px-4 py-3">
              <p className="mb-1.5 label-caps text-muted-foreground">Notes</p>
              <p className="text-[0.9rem] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
                {item.notes}
              </p>
            </div>
          )}
          {item.attachments.length > 0 && (
            <Group>
              {item.attachments.map((entry) => (
                <FieldRow
                  key={entry.id}
                  label={`Attachment · ${Math.ceil(entry.size / 1024)} KB`}
                  value={entry.fileName}
                />
              ))}
            </Group>
          )}

          <footer className="space-y-1 px-1 pt-1 font-mono text-[0.7rem] text-muted-foreground">
            {collections.length > 0 && (
              <p>
                Collections: {collections.map((entry) => entry.name).join(", ")}
              </p>
            )}
            <p>
              Edited{" "}
              <time
                dateTime={item.revisionDate}
                title={new Date(item.revisionDate).toLocaleString()}
              >
                {formatRelativeTime(new Date(item.revisionDate))}
              </time>
            </p>
          </footer>
        </div>
      </div>
    </article>
  )
}
