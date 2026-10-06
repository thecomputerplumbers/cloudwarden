import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import { vaultSendLocator } from "../db/schema/vault"
import { tokenHash } from "./bitwarden-auth"
import type { AppDatabase } from "./database"

type SendRow = NonNullable<Awaited<ReturnType<AppDatabase["getVaultSend"]>>>
type Body = Record<string, unknown>

function field(body: Body, name: string) {
  const key = Object.keys(body).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase()
  )
  return key ? body[key] : undefined
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

export function sendAccessId(id: string) {
  const compact = id.replaceAll("-", "")
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++)
    bytes[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16)
  return base64Url(bytes)
}

export function sendIdFromAccessId(accessId: string) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(accessId)) return null
  try {
    const decoded = atob(
      accessId.replaceAll("-", "+").replaceAll("_", "/") + "=="
    )
    if (decoded.length !== 16) return null
    const hex = Array.from(decoded, (letter) =>
      letter.charCodeAt(0).toString(16).padStart(2, "0")
    ).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  } catch {
    return null
  }
}

export function parseTextSend(body: Body) {
  const type = field(body, "type")
  const name = field(body, "name")
  const key = field(body, "key")
  const text = field(body, "text")
  const notes = field(body, "notes")
  const password = field(body, "password")
  const deletion = field(body, "deletionDate")
  const expiration = field(body, "expirationDate")
  const maximum = field(body, "maxAccessCount")
  const disabled = field(body, "disabled")
  const hideEmail = field(body, "hideEmail")
  const emails = field(body, "emails")
  const deletionAt = typeof deletion === "string" ? new Date(deletion) : null
  const expirationAt =
    typeof expiration === "string" ? new Date(expiration) : null
  const maxAccessCount =
    typeof maximum === "number"
      ? maximum
      : typeof maximum === "string" && /^\d+$/.test(maximum)
        ? Number(maximum)
        : null
  if (
    type !== 0 ||
    typeof name !== "string" ||
    !name ||
    name.length > 20_000 ||
    typeof key !== "string" ||
    !key ||
    key.length > 20_000 ||
    !text ||
    typeof text !== "object" ||
    Array.isArray(text) ||
    (notes !== undefined && notes !== null && typeof notes !== "string") ||
    (password !== undefined &&
      password !== null &&
      (typeof password !== "string" || password.length > 1000)) ||
    !deletionAt ||
    !Number.isFinite(deletionAt.getTime()) ||
    deletionAt.getTime() <= Date.now() ||
    deletionAt.getTime() > Date.now() + 31 * 24 * 60 * 60 * 1000 ||
    (expirationAt && !Number.isFinite(expirationAt.getTime())) ||
    (maximum !== undefined &&
      maximum !== null &&
      (!Number.isSafeInteger(maxAccessCount) || maxAccessCount! < 0)) ||
    (disabled !== undefined && typeof disabled !== "boolean") ||
    (hideEmail !== undefined &&
      hideEmail !== null &&
      typeof hideEmail !== "boolean") ||
    (emails !== undefined && emails !== null)
  )
    return null
  const sanitizedText = { ...(text as Body) }
  delete sanitizedText.response
  return {
    payload: JSON.stringify({
      name,
      key,
      notes: notes ?? null,
      text: sanitizedText,
      hideEmail: hideEmail ?? false,
    }),
    maxAccessCount,
    expirationAt,
    deletionAt,
    disabled: disabled === true,
    password: typeof password === "string" ? password : undefined,
  }
}

export async function hashSendPassword(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations: 100_000,
    },
    key,
    256
  )
  return base64Url(new Uint8Array(hash))
}

export function newSendPasswordSalt() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export function sendResponse(row: SendRow) {
  const data = JSON.parse(row.payload) as Body
  return {
    id: row.id,
    accessId: sendAccessId(row.id),
    type: 0,
    name: data.name,
    notes: data.notes,
    text: data.text,
    file: null,
    key: data.key,
    maxAccessCount: row.maxAccessCount,
    accessCount: row.accessCount,
    password: row.passwordHash,
    authType: row.passwordHash ? 1 : 2,
    disabled: row.disabled,
    hideEmail: data.hideEmail,
    revisionDate: row.updatedAt.toISOString(),
    expirationDate: row.expirationAt?.toISOString() ?? null,
    deletionDate: row.deletionAt.toISOString(),
    object: "send",
  }
}

export function sendAccessResponse(row: SendRow, email: string) {
  const data = JSON.parse(row.payload) as Body
  return {
    id: row.id,
    type: 0,
    name: data.name,
    text: data.text,
    file: null,
    expirationDate: row.expirationAt?.toISOString() ?? null,
    creatorIdentifier: data.hideEmail ? null : email,
    object: "send-access",
  }
}

export async function createSendLocator(
  env: CloudflareEnv,
  id: string,
  userId: string
) {
  await drizzle(env.DB).insert(vaultSendLocator).values({ id, userId }).run()
}

export async function getSendLocator(env: CloudflareEnv, id: string) {
  return (
    (await drizzle(env.DB)
      .select()
      .from(vaultSendLocator)
      .where(eq(vaultSendLocator.id, id))
      .get()) ?? null
  )
}

export async function deleteSendLocator(env: CloudflareEnv, id: string) {
  await drizzle(env.DB)
    .delete(vaultSendLocator)
    .where(eq(vaultSendLocator.id, id))
    .run()
}

export async function newSendAccessToken(id: string) {
  const random = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const token = `${sendAccessId(id)}.${random}`
  return { token, hash: await tokenHash(token) }
}
