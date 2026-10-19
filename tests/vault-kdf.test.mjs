import assert from "node:assert/strict"
import { pbkdf2Sync } from "node:crypto"
import { test } from "node:test"
import { makeMasterKey } from "../apps/web/vault/crypto/kdf.ts"

test("PBKDF2 master keys use the normalized email and account iterations", async () => {
  const key = await makeMasterKey("test password", " User@Example.test ", {
    kdf: 0,
    iterations: 600000,
  })
  assert.deepEqual(
    Buffer.from(key),
    pbkdf2Sync("test password", "user@example.test", 600000, 32, "sha256")
  )
})

test("on-demand Argon2 derives the same master key as the eager implementation", async () => {
  const key = await makeMasterKey("argon test password", "Argon@example.test", {
    kdf: 1,
    iterations: 2,
    memory: 8,
    parallelism: 1,
  })
  assert.equal(
    Buffer.from(key).toString("hex"),
    "58d68080396a5a8afbbf22716483399e9f4145b68f181c01cd9fe8d11e727254"
  )
})
