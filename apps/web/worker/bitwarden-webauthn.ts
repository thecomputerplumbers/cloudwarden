import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server"
import { and, eq, gt } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import {
  vaultEmailTwoFactor,
  vaultSession,
  vaultTotp,
  vaultWebauthnChallenge,
  vaultWebauthnCredential,
  vaultWebauthnFactor,
} from "../db/schema/vault"
import { newTotpSecret } from "./bitwarden-totp"

const lifetimeMs = 60_000
const algorithms = [-7, -257]

function relyingParty(env: CloudflareEnv) {
  if (!env.APP_URL) throw new Error("WebAuthn origin is not configured")
  const url = new URL(env.APP_URL)
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new Error("WebAuthn requires a secure canonical origin")
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

function challengeId(userId: string, kind: "register" | "login") {
  return `${userId}:${kind}`
}

async function saveChallenge(
  env: CloudflareEnv,
  userId: string,
  kind: "register" | "login",
  challenge: string
) {
  await drizzle(env.DB)
    .insert(vaultWebauthnChallenge)
    .values({
      id: challengeId(userId, kind),
      userId,
      kind,
      challenge,
      expiresAt: new Date(Date.now() + lifetimeMs),
    })
    .onConflictDoUpdate({
      target: vaultWebauthnChallenge.id,
      set: { challenge, expiresAt: new Date(Date.now() + lifetimeMs) },
    })
    .run()
}

async function consumeChallenge(
  env: CloudflareEnv,
  userId: string,
  kind: "register" | "login"
) {
  return drizzle(env.DB)
    .delete(vaultWebauthnChallenge)
    .where(
      and(
        eq(vaultWebauthnChallenge.id, challengeId(userId, kind)),
        gt(vaultWebauthnChallenge.expiresAt, new Date())
      )
    )
    .returning({ challenge: vaultWebauthnChallenge.challenge })
    .get()
}

export async function getWebauthn(env: CloudflareEnv, userId: string) {
  const db = drizzle(env.DB)
  const [factor, credentials] = await Promise.all([
    db
      .select()
      .from(vaultWebauthnFactor)
      .where(eq(vaultWebauthnFactor.userId, userId))
      .get(),
    db
      .select()
      .from(vaultWebauthnCredential)
      .where(eq(vaultWebauthnCredential.userId, userId))
      .orderBy(vaultWebauthnCredential.slot)
      .limit(5)
      .all(),
  ])
  return { factor: credentials.length ? factor : null, credentials }
}

export async function startWebauthnRegistration(
  env: CloudflareEnv,
  user: { id: string; email: string; name: string }
) {
  const { rpID } = relyingParty(env)
  const { credentials } = await getWebauthn(env, user.id)
  const options = await generateRegistrationOptions({
    rpName: "Cloudwarden",
    rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    timeout: lifetimeMs,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "discouraged",
      userVerification: "discouraged",
    },
    supportedAlgorithmIDs: algorithms,
    excludeCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: JSON.parse(credential.transports) as string[],
    })),
  })
  await saveChallenge(env, user.id, "register", options.challenge)
  return { ...options, status: "ok", errorMessage: "" }
}

function normalizeRegistrationResponse(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const response = value.response
  if (!response || typeof response !== "object" || Array.isArray(response))
    return null
  const fields = response as Record<string, unknown>
  const clientDataJSON = fields.clientDataJSON ?? fields.clientDataJson
  const attestationObject = fields.attestationObject ?? fields.AttestationObject
  if (
    typeof value.id !== "string" ||
    typeof (value.rawId ?? value.id) !== "string" ||
    typeof clientDataJSON !== "string" ||
    typeof attestationObject !== "string"
  )
    return null
  return {
    id: value.id,
    rawId: (value.rawId ?? value.id) as string,
    type: "public-key" as const,
    clientExtensionResults: {},
    response: { clientDataJSON, attestationObject },
  } satisfies RegistrationResponseJSON
}

export async function finishWebauthnRegistration(
  env: CloudflareEnv,
  userId: string,
  slot: number,
  name: string,
  raw: unknown
) {
  const response = normalizeRegistrationResponse(raw)
  const saved = await consumeChallenge(env, userId, "register")
  if (!response || !saved) return false
  const { origin, rpID } = relyingParty(env)
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: saved.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      supportedAlgorithmIDs: algorithms,
    })
    if (!result.verified) return false
    const credential = result.registrationInfo.credential
    const now = new Date()
    const db = drizzle(env.DB)
    await db.batch([
      db
        .insert(vaultWebauthnFactor)
        .values({ userId, recoveryCode: newTotpSecret(), createdAt: now })
        .onConflictDoNothing(),
      db.insert(vaultWebauthnCredential).values({
        id: crypto.randomUUID(),
        userId,
        slot,
        name,
        credentialId: credential.id,
        publicKey: encode(credential.publicKey),
        counter: credential.counter,
        transports: JSON.stringify(credential.transports ?? []),
        deviceType: result.registrationInfo.credentialDeviceType,
        backedUp: result.registrationInfo.credentialBackedUp,
        createdAt: now,
        updatedAt: now,
      }),
    ])
    return true
  } catch {
    return false
  }
}

export async function startWebauthnLogin(env: CloudflareEnv, userId: string) {
  const { rpID } = relyingParty(env)
  const { credentials } = await getWebauthn(env, userId)
  if (!credentials.length) return null
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: JSON.parse(credential.transports) as string[],
    })),
    timeout: lifetimeMs,
    userVerification: "discouraged",
  })
  await saveChallenge(env, userId, "login", options.challenge)
  return options
}

function normalizeAuthenticationResponse(raw: string) {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const response = record.response
    if (!response || typeof response !== "object" || Array.isArray(response))
      return null
    const fields = response as Record<string, unknown>
    const clientDataJSON = fields.clientDataJSON ?? fields.clientDataJson
    if (
      typeof record.id !== "string" ||
      typeof (record.rawId ?? record.id) !== "string" ||
      typeof clientDataJSON !== "string" ||
      typeof fields.authenticatorData !== "string" ||
      typeof fields.signature !== "string"
    )
      return null
    return {
      id: record.id,
      rawId: (record.rawId ?? record.id) as string,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON,
        authenticatorData: fields.authenticatorData,
        signature: fields.signature,
        userHandle:
          typeof fields.userHandle === "string" ? fields.userHandle : undefined,
      },
    } satisfies AuthenticationResponseJSON
  } catch {
    return null
  }
}

export async function verifyWebauthnLogin(
  env: CloudflareEnv,
  userId: string,
  raw: string
) {
  const response = normalizeAuthenticationResponse(raw)
  const saved = await consumeChallenge(env, userId, "login")
  if (!response || !saved) return false
  const db = drizzle(env.DB)
  const credential = await db
    .select()
    .from(vaultWebauthnCredential)
    .where(
      and(
        eq(vaultWebauthnCredential.userId, userId),
        eq(vaultWebauthnCredential.credentialId, response.id)
      )
    )
    .get()
  if (!credential) return false
  const { origin, rpID } = relyingParty(env)
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: saved.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: credential.credentialId,
        publicKey: decode(credential.publicKey),
        counter: credential.counter,
        transports: JSON.parse(credential.transports) as string[],
      },
    })
    if (!result.verified) return false
    return !!(await db
      .update(vaultWebauthnCredential)
      .set({
        counter: result.authenticationInfo.newCounter,
        deviceType: result.authenticationInfo.credentialDeviceType,
        backedUp: result.authenticationInfo.credentialBackedUp,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(vaultWebauthnCredential.id, credential.id),
          eq(vaultWebauthnCredential.counter, credential.counter)
        )
      )
      .returning({ id: vaultWebauthnCredential.id })
      .get())
  } catch {
    return false
  }
}

export async function deleteWebauthnCredential(
  env: CloudflareEnv,
  userId: string,
  slot: number
) {
  const db = drizzle(env.DB)
  const removed = await db
    .delete(vaultWebauthnCredential)
    .where(
      and(
        eq(vaultWebauthnCredential.userId, userId),
        eq(vaultWebauthnCredential.slot, slot)
      )
    )
    .returning({ id: vaultWebauthnCredential.id })
    .get()
  if (!removed) return false
  const remaining = await db
    .select({ id: vaultWebauthnCredential.id })
    .from(vaultWebauthnCredential)
    .where(eq(vaultWebauthnCredential.userId, userId))
    .limit(1)
    .get()
  if (!remaining)
    await db
      .delete(vaultWebauthnFactor)
      .where(eq(vaultWebauthnFactor.userId, userId))
      .run()
  return true
}

export async function disableWebauthn(env: CloudflareEnv, userId: string) {
  const db = drizzle(env.DB)
  await db.batch([
    db
      .delete(vaultWebauthnCredential)
      .where(eq(vaultWebauthnCredential.userId, userId)),
    db
      .delete(vaultWebauthnFactor)
      .where(eq(vaultWebauthnFactor.userId, userId)),
  ])
}

export async function redeemWebauthnRecoveryCode(
  env: CloudflareEnv,
  userId: string,
  code: string
) {
  if (!/^[A-Z2-7]{32}$/.test(code)) return false
  const db = drizzle(env.DB)
  const removed = await db
    .delete(vaultWebauthnFactor)
    .where(
      and(
        eq(vaultWebauthnFactor.userId, userId),
        eq(vaultWebauthnFactor.recoveryCode, code)
      )
    )
    .returning({ userId: vaultWebauthnFactor.userId })
    .get()
  if (!removed) return false
  await db.batch([
    db
      .delete(vaultWebauthnCredential)
      .where(eq(vaultWebauthnCredential.userId, userId)),
    db.delete(vaultTotp).where(eq(vaultTotp.userId, userId)),
    db
      .delete(vaultEmailTwoFactor)
      .where(eq(vaultEmailTwoFactor.userId, userId)),
    db.delete(vaultSession).where(eq(vaultSession.userId, userId)),
  ])
  return true
}
