// Drag to reorder (D45) in jsdom: rows laid out 30 px apart (jsdom has no layout) and a drag of a
// row's grip to a y (docs/conventions/ui.md#reordering-lists-d45).
import { act, fireEvent } from '@testing-library/react'
import { vi } from 'vitest'

export const ROW_PX = 30

/** Lays every reorderable row out at `index · 30 px`, 30 px high; returns the restore function. */
export function layOutRows(): () => void {
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const li = this.closest('[data-reorder-item]')
    const i = li?.parentElement ? [...li.parentElement.children].indexOf(li) : 0
    const top = i * ROW_PX
    return {
      top,
      bottom: top + ROW_PX,
      height: ROW_PX,
      y: top,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      toJSON: () => ({}),
    } as DOMRect
  })
  return () => spy.mockRestore()
}

/** The grip of the reorderable row holding `el`. */
export function gripOf(el: Element): HTMLElement {
  const grip = el.closest('[data-reorder-item]')?.querySelector<HTMLElement>('[data-reorder-grip]')
  if (!grip) throw new Error('no grip on this row')
  return grip
}

/** Presses `grip`, moves to `y` (px, in the 30 px layout) and releases unless `hold`. */
export function dragTo(grip: HTMLElement, y: number, hold = false): void {
  const li = grip.closest('[data-reorder-item]')!
  const start = [...li.parentElement!.children].indexOf(li) * ROW_PX + ROW_PX / 2
  act(() => {
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: start })
  })
  act(() => {
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: (start + y) / 2 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: y })
  })
  if (!hold)
    act(() => {
      fireEvent.pointerUp(grip, { pointerId: 1, clientY: y })
    })
}
