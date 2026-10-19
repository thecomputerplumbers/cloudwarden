// Byte helpers for the vault's client-side crypto. Browser and Node both have
// atob/btoa and TextEncoder, so nothing here depends on a platform.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const utf8 = (text: string) => encoder.encode(text)
export const fromUtf8 = (bytes: Uint8Array) => decoder.decode(bytes)

export function toBase64(bytes: Uint8Array) {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function fromBase64(text: string) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Constant-time comparison, for MACs. */
export function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!
  return difference === 0
}

export const randomBytes = (length: number) =>
  crypto.getRandomValues(new Uint8Array(length))

/** A view WebCrypto accepts as `BufferSource` under strict ArrayBuffer typing. */
export const buffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer
