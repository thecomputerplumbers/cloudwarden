import assert from "node:assert/strict"
import { test } from "node:test"
import { AppError, publicError, errorResponse } from "../apps/web/lib/errors.ts"
test("unexpected errors never expose internal messages; validation retains field context", async () => {
  const privateError = new Error("Authorization: Bearer secret SQL password")
  assert.ok(!JSON.stringify(publicError(privateError)).includes("secret"))
  assert.equal(errorResponse(privateError).status, 500)
  const response = errorResponse(
    new AppError("INVALID_INPUT", "Check fields", { name: "Required" }),
    "request-123"
  )
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: "Check fields",
    code: "INVALID_INPUT",
    fields: { name: "Required" },
    requestId: "request-123",
  })
})
