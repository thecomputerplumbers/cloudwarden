import { eq, gt, and, or, inArray, isNull } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import {
  vaultApiKey,
  vaultAuthRequest,
  vaultCollectionMember,
  vaultMembership,
  vaultOrganization,
  vaultSession,
  vaultUser,
} from "../db/schema/vault"
import { authenticatedVaultUser, tokenHash } from "./bitwarden-auth"

const encoder = new TextEncoder()
const ping = new Uint8Array([1, 0x91, 6])

function packed(value: unknown): Uint8Array {
  if (value === null) return new Uint8Array([0xc0])
  if (value instanceof Date) {
    const millis = value.getTime()
    const timestamp =
      ((BigInt(millis % 1000) * 1_000_000n) << 34n) |
      BigInt(Math.floor(millis / 1000))
    const result = new Uint8Array(10)
    result.set([0xd7, 0xff])
    new DataView(result.buffer).setBigUint64(2, timestamp)
    return result
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 255)
      throw new Error("Invalid notification number")
    return value < 128 ? new Uint8Array([value]) : new Uint8Array([0xcc, value])
  }
  if (typeof value === "string") {
    const bytes = encoder.encode(value)
    const prefix =
      bytes.length < 32
        ? [0xa0 | bytes.length]
        : bytes.length < 256
          ? [0xd9, bytes.length]
          : [0xda, bytes.length >> 8, bytes.length & 0xff]
    return new Uint8Array([...prefix, ...bytes])
  }
  if (Array.isArray(value)) {
    if (value.length > 15) throw new Error("Notification array too large")
    return join([new Uint8Array([0x90 | value.length]), ...value.map(packed)])
  }
  if (typeof value === "object" && value) {
    const entries = Object.entries(value)
    if (entries.length > 15) throw new Error("Notification map too large")
    return join([
      new Uint8Array([0x80 | entries.length]),
      ...entries.flatMap(([key, item]) => [packed(key), packed(item)]),
    ])
  }
  throw new Error("Invalid notification value")
}

function join(parts: Uint8Array[]) {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0)
  )
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function framed(value: unknown) {
  const body = packed(value)
  let length = body.length
  const prefix: number[] = []
  do {
    const byte = length & 0x7f
    length >>= 7
    prefix.push(length ? byte | 0x80 : byte)
  } while (length)
  return join([new Uint8Array(prefix), body])
}

export type VaultNotification = {
  type: number
  userId: string
  id?: string
  contextId?: string | null
  anonymous?: boolean
  activeSessionIds?: string[]
}

export function notificationFrame(event: VaultNotification) {
  const payload =
    event.type === 5 || event.type === 11
      ? { UserId: event.userId, Date: new Date() }
      : { Id: event.id, UserId: event.userId }
  return framed(
    event.anonymous
      ? [
          1,
          {},
          null,
          "AuthRequestResponseRecieved",
          [{ Type: event.type, Payload: payload, UserId: event.userId }],
        ]
      : [
          1,
          {},
          null,
          "ReceiveMessage",
          [
            {
              ContextId: event.contextId ?? null,
              Type: event.type,
              Payload: payload,
            },
          ],
        ]
  )
}

export const notificationPing = ping

export async function publishVaultNotification(
  env: CloudflareEnv,
  event: VaultNotification
) {
  try {
    if (!event.anonymous && event.type !== 11) {
      const db = drizzle(env.DB)
      const [user, currentKey, sessions] = await Promise.all([
        db
          .select({
            securityStamp: vaultUser.securityStamp,
            deletingAt: vaultUser.deletingAt,
          })
          .from(vaultUser)
          .where(eq(vaultUser.id, event.userId))
          .get(),
        db
          .select({ secretHash: vaultApiKey.secretHash })
          .from(vaultApiKey)
          .where(eq(vaultApiKey.userId, event.userId))
          .get(),
        db
          .select()
          .from(vaultSession)
          .where(
            and(
              eq(vaultSession.userId, event.userId),
              gt(vaultSession.refreshExpiresAt, new Date())
            )
          )
          .limit(1000)
          .all(),
      ])
      event = {
        ...event,
        activeSessionIds: sessions
          .filter(
            (session) =>
              !user?.deletingAt &&
              session.securityStamp === user?.securityStamp &&
              (!session.apiKey ||
                (!!currentKey && session.apiKeyHash === currentKey.secretHash))
          )
          .map((session) => session.id),
      }
    }
    const object = await env.APP_DATABASE.getByName(
      event.anonymous ? `auth-request:${event.id}` : `vault:${event.userId}`
    )
    await object.publishVaultNotification(event)
  } catch {
    console.error("Vault notification delivery failed")
  }
}

export async function organizationNotificationTargets(
  env: CloudflareEnv,
  orgId: string,
  collectionIds: string[] | null
) {
  const db = drizzle(env.DB)
  const members = await db
    .select({
      id: vaultMembership.id,
      userId: vaultMembership.userId,
      accessAll: vaultMembership.accessAll,
    })
    .from(vaultMembership)
    .innerJoin(
      vaultOrganization,
      eq(vaultOrganization.id, vaultMembership.orgId)
    )
    .innerJoin(vaultUser, eq(vaultUser.id, vaultMembership.userId))
    .where(
      and(
        eq(vaultMembership.orgId, orgId),
        eq(vaultMembership.status, 2),
        isNull(vaultOrganization.deletingAt),
        isNull(vaultUser.deletingAt)
      )
    )
    .all()
  if (collectionIds === null) return members.map((member) => member.userId)
  if (!collectionIds.length) return []
  const grants = await db
    .select({ membershipId: vaultCollectionMember.membershipId })
    .from(vaultCollectionMember)
    .where(inArray(vaultCollectionMember.collectionId, collectionIds))
    .all()
  const allowed = new Set(grants.map((grant) => grant.membershipId))
  return members
    .filter((member) => member.accessAll || allowed.has(member.id))
    .map((member) => member.userId)
}

export async function publishOrganizationSync(
  env: CloudflareEnv,
  orgId: string,
  collectionIds: string[] | null
) {
  try {
    const users = await organizationNotificationTargets(
      env,
      orgId,
      collectionIds
    )
    for (let index = 0; index < users.length; index += 20)
      await Promise.all(
        users
          .slice(index, index + 20)
          .map((userId) => publishVaultNotification(env, { type: 5, userId }))
      )
  } catch {
    console.error("Organization notification delivery failed")
  }
}

export async function handleVaultNotification(
  request: Request,
  env: CloudflareEnv
) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return new Response("WebSocket required", { status: 426 })
  const url = new URL(request.url)
  let name: string
  if (url.pathname === "/notifications/hub") {
    const token =
      url.searchParams.get("access_token") ??
      /^Bearer (.+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1]
    if (!token || token.length > 10_000)
      return new Response("Unauthorized", { status: 401 })
    const authRequest = new Request(request.url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const user = await authenticatedVaultUser(env, authRequest)
    if (!user) return new Response("Unauthorized", { status: 401 })
    name = `vault:${user.id}`
    const hash = await tokenHash(token)
    const session = await drizzle(env.DB)
      .select({ id: vaultSession.id })
      .from(vaultSession)
      .where(
        and(
          eq(vaultSession.userId, user.id),
          or(
            eq(vaultSession.accessHash, hash),
            eq(vaultSession.previousAccessHash, hash)
          )
        )
      )
      .get()
    if (!session) return new Response("Unauthorized", { status: 401 })
    url.searchParams.set("sessionId", session.id)
    let tokenExpiry: number
    try {
      const payload = JSON.parse(
        atob(token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/"))
      ) as { exp?: number }
      tokenExpiry = Number(payload.exp) * 1000
    } catch {
      return new Response("Unauthorized", { status: 401 })
    }
    if (!Number.isSafeInteger(tokenExpiry) || tokenExpiry <= Date.now())
      return new Response("Unauthorized", { status: 401 })
    url.searchParams.set(
      "expiresAt",
      String(Math.min(tokenExpiry, Date.now() + 60 * 60_000))
    )
  } else if (url.pathname === "/notifications/anonymous-hub") {
    const id = url.searchParams.get("token")
    if (!id || !/^[0-9a-f-]{36}$/i.test(id))
      return new Response("Unauthorized", { status: 401 })
    const row = await drizzle(env.DB)
      .select({
        requestIp: vaultAuthRequest.requestIp,
        expiresAt: vaultAuthRequest.expiresAt,
      })
      .from(vaultAuthRequest)
      .where(
        and(
          eq(vaultAuthRequest.id, id),
          gt(vaultAuthRequest.expiresAt, new Date())
        )
      )
      .get()
    if (
      !row ||
      row.requestIp !== (request.headers.get("CF-Connecting-IP") ?? "unknown")
    )
      return new Response("Unauthorized", { status: 401 })
    name = `auth-request:${id}`
    url.searchParams.set("expiresAt", String(row.expiresAt.getTime()))
  } else {
    return new Response("Not found", { status: 404 })
  }
  const object = await env.APP_DATABASE.getByName(name)
  return object.fetch(
    new Request(
      `https://internal.cloudwarden${url.pathname}?expiresAt=${url.searchParams.get("expiresAt")}`,
      {
        headers: {
          Upgrade: "websocket",
          ...(url.searchParams.get("sessionId")
            ? { "X-Cloudwarden-Session-Id": url.searchParams.get("sessionId")! }
            : {}),
        },
      }
    )
  )
}
