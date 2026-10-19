import { buffer, fromBase64, randomBytes, toBase64 } from "./bytes.ts"
import {
  decryptBytes,
  decryptRsa,
  encryptBytes,
  parseEncString,
} from "./enc-string.ts"
import {
  hashMasterPassword,
  makeMasterKey,
  stretchMasterKey,
  type KdfConfig,
} from "./kdf.ts"
import { keyBytes, symmetricKey, type SymmetricKey } from "./keys.ts"

/**
 * An unlocked account: everything needed to read and write the vault. Lives
 * only in memory; nothing here is ever sent to the server.
 */
export interface AccountKeys {
  userKey: SymmetricKey
  /** RSA-OAEP-SHA1, for organization keys shared with this account. */
  privateKey: CryptoKey | null
  /** Organization ID to that organization's symmetric key. */
  orgKeys: Map<string, SymmetricKey>
}

const RSA_SHA1 = { name: "RSA-OAEP", hash: "SHA-1" } as const

/** Unwraps the user key with the stretched master key. Very old accounts wrapped it, unauthenticated, with the master key itself. */
export async function unwrapUserKey(encUserKey: string, masterKey: Uint8Array) {
  const enc = parseEncString(encUserKey)
  const wrapping =
    enc.type === 0 ? symmetricKey(masterKey) : await stretchMasterKey(masterKey)
  return symmetricKey(await decryptBytes(enc, wrapping))
}

export async function unwrapPrivateKey(
  encPrivateKey: string,
  userKey: SymmetricKey
) {
  const pkcs8 = await decryptBytes(encPrivateKey, userKey)
  return crypto.subtle.importKey("pkcs8", buffer(pkcs8), RSA_SHA1, false, [
    "decrypt",
  ])
}

export async function unwrapOrgKey(encOrgKey: string, privateKey: CryptoKey) {
  return symmetricKey(await decryptRsa(encOrgKey, privateKey))
}

/**
 * Unlocks an account from what login and sync return: the wrapped user key,
 * the wrapped private key, and each organization's wrapped key. An
 * organization whose key does not unwrap is left out rather than failing
 * the whole unlock.
 */
export async function unlockAccount(input: {
  masterKey: Uint8Array
  key: string
  privateKey: string | null
  organizations: { id: string; key: string | null }[]
}): Promise<AccountKeys & { failedOrganizations: string[] }> {
  const userKey = await unwrapUserKey(input.key, input.masterKey)
  const privateKey = input.privateKey
    ? await unwrapPrivateKey(input.privateKey, userKey)
    : null
  const orgKeys = new Map<string, SymmetricKey>()
  const failedOrganizations: string[] = []
  await Promise.all(
    input.organizations.map(async (organization) => {
      if (!organization.key || !privateKey)
        return void failedOrganizations.push(organization.id)
      try {
        orgKeys.set(
          organization.id,
          await unwrapOrgKey(organization.key, privateKey)
        )
      } catch {
        failedOrganizations.push(organization.id)
      }
    })
  )
  return { userKey, privateKey, orgKeys, failedOrganizations }
}

/** Everything registration sends, derived client-side. Only the hash and wrapped keys leave the browser. */
export async function newAccount(
  email: string,
  password: string,
  kdf: KdfConfig
) {
  const masterKey = await makeMasterKey(password, email, kdf)
  const userKey = symmetricKey(randomBytes(64))
  const pair = await crypto.subtle.generateKey(
    {
      ...RSA_SHA1,
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["encrypt", "decrypt"]
  )
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey)
  )
  const privateKey = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey)
  )
  return {
    masterKey,
    userKey,
    masterPasswordHash: await hashMasterPassword(masterKey, password),
    key: await encryptBytes(
      keyBytes(userKey),
      await stretchMasterKey(masterKey)
    ),
    keys: {
      publicKey: toBase64(publicKey),
      encryptedPrivateKey: await encryptBytes(privateKey, userKey),
    },
  }
}

/** An RSA public key as the server returns it (base64 SPKI), for sharing an organization key with a member. */
export const importPublicKey = (spkiBase64: string) =>
  crypto.subtle.importKey(
    "spki",
    buffer(fromBase64(spkiBase64)),
    RSA_SHA1,
    false,
    ["encrypt"]
  )
