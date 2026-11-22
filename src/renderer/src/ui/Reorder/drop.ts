// Drag-to-reorder maths (D45), pure: which gap a pointer points to and where the row lands, and
// which old row a row came from after a move (for the glide). Doc: docs/conventions/ui.md#reordering-lists-d45

/** The gap (0…n) a pointer at `y` points to: how many rows' middles lie above it. */
export function dropGap(mids: readonly number[], y: number): number {
  let gap = 0
  for (const m of mids) if (m < y) gap++
  return gap
}

/** The index row `from` ends at when dropped in gap `gap` (gaps `from` and `from + 1` keep it). */
export function dropIndex(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap
}

/** After row `from` moved to `to`: which old index the row now at `j` was. */
export function movedFrom(j: number, from: number, to: number): number {
  if (j === to) return from
  if (from < to && j >= from && j < to) return j + 1
  if (to < from && j > to && j <= from) return j - 1
  return j
}

/** `list` with the item at `from` moved to `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  const [it] = next.splice(from, 1)
  if (it === undefined) return [...list]
  next.splice(to, 0, it)
  return next
}
