import assert from "node:assert/strict"
import { test } from "node:test"
import { domainsResponse } from "../apps/web/worker/equivalent-domains.ts"

test("global equivalent domains use upstream stable IDs and honor per-account exclusions", () => {
  const user = {
    equivalentDomains: '[["example.test","example.org"]]',
    excludedGlobalDomains: "[0]",
  }
  const settings = domainsResponse(user)
  assert.equal(settings.globalEquivalentDomains.length, 22)
  assert.equal(
    settings.globalEquivalentDomains.find((group) => group.type === 0).excluded,
    true
  )
  assert.ok(
    settings.globalEquivalentDomains
      .find((group) => group.type === 10)
      .domains.includes("cloud.microsoft")
  )
  assert.equal(
    domainsResponse(user, false).globalEquivalentDomains.some(
      (group) => group.type === 0
    ),
    false
  )
  assert.deepEqual(settings.equivalentDomains, [
    ["example.test", "example.org"],
  ])
  settings.globalEquivalentDomains[0].domains.push("must-not-persist.example")
  assert.equal(
    domainsResponse(user).globalEquivalentDomains[0].domains.includes(
      "must-not-persist.example"
    ),
    false
  )
  assert.deepEqual(
    domainsResponse({ equivalentDomains: "bad", excludedGlobalDomains: "{}" })
      .equivalentDomains,
    []
  )
})
