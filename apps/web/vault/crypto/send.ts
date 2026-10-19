import { buffer, fromBase64, randomBytes, toBase64, utf8 } from "./bytes.ts"
import { symmetricKey, type SymmetricKey } from "./keys.ts"

/**
 * Bitwarden Send's keys. A Send has 16 random bytes of key material, which
 * travel in the link after the `#` (so never to the server) and, wrapped with
 * the creator's user key, in the Send itself. Its contents are encrypted with
 * a key derived from that material.
 */

export const newSendMaterial = () => randomBytes(16)

/** HKDF-SHA256 of the material, salted "bitwarden-send", for "send": 32 bytes to encrypt, 32 to MAC. */
export async function sendKey(material: Uint8Array): Promise<SymmetricKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    buffer(material),
    "HKDF",
    false,
    ["deriveBits"]
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: buffer(utf8("bitwarden-send")),
      info: buffer(utf8("send")),
    },
    ikm,
    512
  )
  return symmetricKey(new Uint8Array(bits))
}

/** What a Send's password becomes before it is sent: PBKDF2-SHA256 with the material as salt, 100,000 rounds. */
export async function sendPasswordHash(password: string, material: Uint8Array) {
  const key = await crypto.subtle.importKey(
    "raw",
    buffer(utf8(password)),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: buffer(material),
      iterations: 100_000,
    },
    key,
    256
  )
  return toBase64(new Uint8Array(bits))
}

export const toBase64Url = (bytes: Uint8Array) =>
  toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")

export const fromBase64Url = (text: string) =>
  fromBase64(text.replaceAll("-", "+").replaceAll("_", "/"))

/** The link a recipient opens. Bitwarden's apps build the same one. */
export const sendLink = (
  origin: string,
  accessId: string,
  material: Uint8Array
) => `${origin}/#/send/${accessId}/${toBase64Url(material)}`
