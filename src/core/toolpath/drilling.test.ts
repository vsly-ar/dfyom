import { describe, expect, it } from 'vitest'
import { generateDrilling, tipLength } from './drilling'
import type { DrillingOperation, DrillMove } from './model'
import { drill, drillingInput, endMill } from './testing/fixtures'
import { Heightmap, render, steps } from './testing/oracles'
import { violations } from './testing/rules'

const stock = { length: 30, width: 30, thickness: 20 }
const hole = (bottom: DrillingOperation['bottom'], diameter = 6): DrillingOperation => ({
  kind: 'drilling',
  id: 'drill1',
  onZ: -0.5,
  center: [15, 15],
  diameter,
  bottom,
})
const drillMove = (tp: ReturnType<typeof generateDrilling>) =>
  tp
    .unwrap()
    .passes.flatMap((p) => p.moves)
    .find((m): m is DrillMove => m.kind === 'drill')!

describe('generateDrilling', () => {
  it('golden: through hole, simple cycle', async () => {
    const tp = generateDrilling(
      drillingInput(stock, hole({ kind: 'through' }), drill(6), {
        cycle: 'simple',
        breakthrough: 0.5,
      }),
    ).unwrap()
    await expect(render(tp)).toMatchFileSnapshot('__golden__/drilling-through.txt')
  })

  it('golden: flat-bottom hole by helical boring', async () => {
    const tp = generateDrilling(
      drillingInput(stock, hole({ kind: 'flat', depth: 4 }, 10), endMill(6), {
        cycle: 'helix',
        helixPitch: 1.5,
        breakthrough: 0.5,
        direction: 'climb',
      }),
    ).unwrap()
    await expect(render(tp)).toMatchFileSnapshot('__golden__/drilling-helix.txt')
  })

  it('puts the drill tip at depth + tip length (+ breakthrough for through holes)', () => {
    const tip = tipLength(6, 118)
    expect(tip).toBeCloseTo(3 / Math.tan((59 * Math.PI) / 180), 12)
    const point = drillMove(
      generateDrilling(
        drillingInput(stock, hole({ kind: 'drillPoint', depth: 12, pointAngle: 118 }), drill(6), {
          cycle: 'peck',
          peckDepth: 6,
          breakthrough: 0.5,
        }),
      ),
    )
    expect(point).toMatchObject({
      at: [15, 15],
      top: -0.5,
      cycle: 'peck',
      peck: 6,
      retract: 1.5,
      feed: 150,
    })
    expect(point.bottom).toBeCloseTo(-12.5 - tip, 12)
    const through = drillMove(
      generateDrilling(
        drillingInput(stock, hole({ kind: 'through' }), drill(6), {
          cycle: 'chipBreak',
          peckDepth: 3,
          chipBreakBack: 0.5,
          breakthrough: 0.5,
        }),
      ),
    )
    expect(through).toMatchObject({ cycle: 'chipBreak', peck: 3, back: 0.5 })
    expect(through.bottom).toBeCloseTo(-20.5 - tip, 12)
  })

  it('helical boring: pitch, plunge rate, the hole wall and a flat floor', () => {
    const op = hole({ kind: 'flat', depth: 7 }, 10)
    const tool = endMill(6)
    const input = drillingInput(stock, op, tool, {
      cycle: 'helix',
      helixPitch: 2,
      breakthrough: 0.5,
      direction: 'conventional',
    })
    const tp = generateDrilling(input).unwrap()
    expect(
      violations(tp, {
        feedRate: 600,
        plungeRate: 150,
        // helix slope: pitch over the circumference of the tool center's circle
        rampAngle: (Math.atan(2 / (2 * Math.PI * 2)) * 180) / Math.PI,
        retractZ: 1.5,
        clearanceZ: 10,
        contains: (p) =>
          p[2] > -0.5 + 1e-9 ||
          (p[2] >= -7.5 - 1e-9 && Math.hypot(p[0] - 15, p[1] - 15) <= 2 + 1e-9),
      }),
    ).toEqual([])
    expect(steps(tp).every((s) => s.move.kind !== 'arc' || s.move.cw)).toBe(true)
    const map = new Heightmap(30, 30, 0.2)
    map.sweep(tool, tp)
    for (let i = 0; i < map.nx; i++)
      for (let j = 0; j < map.ny; j++) {
        const [x, y] = map.center(i, j)
        const r = Math.hypot(x - 15, y - 15)
        const h = map.z[j * map.nx + i]!
        if (r < 4.9) expect(h).toBeCloseTo(-7.5, 9)
        if (r > 5 + 1e-9) expect(h).toBe(0)
      }
  })

  it('rejects mismatched tools and bottoms', () => {
    const code = (r: ReturnType<typeof generateDrilling>) => r.unwrapErr().issues[0]!.rule
    const simple = { cycle: 'simple', breakthrough: 0.5 } as const
    expect(
      code(generateDrilling(drillingInput(stock, hole({ kind: 'through' }), drill(5), simple))),
    ).toBe('drillSize')
    expect(
      code(
        generateDrilling(drillingInput(stock, hole({ kind: 'flat', depth: 3 }), drill(6), simple)),
      ),
    ).toBe('flatNeedsEndMill')
    expect(
      code(generateDrilling(drillingInput(stock, hole({ kind: 'through' }), endMill(6), simple))),
    ).toBe('cycleNeedsDrill')
    const helix = { cycle: 'helix', helixPitch: 1, breakthrough: 0.5, direction: 'climb' } as const
    expect(
      code(generateDrilling(drillingInput(stock, hole({ kind: 'through' }), endMill(2), helix))),
    ).toBe('boringToolSize')
    expect(
      code(generateDrilling(drillingInput(stock, hole({ kind: 'through' }), drill(6), helix))),
    ).toBe('helixNeedsEndMill')
  })
})
