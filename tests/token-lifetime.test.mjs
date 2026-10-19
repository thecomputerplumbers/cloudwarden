import assert from "node:assert/strict"
import { test } from "node:test"
import { accessTokenLifetimeSeconds } from "../apps/web/worker/token-lifetime.ts"

test("interactive token lifetime defaults and overrides match upstream client scope", () => {
  for (const client of ["web", "browser", "desktop", "mobile", "cli"]) {
    assert.equal(accessTokenLifetimeSeconds({}, client), 3600)
    assert.equal(
      accessTokenLifetimeSeconds(
        { ACCESS_TOKEN_LIFETIME_SECONDS: "900" },
        client
      ),
      900
    )
  }
  assert.equal(
    accessTokenLifetimeSeconds(
      { ACCESS_TOKEN_LIFETIME_SECONDS: "900" },
      "connector"
    ),
    86400
  )
  assert.equal(
    accessTokenLifetimeSeconds(
      { ACCESS_TOKEN_LIFETIME_SECONDS: "900" },
      "cli",
      true
    ),
    3600
  )
  for (const invalid of [
    "",
    "0",
    "-1",
    "1.5",
    "Infinity",
    "2147483648",
    "1e3",
    " 900",
  ])
    assert.throws(() =>
      accessTokenLifetimeSeconds(
        { ACCESS_TOKEN_LIFETIME_SECONDS: invalid },
        "web"
      )
    )
})
