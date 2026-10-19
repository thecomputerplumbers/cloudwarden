import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { test } from "node:test"
import {
  decryptString,
  encryptString,
} from "../apps/web/vault/crypto/enc-string.ts"
import { hmacSha256, symmetricKey } from "../apps/web/vault/crypto/keys.ts"
import { importVaultKey } from "../apps/web/vault/crypto/import-key.ts"

test("concurrent field decryptions reuse imports and still authenticate every field", async (t) => {
  const key = symmetricKey(crypto.getRandomValues(new Uint8Array(64)))
  const actualImport = crypto.subtle.importKey.bind(crypto.subtle)
  let imports = 0
  t.mock.method(crypto.subtle, "importKey", (...args) => {
    imports++
    return actualImport(...args)
  })
  const messages = Array.from({ length: 100 }, (_, i) => `Field ${i} ✓`)
  const encrypted = await Promise.all(
    messages.map((m) => encryptString(m, key))
  )
  assert.deepEqual(
    await Promise.all(encrypted.map((m) => decryptString(m, key))),
    messages
  )
  assert.equal(imports, 2)
  const altered = encrypted[0].split("|")
  altered[2] = Buffer.alloc(32).toString("base64")
  await assert.rejects(decryptString(altered.join("|"), key), /MAC mismatch/)
  assert.equal(imports, 2)
  const aes = await importVaultKey(key.enc, "AES-CBC")
  assert.equal(aes.extractable, false)
})

test("different accounts and changed raw key bytes never reuse another key", async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(64))
  const first = symmetricKey(bytes)
  const other = symmetricKey(crypto.getRandomValues(new Uint8Array(64)))
  const encrypted = await encryptString("secret", first)
  await assert.rejects(decryptString(encrypted, other), /MAC mismatch/)
  first.mac[0] ^= 1
  const payload = new TextEncoder().encode("message")
  assert.deepEqual(
    Buffer.from(await hmacSha256(first.mac, payload)),
    createHmac("sha256", first.mac).update(payload).digest()
  )
  await assert.rejects(decryptString(encrypted, first), /MAC mismatch/)
  first.enc[0] ^= 1
  const changed = await encryptString("changed key", first)
  const copy = { enc: first.enc.slice(), mac: first.mac.slice() }
  assert.equal(await decryptString(changed, copy), "changed key")
})

test("a failed import is evicted so a later attempt can retry", async (t) => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const actualImport = crypto.subtle.importKey.bind(crypto.subtle)
  let attempts = 0
  t.mock.method(crypto.subtle, "importKey", (...args) => {
    if (++attempts === 1)
      return Promise.reject(new Error("temporary import failure"))
    return actualImport(...args)
  })
  await assert.rejects(
    importVaultKey(bytes, "AES-CBC"),
    /temporary import failure/
  )
  assert.equal(
    (await importVaultKey(bytes, "AES-CBC")).algorithm.name,
    "AES-CBC"
  )
  assert.equal(attempts, 2)
})
