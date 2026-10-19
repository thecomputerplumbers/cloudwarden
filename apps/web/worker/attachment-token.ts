const encoder = new TextEncoder()

async function signingKey(secret: string) {
  if (!secret) throw new Error("Attachment signing secret is required")
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveKey"]
  )
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("cloudwarden"),
      info: encoder.encode("attachment-download-v1"),
    },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  )
}

function message(
  id: string,
  cipherId: string,
  userId: string,
  expires: number
) {
  return encoder.encode(JSON.stringify([id, cipherId, userId, expires]))
}

export async function issueAttachmentToken(
  secret: string,
  id: string,
  cipherId: string,
  userId: string
) {
  const expires = Date.now() + 5 * 60_000
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    message(id, cipherId, userId, expires)
  )
  const encoded = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
  return `${expires}-${encoded}`
}

export async function verifyAttachmentToken(
  secret: string,
  id: string,
  cipherId: string,
  userId: string,
  token: string
) {
  const match = /^(\d{13})-([-_A-Za-z0-9]{43})$/.exec(token)
  if (!match || !secret) return false
  const expires = Number(match[1])
  if (expires <= Date.now() || expires > Date.now() + 5 * 60_000) return false
  const signature = Uint8Array.from(
    atob(match[2]!.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0)
  )
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    signature,
    message(id, cipherId, userId, expires)
  )
}
