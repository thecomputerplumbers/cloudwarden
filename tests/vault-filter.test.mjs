import assert from "node:assert/strict"
import { test } from "node:test"
import {
  onlyVault,
  toggleVault,
  visibleItems,
} from "../apps/web/vault/filter.ts"

const item = (name, extra = {}) => ({
  id: name,
  name,
  kind: "login",
  organizationId: null,
  folderId: null,
  collectionIds: [],
  favorite: false,
  deleted: false,
  notes: null,
  login: { username: null, password: null, totp: null, uris: [] },
  card: null,
  identity: null,
  ...extra,
})
const items = [
  item("GitHub", {
    login: {
      username: "seth",
      password: null,
      totp: null,
      uris: [{ uri: "https://github.com/login", match: null }],
    },
    favorite: true,
  }),
  item("Router", { organizationId: "org-a", collectionIds: ["col-1"] }),
  item("Family Netflix", { organizationId: "org-b" }),
  item("Old bank", { deleted: true }),
  item("Visa", { kind: "card", card: { brand: "Visa" } }),
]
const names = (list) => list.map((entry) => entry.name)
const all = { view: "all", query: "" }

test("every vault is shown until one is left out", () => {
  assert.deepEqual(names(visibleItems(items, new Set(), all)), [
    "GitHub",
    "Router",
    "Family Netflix",
    "Visa",
  ])
  assert.deepEqual(names(visibleItems(items, new Set(["org-b"]), all)), [
    "GitHub",
    "Router",
    "Visa",
  ])
  assert.deepEqual(names(visibleItems(items, new Set(["personal"]), all)), [
    "Router",
    "Family Netflix",
  ])
})

test("views, collections, trash, and search narrow within the selected vaults", () => {
  assert.deepEqual(
    names(visibleItems(items, new Set(), { view: "favorites", query: "" })),
    ["GitHub"]
  )
  assert.deepEqual(
    names(visibleItems(items, new Set(), { view: "card", query: "" })),
    ["Visa"]
  )
  assert.deepEqual(
    names(visibleItems(items, new Set(), { view: "trash", query: "" })),
    ["Old bank"]
  )
  assert.deepEqual(
    names(
      visibleItems(items, new Set(), {
        view: "all",
        collectionId: "col-1",
        query: "",
      })
    ),
    ["Router"]
  )
  assert.deepEqual(
    names(
      visibleItems(items, new Set(), { view: "all", query: "github seth" })
    ),
    ["GitHub"]
  )
  assert.deepEqual(
    names(
      visibleItems(items, new Set(["personal"]), {
        view: "all",
        query: "github",
      })
    ),
    []
  )
})

test("toggling keeps at least one vault selected; 'only' leaves out the rest", () => {
  const vaults = ["personal", "org-a", "org-b"]
  let excluded = toggleVault(new Set(), vaults, "org-b")
  assert.deepEqual([...excluded], ["org-b"])
  excluded = toggleVault(excluded, vaults, "org-a")
  assert.deepEqual([...excluded].sort(), ["org-a", "org-b"])
  assert.deepEqual(
    [...toggleVault(excluded, vaults, "personal")].sort(),
    ["org-a", "org-b"],
    "the last vault stays on"
  )
  assert.deepEqual([...toggleVault(excluded, vaults, "org-a")], ["org-b"])
  assert.deepEqual([...onlyVault(vaults, "org-a")].sort(), [
    "org-b",
    "personal",
  ])
})
