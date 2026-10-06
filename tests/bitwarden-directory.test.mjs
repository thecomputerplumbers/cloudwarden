import assert from "node:assert/strict"
import test from "node:test"

import { readVaultDirectory } from "../apps/web/worker/bitwarden-directory.ts"

const source =
  "https://auth.thecomputerplumbers.com/api/integrations/vault/scim/v2/Users"
const user = {
  id: "41850bc4-fe8c-42cd-97c4-88a61cfaa3a5",
  userName: "Member@Example.test",
  displayName: "Member",
  active: true,
}
function page(resources, total = resources.length, start = 1, version = "v1") {
  return Response.json({
    totalResults: total,
    startIndex: start,
    itemsPerPage: resources.length,
    Resources: resources,
    "urn:thecomputerplumbers:scim:directoryVersion": version,
  })
}

test("reads a complete authenticated paginated directory", async () => {
  let calls = 0
  const users = await readVaultDirectory(
    source,
    "local-secret",
    async (url, init) => {
      const parsed = new URL(url)
      assert.equal(parsed.origin, "https://auth.thecomputerplumbers.com")
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        "Bearer local-secret"
      )
      assert.equal(init.redirect, "manual")
      calls++
      return calls === 1
        ? page([user], 2)
        : page(
            [
              {
                ...user,
                id: "b1850bc4-fe8c-42cd-97c4-88a61cfaa3a5",
                userName: "Other@Example.test",
              },
            ],
            2,
            2
          )
    }
  )
  assert.deepEqual(
    users.map((entry) => entry.email),
    ["member@example.test", "other@example.test"]
  )
})

test("rejects partial, changing, and duplicate snapshots", async () => {
  let calls = 0
  await assert.rejects(
    readVaultDirectory(source, "local-secret", async () =>
      ++calls === 1 ? page([user], 2) : page([], 2, 2)
    ),
    /incomplete/
  )
  calls = 0
  await assert.rejects(
    readVaultDirectory(source, "local-secret", async () =>
      ++calls === 1
        ? page([user], 2)
        : page(
            [{ ...user, id: "b1850bc4-fe8c-42cd-97c4-88a61cfaa3a5" }],
            2,
            2,
            "v2"
          )
    ),
    /changed/
  )
  await assert.rejects(
    readVaultDirectory(source, "local-secret", async () => page([user, user])),
    /invalid/
  )
  await assert.rejects(
    readVaultDirectory(source, "local-secret", async () => page([null])),
    /invalid/
  )
  await assert.rejects(
    readVaultDirectory(
      source,
      "local-secret",
      async () => new Response("", { status: 503 })
    ),
    /503/
  )
})

test("rejects insecure or redirecting directory sources", async () => {
  await assert.rejects(
    readVaultDirectory("http://localhost/Users", "token"),
    /configuration/
  )
  await assert.rejects(
    readVaultDirectory(
      source,
      "token",
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://elsewhere.test/" },
        })
    ),
    /302/
  )
})

test("reads group IDs and rejects malformed group membership", async () => {
  const users = await readVaultDirectory(source, "token", async () =>
    page([{ ...user, groups: [{ value: "engineering" }] }])
  )
  assert.deepEqual(users[0].groups, [
    { id: "engineering", name: "engineering" },
  ])
  const named = await readVaultDirectory(source, "token", async () =>
    page([
      { ...user, groups: [{ value: "engineering", display: "Engineering" }] },
    ])
  )
  assert.deepEqual(named[0].groups, [
    { id: "engineering", name: "Engineering" },
  ])
  await assert.rejects(
    readVaultDirectory(source, "token", async () =>
      page([{ ...user, groups: [{ display: "Engineering" }] }])
    ),
    /groups are invalid/
  )
  await assert.rejects(
    readVaultDirectory(source, "token", async () =>
      page([
        {
          ...user,
          groups: [{ value: "engineering" }, { value: "engineering" }],
        },
      ])
    ),
    /groups are invalid/
  )
})
