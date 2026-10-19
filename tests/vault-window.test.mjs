import assert from "node:assert/strict"
import { test } from "node:test"
import { itemWindow, ITEM_ROW_HEIGHT } from "../apps/web/vault/window.ts"

test("large vaults mount a bounded window containing every visible row", () => {
  const length = 20000
  for (const height of [320, 600, 1080]) {
    for (const top of [0, 1, 27, 540, 19000 * ITEM_ROW_HEIGHT]) {
      const { start, end } = itemWindow(length, top, height)
      assert.ok(start <= Math.floor(top / ITEM_ROW_HEIGHT))
      assert.ok(end >= Math.ceil((top + height) / ITEM_ROW_HEIGHT))
      assert.ok(end - start <= Math.ceil(height / ITEM_ROW_HEIGHT) + 17)
    }
  }
})

test("empty, short, and resized vaults never select rows outside the list", () => {
  assert.deepEqual(itemWindow(0, 0, 600), { start: 0, end: 0 })
  assert.deepEqual(itemWindow(3, 0, 600), { start: 0, end: 3 })
  for (const top of [0, 1, 270, 100000]) {
    const { start, end } = itemWindow(5, top, 600)
    assert.ok(start >= 0 && start < 5)
    assert.ok(end > start && end <= 5)
  }
})

test("larger text keeps visible rows inside the rendered window", () => {
  const rowHeight = ITEM_ROW_HEIGHT * 1.25
  const { start, end } = itemWindow(500, rowHeight * 100, 600, rowHeight)
  assert.ok(start <= 100)
  assert.ok(end >= 100 + Math.ceil(600 / rowHeight))
})
