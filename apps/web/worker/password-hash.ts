import { pbkdf2 } from "@noble/hashes/pbkdf2.js"
import { sha256 } from "@noble/hashes/sha2.js"

const encoder = new TextEncoder()
const ITERATIONS = 120_000

const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")

/** Whether the runtime's PBKDF2 refused the iteration count once already. */
let nativeRefused = false

/**
 * The server-side hash of the client's master password hash: PBKDF2-SHA256,
 * 120,000 rounds, salted with the account's salt.
 *
 * Native WebCrypto first: the JavaScript PBKDF2 takes several times longer and
 * blocks the isolate on every login. Some Workers runtimes have refused PBKDF2
 * above 100,000 iterations, so a refusal falls back to the JavaScript version,
 * which gives the same bytes. Stored hashes verify either way.
 */
export async function hashClientPassword(password: string, salt: string) {
  if (!nativeRefused) {
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(password),
        "PBKDF2",
        false,
        ["deriveBits"]
      )
      const bits = await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: encoder.encode(salt),
          iterations: ITERATIONS,
        },
        key,
        256
      )
      return hex(new Uint8Array(bits))
    } catch (error) {
      nativeRefused = true
      console.error(
        JSON.stringify({
          event: "pbkdf2.native_refused",
          error: error instanceof Error ? error.name : "unknown",
        })
      )
    }
  }
  return hex(
    pbkdf2(sha256, encoder.encode(password), encoder.encode(salt), {
      c: ITERATIONS,
      dkLen: 32,
    })
  )
}
