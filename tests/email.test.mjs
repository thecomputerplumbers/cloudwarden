import assert from "node:assert/strict"
import { test } from "node:test"
import { createMailer } from "../packages/email/src/index.ts"

test("transactional mail escapes untrusted names and includes a text link", async () => {
  let delivered
  const mail = createMailer(
    {
      send: async (message) => {
        delivered = message
      },
    },
    "cloudwarden@example.com"
  )
  await mail({
    to: "member@example.org",
    subject: "Invitation",
    message: 'Join <script>alert("x")</script>',
    url: "https://example.com/invitations/123?a=1&b=2",
    label: "Review invitation",
  })
  assert.ok(!delivered.html.includes("<script>"))
  assert.ok(delivered.html.includes("&lt;script&gt;"))
  assert.ok(delivered.html.includes("a=1&amp;b=2"))
  assert.ok(
    delivered.text.includes("https://example.com/invitations/123?a=1&b=2")
  )
})

test("mail refuses missing senders and unsafe links, and surfaces delivery failures", async () => {
  assert.throws(() => createMailer({ send: async () => {} }, ""), /EMAIL_FROM/)
  const mail = createMailer(
    {
      send: async () => {
        throw new Error("Delivery unavailable")
      },
    },
    "cloudwarden@example.com"
  )
  const message = {
    to: "member@example.org",
    subject: "Verify",
    message: "Verify email",
    label: "Verify",
    url: "javascript:alert(1)",
  }
  await assert.rejects(mail(message), /Invalid email link/)
  await assert.rejects(
    mail({ ...message, url: "https://example.com/verify" }),
    /Delivery unavailable/
  )
})
