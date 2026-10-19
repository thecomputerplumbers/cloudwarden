import { argon2id } from "hash-wasm"
import { buffer, toBase64, utf8 } from "./bytes.ts"
import { hkdfExpand, type SymmetricKey } from "./keys.ts"

/** The account's key derivation settings, as `/identity/accounts/prelogin` returns them. */
export type KdfConfig =
  | { kdf: 0; iterations: number }
  | { kdf: 1; iterations: number; memory: number; parallelism: number }

export const normalizeEmail = (email: string) => email.trim().toLowerCase()

/** The master key: the master password stretched with the account's KDF, salted with the email. */
export async function makeMasterKey(
  password: string,
  email: string,
  config: KdfConfig
) {
  const salt = normalizeEmail(email)
  if (config.kdf === 0) {
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
        salt: buffer(utf8(salt)),
        iterations: config.iterations,
      },
      key,
      256
    )
    return new Uint8Array(bits)
  }
  // Argon2id is salted with SHA-256 of the email; memory is configured in MiB.
  const hashedSalt = new Uint8Array(
    await crypto.subtle.digest("SHA-256", buffer(utf8(salt)))
  )
  return argon2id({
    password: utf8(password),
    salt: hashedSalt,
    iterations: config.iterations,
    memorySize: config.memory * 1024,
    parallelism: config.parallelism,
    hashLength: 32,
    outputType: "binary",
  })
}

/** What the server checks at login: one PBKDF2 round of the master key, salted with the password. */
export async function hashMasterPassword(
  masterKey: Uint8Array,
  password: string
) {
  const key = await crypto.subtle.importKey(
    "raw",
    buffer(masterKey),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: buffer(utf8(password)),
      iterations: 1,
    },
    key,
    256
  )
  return toBase64(new Uint8Array(bits))
}

/** The key that wraps the user key: the master key expanded into encryption and MAC halves. */
export async function stretchMasterKey(
  masterKey: Uint8Array
): Promise<SymmetricKey> {
  return {
    enc: await hkdfExpand(masterKey, "enc", 32),
    mac: await hkdfExpand(masterKey, "mac", 32),
  }
}
