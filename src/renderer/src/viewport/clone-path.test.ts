// The clone path's drawing maths (v0.4 task U3): overlay rows, markers and ghosts, and which
// instance numbers show. Doc: docs/conventions/ui.md#clone-path-in-the-viewport
import { describe, expect, it, vi } from 'vitest'
import { chipsShown, clonePathOverlay, type ClonePathData, type OverlayOptions } from './clone-path'

// the face: the top of a 10 mm stock, u along x, v along y
const face = {
  at: (u: number, v: number) => [u, v, 10] as [number, number, number],
  shift: (du: number, dv: number) => [du, dv, 0] as [number, number, number],
}
const data: ClonePathData = {
  instances: [
    { n: 1, at: [0, 0] },
    { n: 2, at: [10, 0] },
    { n: 4, at: [30, 0] },
  ],
  rows: [
    {
      path: [
        [0, 0],
        [30, 0],
      ],
      points: [
        { at: [10, 0], kind: 'clone', n: 2 },
        { at: [20, 0], kind: 'skipped', n: 3 },
        { at: [30, 0], kind: 'clone', n: 4 },
      ],
    },
    {
      path: [
        [30, 0],
        [30, 5],
      ],
      centre: [30, -5],
      points: [{ at: [30, 5], kind: 'duplicate', n: 5 }],
    },
  ],
}
const footprint = [
  [
    [-1, -1, 10],
    [1, -1, 10],
    [1, 1, 10],
  ] as [number, number, number][],
]
const options = (o: Partial<OverlayOptions> = {}): OverlayOptions => ({
  focusedRow: 1,
  footprint,
  draft: false,
  interactive: true,
  outside: new Set([4]),
  label: (n, _at, skipped) => `Clone ${n}${skipped ? ', skipped' : ''}`,
  hint: (n, skipped) => (skipped ? 'Restore' : `Skip ${n}`),
  sourceHint: 'The source',
  onToggle: () => {},
  ...o,
})

describe('clonePathOverlay', () => {
  it('places rows on the face, the focused one marked, an arc row with its circle', () => {
    const o = clonePathOverlay(data, face, options())
    expect(o.rows.map((r) => r.focused)).toEqual([false, true])
    expect(o.rows[0]!.line).toEqual([
      [0, 0, 10],
      [30, 0, 10],
    ])
    expect(o.rows[1]!.centre).toEqual([30, -5, 10])
    for (const p of o.rows[1]!.circle!) expect(Math.hypot(p[0] - 30, p[1] + 5)).toBeCloseTo(5, 6)
    expect(o.axes).toEqual({ u: [1, 0, 0], v: [0, 1, 0] })
  })

  it('a marker per number in order: the source, clones, skipped, duplicates; outside flagged', () => {
    const o = clonePathOverlay(data, face, options())
    expect(o.markers.map((m) => [m.n, m.state, m.outside])).toEqual([
      [1, 'source', false],
      [2, 'clone', false],
      [3, 'skipped', false],
      [4, 'clone', true],
      [5, 'duplicate', false],
    ])
    expect(o.markers[2]!.label).toBe('Clone 3, skipped')
    expect(o.markers[2]!.hint).toBe('Restore')
    // a duplicate cannot be skipped: no hint
    expect(o.markers[4]!.hint).toBeUndefined()
  })

  it('ghosts: skipped positions dashed; a draft adds every clone solid', () => {
    const stored = clonePathOverlay(data, face, options())
    expect(stored.ghosts).toHaveLength(1)
    expect(stored.ghosts[0]!.dashed).toBe(true)
    expect(stored.ghosts[0]!.loops[0]![0]).toEqual([19, -1, 10])
    const draft = clonePathOverlay(data, face, options({ draft: true, interactive: false }))
    expect(draft.ghosts.map((g) => g.dashed)).toEqual([false, true, false])
    expect(draft.markers.every((m) => m.hint === undefined)).toBe(true)
  })

  it('passes the toggle through', () => {
    const onToggle = vi.fn()
    clonePathOverlay(data, face, options({ onToggle })).onToggle(3)
    expect(onToggle).toHaveBeenCalledWith(3)
  })
})

describe('chipsShown', () => {
  it('hides numbers of markers closer than 24 px and those off screen', () => {
    expect(chipsShown([[0, 0], [10, 0], [100, 0], null, [200, 0], [224, 0]])).toEqual([
      false,
      false,
      true,
      false,
      true,
      true,
    ])
  })
})
