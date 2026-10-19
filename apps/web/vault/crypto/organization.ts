import { randomBytes, toBase64 } from "./bytes.ts"
import { encryptBytes, encryptRsa, encryptString } from "./enc-string.ts"
import { importPublicKey } from "./account.ts"
import { keyBytes, symmetricKey } from "./keys.ts"

/**
 * Everything creating an organization sends. The organization's symmetric
 * key is wrapped with the creator's own public key, as every member's copy
 * is; the organization also gets a key pair of its own, its private half
 * wrapped with the organization key.
 */
export async function newOrganization(
  name: string,
  ownPublicKeyBase64: string,
  defaultCollection: string
) {
  const orgKey = symmetricKey(randomBytes(64))
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      hash: "SHA-1",
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
    orgKey,
    body: {
      name,
      key: await encryptRsa(
        keyBytes(orgKey),
        await importPublicKey(ownPublicKeyBase64)
      ),
      keys: {
        publicKey: toBase64(publicKey),
        encryptedPrivateKey: await encryptBytes(privateKey, orgKey),
      },
      collectionName: await encryptString(defaultCollection, orgKey),
    },
  }
}
