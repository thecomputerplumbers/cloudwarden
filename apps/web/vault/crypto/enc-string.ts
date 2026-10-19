import {
  buffer,
  concat,
  equalBytes,
  fromBase64,
  fromUtf8,
  randomBytes,
  toBase64,
  utf8,
} from "./bytes.ts"
import { hmacSha256, type SymmetricKey } from "./keys.ts"
import { importVaultKey } from "./import-key.ts"

/**
 * Bitwarden's encrypted string: `<type>.<base64 parts joined by |>`.
 *
 *   0  AES-256-CBC                         iv|data           (legacy, no MAC)
 *   2  AES-256-CBC + HMAC-SHA256           iv|data|mac       (everything current)
 *   3  RSA-2048-OAEP-SHA256                data
 *   4  RSA-2048-OAEP-SHA1                  data              (organization keys)
 *   6  RSA-2048-OAEP-SHA1 + HMAC-SHA256    data|mac          (legacy)
 */
export type EncString =
  | { type: 0; iv: Uint8Array; data: Uint8Array }
  | { type: 2; iv: Uint8Array; data: Uint8Array; mac: Uint8Array }
  | { type: 3 | 4 | 6; data: Uint8Array }

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DecryptionError"
  }
}

export function parseEncString(text: string): EncString {
  const dot = text.indexOf(".")
  // A string without a type prefix is the oldest format: type 0, or type 2 when it has a MAC part.
  const [typeText, body] =
    dot === -1 ? [null, text] : [text.slice(0, dot), text.slice(dot + 1)]
  const parts = body.split("|").map(fromBase64)
  const type =
    typeText === null ? (parts.length === 3 ? 2 : 0) : Number(typeText)
  if (type === 0 && parts.length === 2)
    return { type, iv: parts[0]!, data: parts[1]! }
  if (type === 2 && parts.length === 3)
    return { type, iv: parts[0]!, data: parts[1]!, mac: parts[2]! }
  if ((type === 3 || type === 4) && parts.length === 1)
    return { type, data: parts[0]! }
  if (type === 6 && parts.length === 2) return { type, data: parts[0]! }
  throw new DecryptionError(
    `Unsupported encrypted string type ${typeText ?? "(none)"}`
  )
}

export function formatEncString(value: Extract<EncString, { type: 2 }>) {
  return `2.${toBase64(value.iv)}|${toBase64(value.data)}|${toBase64(value.mac)}`
}

async function aesCbc(
  direction: "encrypt" | "decrypt",
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array
) {
  const imported = await importVaultKey(key, "AES-CBC")
  const out = await crypto.subtle[direction](
    { name: "AES-CBC", iv: buffer(iv) },
    imported,
    buffer(data)
  )
  return new Uint8Array(out)
}

/** Decrypts to bytes. A type 2 string's MAC is checked before anything is decrypted. */
export async function decryptBytes(
  value: string | EncString,
  key: SymmetricKey
) {
  const enc = typeof value === "string" ? parseEncString(value) : value
  if (enc.type === 2) {
    if (!key.mac) throw new DecryptionError("This key has no MAC half")
    const expected = await hmacSha256(key.mac, concat(enc.iv, enc.data))
    if (!equalBytes(expected, enc.mac))
      throw new DecryptionError(
        "MAC mismatch: wrong key, or the data was altered"
      )
    return aesCbc("decrypt", key.enc, enc.iv, enc.data)
  }
  if (enc.type === 0) return aesCbc("decrypt", key.enc, enc.iv, enc.data)
  throw new DecryptionError(
    `Type ${enc.type} needs a private key, not a symmetric key`
  )
}

export const decryptString = async (value: string, key: SymmetricKey) =>
  fromUtf8(await decryptBytes(value, key))

/** Decrypts when there is a value; Bitwarden leaves optional fields null. */
export const decryptOptional = async (
  value: string | null | undefined,
  key: SymmetricKey
) => (value ? decryptString(value, key) : null)

/** Encrypts to a type 2 string with a fresh IV. */
export async function encryptBytes(plain: Uint8Array, key: SymmetricKey) {
  if (!key.mac) throw new Error("New data is always encrypted with a MAC")
  const iv = randomBytes(16)
  const data = await aesCbc("encrypt", key.enc, iv, plain)
  const mac = await hmacSha256(key.mac, concat(iv, data))
  return formatEncString({ type: 2, iv, data, mac })
}

export const encryptString = (plain: string, key: SymmetricKey) =>
  encryptBytes(utf8(plain), key)

export const encryptOptional = async (
  plain: string | null | undefined,
  key: SymmetricKey
) => (plain ? encryptString(plain, key) : null)

/** Decrypts an RSA string (organization keys, shared keys) with the user's private key. */
export async function decryptRsa(
  value: string,
  privateKey: CryptoKey | { sha256: CryptoKey }
) {
  const enc = parseEncString(value)
  if (enc.type === 4 || enc.type === 6) {
    if (!(privateKey instanceof CryptoKey))
      throw new DecryptionError("Expected a SHA-1 RSA key")
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "RSA-OAEP" },
        privateKey,
        buffer(enc.data)
      )
    )
  }
  if (enc.type === 3) {
    if (privateKey instanceof CryptoKey)
      throw new DecryptionError("Expected a SHA-256 RSA key")
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "RSA-OAEP" },
        privateKey.sha256,
        buffer(enc.data)
      )
    )
  }
  throw new DecryptionError(`Type ${enc.type} is not an RSA string`)
}

/** RSA-OAEP-SHA1 to a public key: how an organization key is given to a member. */
export async function encryptRsa(plain: Uint8Array, publicKey: CryptoKey) {
  return `4.${toBase64(new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, buffer(plain))))}`
}
