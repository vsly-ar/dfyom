// Drag to reorder (D45) auto-scroll (hardening U3): a drag near the bottom edge of the list's
// scrolling container scrolls it, and the drop gap follows the scroll.
// Doc: docs/conventions/ui.md#reordering-lists-d45
import { act, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderUi } from '../../test/render'
import { DragGrip, useReorder } from './Reorder'
import { moveItem } from './drop'

const ROW = 30
const VIEW = 90
const N = 10

function List({ onMove }: { onMove(from: number, to: number): void }): React.JSX.Element {
  const [rows, setRows] = useState(() => Array.from({ length: N }, (_, i) => `Row ${i + 1}`))
  const reorder = useReorder({
    count: rows.length,
    order: rows.join(),
    onMove: (from, to) => {
      onMove(from, to)
      setRows((r) => moveItem(r, from, to))
      return true
    },
  })
  const { attachList } = reorder
  return (
    <div data-testid="scroller" style={{ overflowY: 'auto', height: VIEW }}>
      <ol ref={attachList} className={reorder.listClass} {...reorder.listProps}>
        {rows.map((r, i) => (
          <li key={r} {...reorder.itemProps(i)}>
            <DragGrip title="Drag to reorder" {...reorder.gripProps(i)} />
            {r}
          </li>
        ))}
      </ol>
    </div>
  )
}

describe('useReorder auto-scroll (U3)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('scrolls the container while the pointer is near its bottom edge; the drop follows', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const onMove = vi.fn()
    const { getByTestId, container } = renderUi(<List onMove={onMove} />)
    const scroller = getByTestId('scroller')
    let top = 0
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(N * ROW - VIEW, v))
      },
    })
    Object.defineProperty(scroller, 'scrollHeight', { get: () => N * ROW })
    Object.defineProperty(scroller, 'clientHeight', { get: () => VIEW })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = (y: number, h: number) =>
        ({ top: y, bottom: y + h, height: h, y, left: 0, right: 200, width: 200, x: 0 }) as DOMRect
      if (this === scroller) return rect(0, VIEW)
      const li = this.closest('[data-reorder-item]')
      const i = li?.parentElement ? [...li.parentElement.children].indexOf(li) : 0
      return rect(i * ROW - top, ROW)
    })
    const grip = container.querySelector<HTMLElement>('[data-reorder-grip]')!
    act(() => {
      fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: ROW / 2 })
    })
    act(() => {
      fireEvent.pointerMove(grip, { pointerId: 1, clientY: 40 })
      fireEvent.pointerMove(grip, { pointerId: 1, clientY: VIEW - 2 })
    })
    // a few frames at the edge scroll down
    for (let k = 0; k < 8 && frames.length > 0; k++) act(() => frames.shift()!(0))
    expect(top).toBeGreaterThan(0)
    act(() => {
      fireEvent.pointerUp(grip, { pointerId: 1, clientY: VIEW - 2 })
    })
    // dropped where the pointer is in the scrolled list, past the rows first in view
    expect(onMove).toHaveBeenCalledOnce()
    const [from, to] = onMove.mock.calls[0]!
    expect(from).toBe(0)
    expect(to).toBe(Math.floor((VIEW - 2 + top) / ROW + 0.5) - 1)
    expect(to).toBeGreaterThan(2)
  })

  it('does not scroll away from the edges', () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })
    const { getByTestId, container } = renderUi(<List onMove={() => {}} />)
    const scroller = getByTestId('scroller')
    Object.defineProperty(scroller, 'scrollHeight', { get: () => N * ROW })
    Object.defineProperty(scroller, 'clientHeight', { get: () => VIEW })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          top: 0,
          bottom: VIEW,
          height: VIEW,
          y: 0,
          left: 0,
          right: 0,
          width: 0,
          x: 0,
        }) as DOMRect,
    )
    const grip = container.querySelector<HTMLElement>('[data-reorder-grip]')!
    act(() => {
      fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 15 })
      fireEvent.pointerMove(grip, { pointerId: 1, clientY: 45 })
    })
    for (let k = 0; k < 4 && frames.length > 0; k++) act(() => frames.shift()!(0))
    expect(scroller.scrollTop).toBe(0)
    act(() => {
      fireEvent.pointerUp(grip, { pointerId: 1, clientY: 45 })
    })
  })
})
