import assert from "node:assert/strict"
import { test } from "node:test"
import { validCollectionAccess } from "../apps/web/worker/collection-access.ts"

test("collection management cannot be combined with read-only or hidden passwords", () => {
  for (const readOnly of [false, true])
    for (const hidePasswords of [false, true]) {
      assert.equal(
        validCollectionAccess({ readOnly, hidePasswords, manage: false }),
        true
      )
      assert.equal(
        validCollectionAccess({ readOnly, hidePasswords, manage: true }),
        !readOnly && !hidePasswords
      )
    }
})
