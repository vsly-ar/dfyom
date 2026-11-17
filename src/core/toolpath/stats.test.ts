import { describe, expect, it } from 'vitest'
import type { DrillMove, Pass } from './model'
import { expandDrill, toolpathStats } from './stats'

const drill = (over: Partial<DrillMove>): DrillMove => ({
  kind: 'drill',
  at: [5, 5],
  top: 0,
  bottom: -10,
  cycle: 'simple',
  retract: 2,
  feed: 100,
  ...over,
})

const zs = (d: DrillMove) => expandDrill(d).map((m) => `${m.kind[0]}${m.to[2]}`)

describe('expandDrill (grbl.md drill expansion)', () => {
  it('simple: feed to the bottom, rapid out', () => {
    expect(zs(drill({}))).toEqual(['l-10', 'r2'])
  })

  it('peck: full retract, rapid back to 0.5 above the last depth', () => {
    expect(zs(drill({ cycle: 'peck', peck: 4 }))).toEqual([
      'l-4',
      'r2',
      'r-3.5',
      'l-8',
      'r2',
      'r-7.5',
      'l-10',
      'r2',
    ])
  })

  it('chipBreak: backs off by `back` only', () => {
    expect(zs(drill({ cycle: 'chipBreak', peck: 5, back: 0.5 }))).toEqual([
      'l-5',
      'r-4.5',
      'l-10',
      'r2',
    ])
  })
})

describe('toolpathStats', () => {
  it('sums feed and rapid lengths and times them (first move not counted)', () => {
    const passes: Pass[] = [
      {
        kind: 'rough',
        moves: [
          { kind: 'rapid', to: [0, 0, 10] },
          { kind: 'rapid', to: [0, 0, 2] },
          { kind: 'line', to: [0, 0, -1], feed: 60 },
          { kind: 'arc', to: [20, 0, -1], center: [10, 0], cw: true, feed: 600 },
          { kind: 'rapid', to: [20, 0, 10] },
        ],
      },
    ]
    const s = toolpathStats(passes, [6000, 6000, 600])
    expect(s.cutLength).toBeCloseTo(3 + 10 * Math.PI, 9)
    expect(s.rapidLength).toBeCloseTo(8 + 11, 9)
    // 3 mm at 60 + 31.4 mm at 600 + 19 mm of Z rapids at 600 mm/min
    expect(s.estimatedSeconds).toBeCloseTo(3 + Math.PI + 1.9, 9)
    expect(toolpathStats(passes).estimatedSeconds).toBeCloseTo(3 + Math.PI, 9)
  })

  it('counts a helix by its 3D length and a drill cycle as expanded', () => {
    const s = toolpathStats([
      {
        kind: 'rough',
        moves: [
          { kind: 'rapid', to: [5, 0, 0] },
          { kind: 'arc', to: [-5, 0, -2], center: [0, 0], cw: false, feed: 100 },
          { kind: 'rapid', to: [5, 5, 2] },
          drill({}),
        ],
      },
    ])
    expect(s.cutLength).toBeCloseTo(Math.hypot(5 * Math.PI, 2) + 12, 9)
  })
})
