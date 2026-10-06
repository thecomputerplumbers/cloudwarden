import type { VaultUser } from "./bitwarden-auth"

const encoder = new TextEncoder()

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function decodeBase64Url(value: string) {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0)
  )
}

async function signingKey(env: CloudflareEnv) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new Error("Token signing secret is not configured")
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  )
}

export async function issueDeleteRecoveryToken(
  env: CloudflareEnv,
  user: VaultUser
) {
  const payload = base64Url(
    encoder.encode(
      JSON.stringify({
        purpose: "cloudwarden-delete-recovery",
        userId: user.id,
        email: user.email,
        securityStamp: user.securityStamp,
        expiresAt: Date.now() + 30 * 60_000,
      })
    )
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(env),
    encoder.encode(payload)
  )
  return `${payload}.${base64Url(new Uint8Array(signature))}`
}

export async function verifyDeleteRecoveryToken(
  env: CloudflareEnv,
  user: VaultUser,
  token: string
) {
  if (token.length > 2000) return false
  const parts = token.split(".")
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  )
    return false
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(env),
      decodeBase64Url(parts[1]!),
      encoder.encode(parts[0]!)
    )
    if (!valid) return false
    const raw: unknown = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(parts[0]!))
    )
    if (!raw || typeof raw !== "object") return false
    const claims = raw as Record<string, unknown>
    return (
      claims.purpose === "cloudwarden-delete-recovery" &&
      claims.userId === user.id &&
      claims.email === user.email &&
      claims.securityStamp === user.securityStamp &&
      typeof claims.expiresAt === "number" &&
      claims.expiresAt > Date.now()
    )
  } catch {
    return false
  }
}
