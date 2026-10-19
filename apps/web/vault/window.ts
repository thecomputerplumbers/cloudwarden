/** Item rows have a 52px button and a 2px gap. Keep scrolling and keyboard movement in the same coordinate system. */
export const ITEM_ROW_HEIGHT = 50
const OVERSCAN = 8

export function itemWindow(
  length: number,
  scrollTop: number,
  height: number,
  rowHeight = ITEM_ROW_HEIGHT
) {
  const start = Math.min(
    Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN),
    Math.max(0, length - 1)
  )
  const end = Math.min(
    length,
    Math.max(start + 1, Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN)
  )
  return { start, end }
}
