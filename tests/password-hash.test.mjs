import assert from "node:assert/strict"
import { test } from "node:test"
import { hashClientPassword } from "../apps/web/worker/password-hash.ts"

// Computed with the previous @noble/hashes-only implementation: stored hashes must keep verifying.
const PASSWORD = "bWFzdGVyLXBhc3N3b3JkLWhhc2g="
const SALT = "user@example.com"
const EXPECTED =
  "c9a78cc6bc7ca81a8ed79397611596c9bc1d5d67a4173052ee29dafab5b66f13"

test("the native password hash matches the stored-hash format", async () => {
  assert.equal(await hashClientPassword(PASSWORD, SALT), EXPECTED)
})

test("a runtime that refuses 120,000 PBKDF2 rounds falls back to the same hash", async (t) => {
  t.mock.method(crypto.subtle, "deriveBits", async () => {
    throw new DOMException(
      "iteration counts above 100000 are not supported",
      "NotSupportedError"
    )
  })
  t.mock.method(console, "error", () => {})
  assert.equal(await hashClientPassword(PASSWORD, SALT), EXPECTED)
})
