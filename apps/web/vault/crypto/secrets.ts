import {
  buffer,
  fromBase64,
  fromUtf8,
  randomBytes,
  toBase64,
  utf8,
} from "./bytes.ts"
import { decryptBytes, encryptBytes } from "./enc-string.ts"
import { keyBytes, symmetricKey, type SymmetricKey } from "./keys.ts"

/**
 * Secrets Manager access tokens (docs/secrets-manager.md, "Access tokens").
 * A token is made in the admin's browser; the server gets only the secret's
 * hash and the organization key encrypted with a key it cannot derive.
 */

export const TOKEN_PREFIX = "cw1"

const toBase64Url = (bytes: Uint8Array) =>
  toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
const fromBase64Url = (text: string) => {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/")
  return fromBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))
}

/** The 64-byte token key: HKDF-SHA256 over the token's key material. */
export async function tokenKey(keyMaterial: Uint8Array): Promise<SymmetricKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    buffer(keyMaterial),
    "HKDF",
    false,
    ["deriveBits"]
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: buffer(utf8("cloudwarden-sm-access-token")),
      info: buffer(utf8("sm-access-token-key")),
    },
    ikm,
    512
  )
  return symmetricKey(new Uint8Array(bits))
}

const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(utf8(text))))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

/**
 * A new access token for an organization. `token` is shown to the admin once;
 * `request` is what the server receives (plus the encrypted name).
 */
export async function createAccessToken(
  organizationId: string,
  organizationKey: SymmetricKey
) {
  const id = crypto.randomUUID()
  const clientSecret = toBase64Url(randomBytes(32))
  const keyMaterial = randomBytes(16)
  const payload = JSON.stringify({
    organizationId,
    organizationKey: toBase64(keyBytes(organizationKey)),
  })
  return {
    token: `${TOKEN_PREFIX}.${id}.${clientSecret}.${toBase64Url(keyMaterial)}`,
    request: {
      id,
      secretHash: await sha256Hex(clientSecret),
      encryptedPayload: await encryptBytes(
        utf8(payload),
        await tokenKey(keyMaterial)
      ),
    },
  }
}

export interface ParsedToken {
  tokenId: string
  clientSecret: string
  keyMaterial: Uint8Array
}

export function parseAccessToken(token: string): ParsedToken {
  const parts = token.trim().split(".")
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX)
    throw new Error("Not a cloudwarden access token")
  const keyMaterial = fromBase64Url(parts[3]!)
  if (keyMaterial.length !== 16)
    throw new Error("Not a cloudwarden access token")
  return { tokenId: parts[1]!, clientSecret: parts[2]!, keyMaterial }
}

/** What a reader does after `auth`: recover the organization key from the payload. */
export async function openPayload(
  encryptedPayload: string,
  keyMaterial: Uint8Array
) {
  const payload = JSON.parse(
    fromUtf8(await decryptBytes(encryptedPayload, await tokenKey(keyMaterial)))
  ) as {
    organizationId: string
    organizationKey: string
  }
  return {
    organizationId: payload.organizationId,
    organizationKey: symmetricKey(fromBase64(payload.organizationKey)),
  }
}
