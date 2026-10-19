import assert from "node:assert/strict"
import { test } from "node:test"
import {
  issueAttachmentToken,
  verifyAttachmentToken,
} from "../apps/web/worker/attachment-token.ts"

test("attachment proofs bind the attachment, cipher, member, expiry, and signing secret", async (t) => {
  const args = ["test-secret", "attachment", "cipher", "member"]
  const token = await issueAttachmentToken(...args)
  assert.equal(await verifyAttachmentToken(...args, token), true)
  for (let index = 0; index < args.length; index++) {
    const changed = [...args]
    changed[index] += "-other"
    assert.equal(await verifyAttachmentToken(...changed, token), false)
  }
  assert.equal(
    await verifyAttachmentToken(...args, token.replace(/^\d/, "0")),
    false
  )
  const changedExpiry = token.replace(
    /^\d+/,
    String(Number(token.split("-")[0]) - 1)
  )
  assert.equal(await verifyAttachmentToken(...args, changedExpiry), false)
  assert.equal(await verifyAttachmentToken(...args, "invalid"), false)
  t.mock.method(Date, "now", () => Number(token.split("-")[0]) + 1)
  assert.equal(await verifyAttachmentToken(...args, token), false)
})
