import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server"
import { and, eq, gt, isNull, lt, type SQL } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import { vaultUser } from "../db/schema/vault"
import {
  vaultPasskeyChallenge,
  vaultPasskeyCredential,
} from "../db/schema/vault-passkey"

type Body = Record<string, unknown>
type Scope = "register" | "login" | "update"
type PasskeyUser = { id: string; email: string; name: string }
type Transport = NonNullable<
  RegistrationResponseJSON["response"]["transports"]
>[number]
type Credential = typeof vaultPasskeyCredential.$inferSelect

export type PasskeyPrfOption = {
  encryptedPrivateKey: string
  encryptedUserKey: string
  credentialId: string
  transports: string[]
}

const maxCredentials = 5
const timeoutMs = 5 * 60_000
// The create token outlives the ceremony so the user can name the passkey.
const lifetimeMs: Record<Scope, number> = {
  register: 7 * 60_000,
  login: 6 * 60_000,
  update: 6 * 60_000,
}
const algorithms = [-7, -257]
const knownTransports = [
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

function failure(message: string, status = 400) {
  return json({ error: message, error_description: message }, status)
}

function relyingParty(env: CloudflareEnv) {
  if (!env.APP_URL) return null
  let url: URL
  try {
    url = new URL(env.APP_URL)
  } catch {
    return null
  }
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    return null
  return { origin: url.origin, rpID: url.hostname }
}

function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function decode(value: string) {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0)
  )
}

function userHandle(userId: string) {
  return encode(new TextEncoder().encode(userId))
}

async function tokenId(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function saveChallenge(
  env: CloudflareEnv,
  scope: Scope,
  userId: string | null,
  challenge: string
) {
  const token = encode(crypto.getRandomValues(new Uint8Array(32)))
  const db = drizzle(env.DB)
  const insert = db.insert(vaultPasskeyChallenge).values({
    id: await tokenId(token),
    userId,
    scope,
    challenge,
    expiresAt: new Date(Date.now() + lifetimeMs[scope]),
  })
  // A signed-in user holds one live challenge per scope. Anonymous login
  // challenges cannot be keyed that way, so each issue sweeps expired rows.
  await db.batch([
    userId
      ? db
          .delete(vaultPasskeyChallenge)
          .where(
            and(
              eq(vaultPasskeyChallenge.userId, userId),
              eq(vaultPasskeyChallenge.scope, scope)
            )
          )
      : db
          .delete(vaultPasskeyChallenge)
          .where(lt(vaultPasskeyChallenge.expiresAt, new Date())),
    insert,
  ])
  return token
}

// Deleting is the claim: a token is spent by its first use, whether or not
// the response that came with it verifies.
async function consumeChallenge(
  env: CloudflareEnv,
  scope: Scope,
  userId: string | null,
  token: unknown
) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
    return null
  const row = await drizzle(env.DB)
    .delete(vaultPasskeyChallenge)
    .where(
      and(
        eq(vaultPasskeyChallenge.id, await tokenId(token)),
        eq(vaultPasskeyChallenge.scope, scope),
        userId
          ? eq(vaultPasskeyChallenge.userId, userId)
          : isNull(vaultPasskeyChallenge.userId),
        gt(vaultPasskeyChallenge.expiresAt, new Date())
      )
    )
    .returning({ challenge: vaultPasskeyChallenge.challenge })
    .get()
  return row?.challenge ?? null
}

function field(body: Body, name: string) {
  const key = Object.keys(body).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase()
  )
  return key ? body[key] : undefined
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Body)
    : null
}

function encoded(value: unknown, limit: number) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : null
}

async function bodyOf(request: Request) {
  const text = await request.text()
  if (text.length > 100_000) return null
  try {
    return record(JSON.parse(text))
  } catch {
    return null
  }
}

function transportsOf(value: unknown) {
  return Array.isArray(value)
    ? ([
        ...new Set(
          value.filter(
            (item): item is string =>
              typeof item === "string" && knownTransports.includes(item)
          )
        ),
      ] as Transport[])
    : []
}

function normalizeRegistrationResponse(raw: unknown) {
  const value = record(raw)
  const fields = value && record(field(value, "response"))
  if (!value || !fields) return null
  const id = encoded(field(value, "id"), 1400)
  const rawId = encoded(field(value, "rawId") ?? id, 1400)
  const clientDataJSON = encoded(field(fields, "clientDataJSON"), 8000)
  const attestationObject = encoded(field(fields, "attestationObject"), 30_000)
  if (!id || rawId !== id || !clientDataJSON || !attestationObject) return null
  return {
    id,
    rawId,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON,
      attestationObject,
      transports: transportsOf(field(fields, "transports")),
    },
  } satisfies RegistrationResponseJSON
}

function normalizeAuthenticationResponse(raw: unknown) {
  const value = record(raw)
  const fields = value && record(field(value, "response"))
  if (!value || !fields) return null
  const id = encoded(field(value, "id"), 1400)
  const rawId = encoded(field(value, "rawId") ?? id, 1400)
  const clientDataJSON = encoded(field(fields, "clientDataJSON"), 8000)
  const authenticatorData = encoded(field(fields, "authenticatorData"), 8000)
  const signature = encoded(field(fields, "signature"), 2000)
  const handle = encoded(field(fields, "userHandle"), 100)
  if (
    !id ||
    rawId !== id ||
    !clientDataJSON ||
    !authenticatorData ||
    !signature ||
    !handle
  )
    return null
  return {
    id,
    rawId,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: {
      clientDataJSON,
      authenticatorData,
      signature,
      userHandle: handle,
    },
  } satisfies AuthenticationResponseJSON
}

function encryptedString(value: unknown) {
  return typeof value === "string" &&
    value.length <= 2000 &&
    /^\d{1,2}\.[A-Za-z0-9+/=|_-]+$/.test(value)
    ? value
    : null
}

// All three or none: a partial set cannot unlock and cannot be rotated.
function keySetOf(body: Body) {
  const raw = [
    field(body, "encryptedUserKey"),
    field(body, "encryptedPublicKey"),
    field(body, "encryptedPrivateKey"),
  ]
  if (raw.every((value) => value == null)) return null
  const [encryptedUserKey, encryptedPublicKey, encryptedPrivateKey] =
    raw.map(encryptedString)
  return encryptedUserKey && encryptedPublicKey && encryptedPrivateKey
    ? { encryptedUserKey, encryptedPublicKey, encryptedPrivateKey }
    : false
}

function prfEnabled(credential: Credential) {
  return (
    credential.supportsPrf &&
    !!credential.encryptedUserKey &&
    !!credential.encryptedPublicKey &&
    !!credential.encryptedPrivateKey
  )
}

function prfOption(credential: Credential): PasskeyPrfOption | null {
  return prfEnabled(credential)
    ? {
        encryptedPrivateKey: credential.encryptedPrivateKey!,
        encryptedUserKey: credential.encryptedUserKey!,
        credentialId: credential.credentialId,
        transports: [],
      }
    : null
}

function credentialResponse(credential: Credential) {
  return {
    id: credential.id,
    name: credential.name,
    // Upstream WebAuthnPrfStatus: Enabled, Supported, Unsupported.
    prfStatus: !credential.supportsPrf ? 2 : prfEnabled(credential) ? 0 : 1,
    encryptedUserKey: credential.encryptedUserKey,
    encryptedPublicKey: credential.encryptedPublicKey,
    object: "webauthnCredential",
  }
}

function listPasskeys(env: CloudflareEnv, userId: string) {
  return drizzle(env.DB)
    .select()
    .from(vaultPasskeyCredential)
    .where(eq(vaultPasskeyCredential.userId, userId))
    .orderBy(vaultPasskeyCredential.slot)
    .all()
}

async function assertionOptions(
  env: CloudflareEnv,
  rpID: string,
  scope: "login" | "update",
  userId: string | null
) {
  const options = await generateAuthenticationOptions({
    rpID,
    timeout: timeoutMs,
    userVerification: "required",
  })
  return {
    options: {
      ...options,
      allowCredentials: [],
      status: "ok",
      errorMessage: "",
    },
    token: await saveChallenge(env, scope, userId, options.challenge),
    object: "webAuthnLoginAssertionOptions",
  }
}

// Shared by sign-in and the PRF key update. The credential is looked up by
// its globally unique ID, and the user handle the authenticator returned must
// name the same account; a deleting account never matches.
async function verifyAssertion(
  env: CloudflareEnv,
  scope: "login" | "update",
  userId: string | null,
  token: unknown,
  raw: unknown
) {
  const challenge = await consumeChallenge(env, scope, userId, token)
  const response = normalizeAuthenticationResponse(raw)
  const party = relyingParty(env)
  if (!challenge || !response || !party) return null
  const db = drizzle(env.DB)
  const row = await db
    .select({ credential: vaultPasskeyCredential })
    .from(vaultPasskeyCredential)
    .innerJoin(vaultUser, eq(vaultUser.id, vaultPasskeyCredential.userId))
    .where(
      and(
        eq(vaultPasskeyCredential.credentialId, response.id),
        isNull(vaultUser.deletingAt)
      )
    )
    .get()
  const credential = row?.credential
  if (
    !credential ||
    response.response.userHandle !== userHandle(credential.userId) ||
    (userId && credential.userId !== userId)
  )
    return null
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: party.origin,
      expectedRPID: party.rpID,
      expectedType: "webauthn.get",
      requireUserVerification: true,
      credential: {
        id: credential.credentialId,
        publicKey: decode(credential.publicKey),
        counter: credential.counter,
        transports: JSON.parse(credential.transports) as Transport[],
      },
    })
    if (!result.verified || !result.authenticationInfo.userVerified) return null
    // The counter guard makes two racing uses of one assertion mutually
    // exclusive even for authenticators that count.
    const updated = await db
      .update(vaultPasskeyCredential)
      .set({
        counter: result.authenticationInfo.newCounter,
        deviceType: result.authenticationInfo.credentialDeviceType,
        backedUp: result.authenticationInfo.credentialBackedUp,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(vaultPasskeyCredential.id, credential.id),
          eq(vaultPasskeyCredential.counter, credential.counter)
        )
      )
      .returning({ id: vaultPasskeyCredential.id })
      .get()
    return updated ? credential : null
  } catch {
    return null
  }
}

async function savePasskey(env: CloudflareEnv, user: PasskeyUser, body: Body) {
  // Spend the token before anything else can reject the request.
  const challenge = await consumeChallenge(
    env,
    "register",
    user.id,
    field(body, "token")
  )
  const response = normalizeRegistrationResponse(field(body, "deviceResponse"))
  const rawName = field(body, "name")
  const name = typeof rawName === "string" ? rawName.trim() : ""
  const supportsPrf = field(body, "supportsPrf") ?? false
  const keys = keySetOf(body)
  const party = relyingParty(env)
  if (
    !challenge ||
    !response ||
    !party ||
    !name ||
    name.length > 50 ||
    typeof supportsPrf !== "boolean" ||
    keys === false ||
    (keys && !supportsPrf)
  )
    return null
  const existing = await listPasskeys(env, user.id)
  const slot = [1, 2, 3, 4, 5].find(
    (candidate) => !existing.some((credential) => credential.slot === candidate)
  )
  if (existing.length >= maxCredentials || !slot) return null
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: party.origin,
      expectedRPID: party.rpID,
      expectedType: "webauthn.create",
      requireUserVerification: true,
      supportedAlgorithmIDs: algorithms,
    })
    if (!result.verified || !result.registrationInfo.userVerified) return null
    const credential = result.registrationInfo.credential
    const now = new Date()
    // The unique indexes on (user, slot) and credential ID reject a racing
    // sixth passkey and a credential that is already registered anywhere.
    return await drizzle(env.DB)
      .insert(vaultPasskeyCredential)
      .values({
        id: crypto.randomUUID(),
        userId: user.id,
        slot,
        name,
        credentialId: credential.id,
        publicKey: encode(credential.publicKey),
        counter: credential.counter,
        transports: JSON.stringify(credential.transports ?? []),
        deviceType: result.registrationInfo.credentialDeviceType,
        backedUp: result.registrationInfo.credentialBackedUp,
        supportsPrf,
        encryptedUserKey: keys ? keys.encryptedUserKey : null,
        encryptedPublicKey: keys ? keys.encryptedPublicKey : null,
        encryptedPrivateKey: keys ? keys.encryptedPrivateKey : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
  } catch {
    return null
  }
}

export async function handlePasskeyRoutes(
  env: CloudflareEnv,
  request: Request,
  user: PasskeyUser,
  path: string,
  method: string,
  reauthenticate: (body: Body | null) => Promise<boolean>
): Promise<Response | null> {
  if (path !== "/api/webauthn" && !path.startsWith("/api/webauthn/"))
    return null

  if (path === "/api/webauthn" && method === "GET")
    return json({
      data: (await listPasskeys(env, user.id)).map(credentialResponse),
      object: "list",
      continuationToken: null,
    })

  if (path === "/api/webauthn/attestation-options" && method === "POST") {
    if (!(await reauthenticate(await bodyOf(request))))
      return failure("Invalid reauthentication", 403)
    const party = relyingParty(env)
    if (!party) return failure("Passkeys are unavailable", 503)
    const existing = await listPasskeys(env, user.id)
    if (existing.length >= maxCredentials)
      return failure("Passkey limit reached")
    const options = await generateRegistrationOptions({
      rpName: "Cloudwarden",
      rpID: party.rpID,
      userName: user.email,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id),
      timeout: timeoutMs,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      supportedAlgorithmIDs: algorithms,
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: JSON.parse(credential.transports) as Transport[],
      })),
    })
    return json({
      options: { ...options, status: "ok", errorMessage: "" },
      token: await saveChallenge(env, "register", user.id, options.challenge),
      object: "webauthnCredentialCreateOptions",
    })
  }

  if (path === "/api/webauthn/assertion-options" && method === "POST") {
    if (!(await reauthenticate(await bodyOf(request))))
      return failure("Invalid reauthentication", 403)
    const party = relyingParty(env)
    if (!party) return failure("Passkeys are unavailable", 503)
    return json(await assertionOptions(env, party.rpID, "update", user.id))
  }

  if (path === "/api/webauthn" && method === "POST") {
    const body = await bodyOf(request)
    const credential = body && (await savePasskey(env, user, body))
    return credential
      ? json(credentialResponse(credential))
      : failure("Unable to complete WebAuthn registration.")
  }

  if (path === "/api/webauthn" && method === "PUT") {
    const body = await bodyOf(request)
    const keys = body && keySetOf(body)
    // The assertion is this route's proof, so it is checked even when the
    // keys are unusable; that also spends the token.
    const credential =
      body &&
      (await verifyAssertion(
        env,
        "update",
        user.id,
        field(body, "token"),
        field(body, "deviceResponse")
      ))
    if (!credential || !credential.supportsPrf || !keys)
      return failure("Unable to update credential.")
    const updated = await drizzle(env.DB)
      .update(vaultPasskeyCredential)
      .set({ ...keys, updatedAt: new Date() })
      .where(
        and(
          eq(vaultPasskeyCredential.id, credential.id),
          eq(vaultPasskeyCredential.userId, user.id)
        )
      )
      .returning({ id: vaultPasskeyCredential.id })
      .get()
    return updated
      ? new Response(null, { status: 200 })
      : failure("Unable to update credential.")
  }

  const deletion = /^\/api\/webauthn\/([0-9a-f-]{36})\/delete$/i.exec(path)
  if (deletion && method === "POST") {
    if (!(await reauthenticate(await bodyOf(request))))
      return failure("Invalid reauthentication", 403)
    const removed = await drizzle(env.DB)
      .delete(vaultPasskeyCredential)
      .where(
        and(
          eq(vaultPasskeyCredential.id, deletion[1]!.toLowerCase()),
          eq(vaultPasskeyCredential.userId, user.id)
        )
      )
      .returning({ id: vaultPasskeyCredential.id })
      .get()
    return removed
      ? new Response(null, { status: 200 })
      : failure("Credential not found.", 404)
  }

  return failure("Not found", 404)
}

export async function passkeyAssertionOptions(
  env: CloudflareEnv,
  request: Request
): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown"
  const limiter = await env.APP_DATABASE.getByName("bitwarden-login-rates")
  if (
    !(await limiter.consumeRateLimit(`passkey-options:${ip}`, 30, 60_000))
      .allowed
  )
    return failure("Too many passkey requests", 429)
  const party = relyingParty(env)
  if (!party) return failure("Passkeys are unavailable", 503)
  return json(await assertionOptions(env, party.rpID, "login", null))
}

export async function verifyPasskeyGrant(
  env: CloudflareEnv,
  form: URLSearchParams
): Promise<{ userId: string; prf: PasskeyPrfOption | null } | null> {
  const deviceResponse = form.get("deviceResponse")
  let raw: unknown = null
  if (deviceResponse && deviceResponse.length <= 20_000) {
    try {
      raw = JSON.parse(deviceResponse)
    } catch {
      raw = null
    }
  }
  const credential = await verifyAssertion(
    env,
    "login",
    null,
    form.get("token"),
    raw
  )
  return credential
    ? { userId: credential.userId, prf: prfOption(credential) }
    : null
}

export async function passkeyPrfOptions(
  env: CloudflareEnv,
  userId: string
): Promise<PasskeyPrfOption[]> {
  return (await listPasskeys(env, userId))
    .map(prfOption)
    .filter((option) => option !== null)
}

// A key rotation must re-wrap the user key for every passkey that can unlock
// the vault. This returns the writes for the rotation's commit batch, or null
// when the request does not cover exactly those passkeys.
export async function passkeyRotation(
  env: CloudflareEnv,
  userId: string,
  items: Body[]
) {
  const unlocking = (await listPasskeys(env, userId)).filter(prfEnabled)
  const next = new Map<
    string,
    { encryptedUserKey: string; encryptedPublicKey: string }
  >()
  for (const item of items) {
    const id = field(item, "id")
    const encryptedUserKey = encryptedString(field(item, "encryptedUserKey"))
    const encryptedPublicKey = encryptedString(
      field(item, "encryptedPublicKey")
    )
    if (
      typeof id !== "string" ||
      !encryptedUserKey ||
      !encryptedPublicKey ||
      next.has(id)
    )
      return null
    next.set(id, { encryptedUserKey, encryptedPublicKey })
  }
  if (
    next.size !== unlocking.length ||
    !unlocking.every((credential) => next.has(credential.id))
  )
    return null
  return (db: ReturnType<typeof drizzle>, committed: SQL) =>
    [...next].map(([id, keys]) =>
      db
        .update(vaultPasskeyCredential)
        .set({ ...keys, updatedAt: new Date() })
        .where(
          and(
            eq(vaultPasskeyCredential.id, id),
            eq(vaultPasskeyCredential.userId, userId),
            committed
          )
        )
    )
}

export async function prunePasskeyChallenges(env: CloudflareEnv) {
  await drizzle(env.DB)
    .delete(vaultPasskeyChallenge)
    .where(lt(vaultPasskeyChallenge.expiresAt, new Date()))
    .run()
}
