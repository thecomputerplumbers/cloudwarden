import assert from "node:assert/strict"
import { test } from "node:test"
import { recoveryInput, runRecovery } from "../scripts/do-recovery.mjs"

const id = "11111111-1111-1111-1111-111111111111"
const at = "2026-10-06T00:00:00Z"
const token = "local-test-recovery-credential-2026"

test("recovery command requires an explicit restore flag and a precise target", () => {
  assert.throws(() => recoveryInput(["staging", "restore", "account", id, at]))
  assert.throws(() =>
    recoveryInput(["staging", "inspect", "account", "../other", at])
  )
  assert.throws(() =>
    recoveryInput(["staging", "inspect", "account", id, "yesterday"])
  )
  assert.deepEqual(
    recoveryInput(["staging", "restore", "account", id, at, "--apply"]),
    { environment: "staging", action: "restore", kind: "account", id, at }
  )
})

test("recovery command sends the credential in a header and names the target", async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(
      url,
      "https://cloudwarden-staging.thecomputerplumbers.com/__ops/recovery/restore"
    )
    assert.equal(options.headers.Authorization, `Bearer ${token}`)
    assert.deepEqual(JSON.parse(options.body), {
      kind: "account",
      id,
      at,
      confirm: `RESTORE account ${id}`,
    })
    return Response.json({ restartRequested: true }, { status: 202 })
  }
  assert.deepEqual(
    await runRecovery(["staging", "restore", "account", id, at, "--apply"], {
      token,
    }),
    { restartRequested: true }
  )
  assert.equal(calls, 1)
})
