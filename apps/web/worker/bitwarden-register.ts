const encoder = new TextEncoder()

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function decodeBase64Url(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

async function key(env: CloudflareEnv) {
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

export async function issueRegistrationToken(
  env: CloudflareEnv,
  email: string,
  name: string | null,
  verified: boolean
) {
  const payload = base64Url(
    encoder.encode(
      JSON.stringify({
        purpose: "cloudwarden-registration",
        email,
        name,
        verified,
        expiresAt: Date.now() + 15 * 60_000,
      })
    )
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(env),
    encoder.encode(payload)
  )
  return `${payload}.${base64Url(new Uint8Array(signature))}`
}

export async function verifyRegistrationToken(
  env: CloudflareEnv,
  token: string,
  email: string
) {
  const parts = token.split(".")
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  )
    return null
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await key(env),
      decodeBase64Url(parts[1]!),
      encoder.encode(parts[0]!)
    )
    if (!valid) return null
    const payload: unknown = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(parts[0]!))
    )
    if (!payload || typeof payload !== "object") return null
    const claims = payload as Record<string, unknown>
    return claims.purpose === "cloudwarden-registration" &&
      claims.email === email &&
      typeof claims.verified === "boolean" &&
      typeof claims.expiresAt === "number" &&
      claims.expiresAt > Date.now() &&
      (claims.name === null || typeof claims.name === "string")
      ? { name: claims.name as string | null, verified: claims.verified }
      : null
  } catch {
    return null
  }
}

// Returned once a two-factor settings request has been reauthenticated, so
// the change that follows need not carry the master password again.
export async function issueTwoFactorVerification(
  env: CloudflareEnv,
  user: { id: string; securityStamp: string }
) {
  const payload = base64Url(
    encoder.encode(
      JSON.stringify({
        purpose: "cloudwarden-two-factor-verification",
        userId: user.id,
        securityStamp: user.securityStamp,
        expiresAt: Date.now() + 15 * 60_000,
      })
    )
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(env),
    encoder.encode(payload)
  )
  return `${payload}.${base64Url(new Uint8Array(signature))}`
}

export async function validTwoFactorVerification(
  env: CloudflareEnv,
  token: string,
  user: { id: string; securityStamp: string }
) {
  const parts = token.split(".")
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  )
    return false
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await key(env),
      decodeBase64Url(parts[1]!),
      encoder.encode(parts[0]!)
    )
    if (!valid) return false
    const claims = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(parts[0]!))
    ) as Record<string, unknown>
    return (
      claims.purpose === "cloudwarden-two-factor-verification" &&
      claims.userId === user.id &&
      claims.securityStamp === user.securityStamp &&
      typeof claims.expiresAt === "number" &&
      claims.expiresAt > Date.now()
    )
  } catch {
    return false
  }
}
