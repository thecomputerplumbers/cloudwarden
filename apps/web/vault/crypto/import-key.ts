import { buffer, equalBytes } from "./bytes.ts"

type Algorithm = "AES-CBC" | "HMAC"
type Entry = { bytes: Uint8Array; key: Promise<CryptoKey> }

// Weak keys let an account's imported keys go away with its in-memory vault.
// Pending imports are shared too: decrypting many fields starts concurrently.
const caches: Record<Algorithm, WeakMap<Uint8Array, Entry>> = {
  "AES-CBC": new WeakMap(),
  HMAC: new WeakMap(),
}

export function importVaultKey(bytes: Uint8Array, algorithm: Algorithm) {
  const cache = caches[algorithm]
  const previous = cache.get(bytes)
  // Do not keep using an old CryptoKey if a caller changes its raw bytes.
  if (previous && equalBytes(previous.bytes, bytes)) return previous.key
  const snapshot = bytes.slice()
  const entry: Entry = {
    bytes: snapshot,
    key: crypto.subtle
      .importKey(
        "raw",
        buffer(snapshot),
        algorithm === "HMAC" ? { name: "HMAC", hash: "SHA-256" } : algorithm,
        false,
        algorithm === "HMAC" ? ["sign"] : ["encrypt", "decrypt"]
      )
      .catch((error: unknown) => {
        if (cache.get(bytes) === entry) cache.delete(bytes)
        throw error
      }),
  }
  cache.set(bytes, entry)
  return entry.key
}
