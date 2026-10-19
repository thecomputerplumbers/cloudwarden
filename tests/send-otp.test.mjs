import assert from "node:assert/strict"
import { test } from "node:test"
import { newSendOtp, sendOtpHash } from "../apps/web/worker/send-otp.ts"

test("Send OTP proofs bind the secret, Send, recipient, and code", async () => {
  const args = [
    "local-send-otp-test-secret-with-32-chars",
    "send-id",
    "recipient@example.test",
    "123456",
  ]
  const expected = await sendOtpHash(...args)
  for (let i = 0; i < args.length; i++) {
    const changed = [...args]
    changed[i] += "other"
    assert.notEqual(await sendOtpHash(...changed), expected)
  }
  assert.equal(expected.length, 64)
  assert.match(newSendOtp(), /^\d{6}$/)
  await assert.rejects(sendOtpHash("", "id", "email", "123456"))
})
