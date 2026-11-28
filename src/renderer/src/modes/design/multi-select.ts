// The Design navigator's multi-selection (hardening DF135): the pure part – Cmd/Ctrl toggles,
// Shift ranges over the top-level rows in list order, and what each bulk action would change
// (one new `alreadyCut` / `disabled` list, the removal order). Headless and React-free.
// Doc: docs/conventions/ui.md#multi-select-in-the-design-navigator-df135
import { isDisabled, type DisabledState } from '../../../../core/design/disabled'

/** `ids` in the order of `order` (the top-level rows in design order), unknown ones dropped. */
export function inOrder(order: readonly string[], ids: Iterable<string>): string[] {
  const set = new Set(ids)
  return order.filter((x) => set.has(x))
}

/** Cmd/Ctrl-click: `id` added to or removed from `current`. */
export function toggled(
  order: readonly string[],
  current: readonly string[],
  id: string,
): string[] {
  return current.includes(id) ? current.filter((x) => x !== id) : inOrder(order, [...current, id])
}

/** Shift-click / Shift+↑↓: the rows from `anchor` to `to`, both included (just `to` if unknown). */
export function rangeOf(order: readonly string[], anchor: string, to: string): string[] {
  const a = order.indexOf(anchor)
  const b = order.indexOf(to)
  if (b < 0) return []
  if (a < 0) return [to]
  return order.slice(Math.min(a, b), Math.max(a, b) + 1)
}

/** One bulk change of a part list: the new list and how many selected items it changes. */
export interface ListChange {
  readonly list: readonly string[]
  readonly count: number
}

/** What the bulk actions on `ids` would do; undefined: that action does not apply. */
export interface BulkPlan {
  readonly markCut: ListChange | undefined
  readonly unmarkCut: ListChange | undefined
  readonly disable: ListChange | undefined
  readonly enable: ListChange | undefined
  /** The removal order: later rows first, so an item built on another selected one goes first. */
  readonly removeOrder: readonly string[]
}

/**
 * The bulk actions of a multi-selection (`ids`, top-level rows): a disabled item is left out of
 * the cut mark (a single disabled row's menu has none either); Enable is for the items switched
 * off themselves.
 */
export function bulkPlan(
  ids: readonly string[],
  alreadyCut: readonly string[],
  disabled: readonly string[],
  off: DisabledState,
): BulkPlan {
  const live = ids.filter((x) => !isDisabled(off, x))
  const toMark = live.filter((x) => !alreadyCut.includes(x))
  const toUnmark = ids.filter((x) => alreadyCut.includes(x))
  const toDisable = ids.filter((x) => !off.roots.has(x))
  const toEnable = ids.filter((x) => off.roots.has(x))
  const change = (list: readonly string[], count: number) =>
    count === 0 ? undefined : { list, count }
  return {
    markCut: change([...alreadyCut, ...toMark], toMark.length),
    unmarkCut: change(
      alreadyCut.filter((x) => !toUnmark.includes(x)),
      toUnmark.length,
    ),
    disable: change([...disabled, ...toDisable], toDisable.length),
    enable: change(
      disabled.filter((x) => !toEnable.includes(x)),
      toEnable.length,
    ),
    removeOrder: [...ids].reverse(),
  }
}
