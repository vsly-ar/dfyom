// The depth legend's levels (engraved-patterns.md § Depth legend): distinct levels deepest first,
// a path without levels is level 1, a continuous fade (Wood grain) is a range; a Line's paths read
// from their shapes' levels, an engraved pattern's owned shape through its resolved lines.
// Doc: docs/modes/engraved-patterns.md#depth-legend
import { describe, expect, it } from 'vitest'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { designSetup } from '../design.fixture'
import { LEGEND_TICKS_MAX, legendOf, lineLegend, pathLevelValues } from './legend'

const region2d = nodeRegion2d()

describe('legendOf', () => {
  it('distinct levels deepest first, merged within 0.01, clamped to 0..1', () => {
    expect(legendOf([0.35, 1, 0.6, 0.601, 1.2, -0.1])).toEqual({
      kind: 'ticks',
      levels: [1, 0.6, 0.35, 0],
    })
    expect(legendOf([])).toEqual({ kind: 'ticks', levels: [1] })
  })

  it('more than a dozen levels is a continuous range', () => {
    const fade = Array.from({ length: LEGEND_TICKS_MAX + 1 }, (_, i) => 0.1 + i * 0.05)
    expect(legendOf(fade)).toEqual({ kind: 'continuous', min: 0.1, max: 0.7 })
  })

  it('path levels: none is level 1, loops one level, open paths every vertex', () => {
    expect([
      ...pathLevelValues([
        null,
        { kind: 'loops', level: 0.5 },
        { kind: 'path', u: [0, 1], level: [0.2, 0.8] },
      ]),
    ]).toEqual([1, 0.5, 0.2, 0.8])
  })
})

describe('lineLegend', () => {
  it("an engraved pattern's Seigaiha: its three levels", async () => {
    const s = await designSetup({ services: { region2d } })
    await s.run('design.engraving.add', { partId: s.partId, motif: { preset: 'seigaiha' } })
    const shapes = s.part().shapes ?? []
    expect(lineLegend(['engraving1_lines'], shapes, region2d)).toEqual({
      kind: 'ticks',
      levels: [1, 0.6, 0.35],
    })
  })

  it("a Line's shapes: a path's own levels, a primitive at level 1", () => {
    const shapes = [
      { id: 'shape1', name: 'Ring', items: [{ kind: 'circle', op: 'add' }] },
      { id: 'shape2', name: 'Fade', items: [{ kind: 'path', levels: [0.25, 0.75] }] },
      { id: 'shape3', name: 'Half', items: [{ kind: 'path', levels: 0.5 }, { kind: 'path' }] },
    ] as unknown as Parameters<typeof lineLegend>[1]
    expect(lineLegend(['shape1'], shapes, region2d)).toEqual({ kind: 'ticks', levels: [1] })
    expect(lineLegend(['shape1', 'shape2', 'shape3', 'gone'], shapes, region2d)).toEqual({
      kind: 'ticks',
      levels: [1, 0.75, 0.5, 0.25],
    })
  })
})
