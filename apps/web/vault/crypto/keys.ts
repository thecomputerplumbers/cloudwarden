import { buffer, concat } from "./bytes.ts"
import { importVaultKey } from "./import-key.ts"

/**
 * A Bitwarden symmetric key: 32 bytes for AES-256-CBC and 32 for
 * HMAC-SHA256. The user key, organization keys, and per-cipher keys all have
 * this shape. A 32-byte legacy key has no MAC half.
 */
export interface SymmetricKey {
  enc: Uint8Array
  mac: Uint8Array | null
}

export function symmetricKey(bytes: Uint8Array): SymmetricKey {
  if (bytes.length === 64)
    return { enc: bytes.slice(0, 32), mac: bytes.slice(32) }
  if (bytes.length === 32) return { enc: bytes.slice(), mac: null }
  throw new Error(`A symmetric key is 32 or 64 bytes, not ${bytes.length}`)
}

export const keyBytes = (key: SymmetricKey) =>
  key.mac ? concat(key.enc, key.mac) : key.enc.slice()

export async function hmacSha256(key: Uint8Array, data: Uint8Array) {
  const imported = await importVaultKey(key, "HMAC")
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, buffer(data))
  )
}

/** HKDF-Expand (RFC 5869) with SHA-256, without the extract step, as Bitwarden uses it. */
export async function hkdfExpand(
  prk: Uint8Array,
  info: string,
  length: number
) {
  const infoBytes = new TextEncoder().encode(info)
  const out = new Uint8Array(length)
  let previous = new Uint8Array(0)
  for (let block = 1, offset = 0; offset < length; block++) {
    previous = await hmacSha256(
      prk,
      concat(previous, infoBytes, new Uint8Array([block]))
    )
    out.set(
      previous.subarray(0, Math.min(previous.length, length - offset)),
      offset
    )
    offset += previous.length
  }
  return out
}
