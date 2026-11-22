// Handles of the Shape Editor (task U1) and the flat view's mapping: which handles an item has,
// what a drag does to the numbers, where an issue marks the outline, and the screen mapping.
// Doc: docs/conventions/ui.md#shape-editor
import { describe, expect, it } from 'vitest'
import type { ShapeItem } from '../../../core/design/shape.dto'
import { chainPath, fitView, toScreen, toShape, zoomAt } from './flat-view'
import {
  arcGeometry,
  badMark,
  constrain15,
  dragHandle,
  itemHandles,
  segmentElements,
  shownHandles,
} from './shape-handles'

type Item = ShapeItem<number>
const rect: Item = {
  kind: 'rectangle',
  op: 'add',
  center: [0, 0],
  length: 40,
  width: 20,
  cornerRadius: 0,
}
const path: Item = {
  kind: 'path',
  op: 'add',
  start: [0, 0],
  closed: false,
  segments: [
    { kind: 'line', to: [40, 0] },
    { kind: 'arc', to: [40, 20], radius: 10, cw: false },
  ],
}

describe('shape handles', () => {
  it('gives each item kind its handles', () => {
    expect(itemHandles(rect).map((h) => h.id)).toEqual([
      'center',
      'length',
      'width',
      'cornerRadius',
    ])
    expect(itemHandles(path).map((h) => h.id)).toEqual([
      'start',
      'seg.0.to',
      'seg.1.to',
      'seg.1.radius',
    ])
    const length = itemHandles(rect).find((h) => h.id === 'length')!
    expect(length.at).toEqual([20, 0])
    expect(length.paths).toEqual([['length']])
  })

  it('drags sizes symmetrically and the centre freely (15° with Shift)', () => {
    expect(dragHandle(rect, 'length', [30, 7])).toMatchObject({ length: 60, width: 20 })
    expect(dragHandle(rect, 'width', [3, 15])).toMatchObject({ length: 40, width: 30 })
    expect(dragHandle(rect, 'center', [5, 6])).toMatchObject({ center: [5, 6] })
    const c = constrain15([0, 0], [10, 1])
    expect(c[1]).toBeCloseTo(0)
    expect(c[0]).toBeCloseTo(Math.hypot(10, 1))
  })

  it('keeps the corner radius within half the narrower side', () => {
    const r = dragHandle(rect, 'cornerRadius', [-100, -100])
    expect(r.kind === 'rectangle' && r.cornerRadius).toBe(10)
  })

  it('moves a segment end point and flips an arc to large past the half circle', () => {
    const moved = dragHandle(path, 'seg.0.to', [50, 0])
    expect(moved.kind === 'path' && moved.segments[0]!.to).toEqual([50, 0])
    const g = arcGeometry([40, 0], [40, 20], 10, false, false)!
    expect(g.chord).toBe(20)
    const far = dragHandle(path, 'seg.1.radius', [60, 10])
    if (far.kind !== 'path' || far.segments[1]!.kind !== 'arc') throw new Error('arc expected')
    expect(far.segments[1]!.large).toBe(true)
  })

  it('shows only the selected segment handles above 20 segments (L3-7)', () => {
    // a closed 24-gon of lines with one arc at segment 5
    const many: Item = {
      kind: 'path',
      op: 'add',
      start: [10, 0],
      closed: true,
      segments: Array.from({ length: 24 }, (_, k) => {
        const a = ((k + 1) * Math.PI) / 12
        const to: [number, number] = [10 * Math.cos(a), 10 * Math.sin(a)]
        return k === 5
          ? { kind: 'arc' as const, to, radius: 5, cw: false }
          : { kind: 'line' as const, to }
      }),
    }
    const all = itemHandles(many)
    expect(shownHandles(path, itemHandles(path), null)).toHaveLength(4)
    expect(shownHandles(many, all, null)).toEqual([])
    expect(shownHandles(many, all, 0).map((h) => h.id)).toEqual(['start', 'seg.0.to'])
    expect(shownHandles(many, all, 5).map((h) => h.id)).toEqual([
      'seg.4.to',
      'seg.5.to',
      'seg.5.radius',
    ])
    const per = segmentElements(many)
    expect(per).toHaveLength(24)
    expect(per[5]!.every((e) => e.kind === 'arc')).toBe(true)
    expect(per[23]!.at(-1)!.b[0]).toBeCloseTo(10)
  })

  it('marks the segment an issue points at, else the whole item', () => {
    expect(badMark(['segments', 1, 'radius'], path)).toEqual({ kind: 'segment', segment: 1 })
    expect(badMark(['closed'], path)).toEqual({ kind: 'closing' })
    expect(badMark(['length'], rect)).toEqual({ kind: 'item' })
  })
})

describe('flat view', () => {
  it('fits bounds with y up and maps back', () => {
    const v = fitView({ min: [0, 0], max: [100, 50] }, 800, 600)
    const s = toScreen(v, [100, 50])
    expect(s[1]).toBeLessThan(toScreen(v, [0, 0])[1]) // y up
    expect(toShape(v, s)[0]).toBeCloseTo(100)
    expect(toShape(v, s)[1]).toBeCloseTo(50)
  })

  it('zooms about the cursor', () => {
    const v = fitView({ min: [0, 0], max: [100, 50] }, 800, 600)
    const at: [number, number] = [200, 300]
    const before = toShape(v, at)
    const after = toShape(zoomAt(v, 2, at), at)
    expect(after[0]).toBeCloseTo(before[0])
    expect(after[1]).toBeCloseTo(before[1])
  })

  it('draws a full circle as two arcs', () => {
    const v = { scale: 1, ox: 0, oy: 0 }
    const d = chainPath(
      v,
      [{ kind: 'arc', a: [10, 0], b: [10, 0], centre: [0, 0], ccw: true }],
      true,
    )
    expect(d.match(/A/g)).toHaveLength(2)
  })
})
