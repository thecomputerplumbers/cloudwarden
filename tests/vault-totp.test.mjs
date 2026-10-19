import assert from "node:assert/strict"
import { test } from "node:test"
import { parseTotp, totpCode } from "../apps/web/vault/totp.ts"

// RFC 6238 appendix B: the ASCII secret "12345678901234567890", 8 digits, SHA-1.
const RFC =
  "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&algorithm=SHA1"

test("TOTP matches the RFC 6238 test vectors", async () => {
  const config = parseTotp(RFC)
  for (const [seconds, expected] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1234567890, "89005924"],
    [20000000000, "65353130"],
  ])
    assert.equal((await totpCode(config, seconds * 1000)).code, expected)
})

test("a bare base32 secret gives 6 digits on a 30-second period", async () => {
  const code = await totpCode(parseTotp("JBSWY3DPEHPK3PXP"), 59_000)
  assert.equal(code.code.length, 6)
  assert.equal(code.remaining, 1)
  assert.equal(parseTotp("not base32!"), null)
})
