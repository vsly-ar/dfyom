import { describe, expect, it } from 'vitest'
import { generateDrilling, tipLength } from './drilling'
import type { DrillingOperation, DrillMove } from './model'
import { drill, drillingInput, endMill } from './testing/fixtures'
import { Heightmap, render, steps } from './testing/oracles'
import { violations } from './testing/rules'
import { arcSweep } from './stats'

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
        rampAngle: 3,
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

  /** Helical boring of a flat hole of `diameter`, 7 deep, from Z −0.5: all properties. */
  function checkHelix(diameter: number, toolDiameter: number, helixPitch: number, rampAngle = 3) {
    const op = hole({ kind: 'flat', depth: 7 }, diameter)
    const tool = endMill(toolDiameter)
    const input = drillingInput(stock, op, tool, {
      cycle: 'helix',
      helixPitch,
      rampAngle,
      breakthrough: 0.5,
      direction: 'conventional',
    })
    const tp = generateDrilling(input).unwrap()
    const rho = (diameter - toolDiameter) / 2
    expect(
      violations(tp, {
        feedRate: 600,
        plungeRate: 150,
        rampAngle,
        verticalAtMostPlunge: true,
        retractZ: 1.5,
        clearanceZ: 10,
        targetZ: -7.5,
        contains: (p) =>
          p[2] > -0.5 + 1e-9 ||
          (p[2] >= -7.5 - 1e-9 && Math.hypot(p[0] - 15, p[1] - 15) <= rho + 1e-9),
      }),
    ).toEqual([])
    // no turn descends more than the helix pitch
    let angle = 0
    let top: number | undefined
    for (const s of steps(tp)) {
      if (s.move.kind === 'arc' && s.move.to[2] < s.from[2]) {
        top ??= s.from[2]
        angle += Math.abs(arcSweep(s.from, s.move))
        if (angle >= 2 * Math.PI - 1e-9) {
          expect(top! - s.move.to[2]).toBeLessThanOrEqual(helixPitch + 1e-9)
          angle = 0
          top = s.move.to[2]
        }
      }
    }
    const map = new Heightmap(30, 30, 0.2)
    map.sweep(tool, tp)
    const wrong: string[] = []
    for (let i = 0; i < map.nx; i++)
      for (let j = 0; j < map.ny; j++) {
        const [x, y] = map.center(i, j)
        const r = Math.hypot(x - 15, y - 15)
        const h = map.z[j * map.nx + i]!
        if (r < diameter / 2 - 0.1 && Math.abs(h + 7.5) > 1e-9) wrong.push(`left at ${x},${y}`)
        if (r > diameter / 2 + 1e-9 && h !== 0) wrong.push(`outside at ${x},${y}`)
      }
    expect(wrong.slice(0, 3)).toEqual([])
    return tp
  }

  it('helical boring: pitch, ramp angle, plunge rate, the wall and a flat floor', () => {
    expect(steps(checkHelix(10, 6, 2)).every((s) => s.move.kind !== 'arc' || s.move.cw)).toBe(true)
    // a steep pitch on a small circle is capped by the ramp angle
    checkHelix(10, 6, 2, 10)
  })

  it('a hole barely larger than the tool: capped descent, then plunges for tiny circles', () => {
    checkHelix(6.1, 6, 1.5) // ρ = 0.05 < 0.1 mm: plunges instead of ~700 turns
    const capped = checkHelix(6.4, 6, 1.5) // ρ = 0.2: a helix capped by the ramp angle
    expect(steps(capped).some((s) => s.move.kind === 'arc' && s.move.to[2] < s.from[2])).toBe(true)
    const tiny = checkHelix(6.02, 6, 1.5)
    expect(steps(tiny).some((s) => s.move.kind === 'arc' && s.move.to[2] < s.from[2])).toBe(false)
  })

  it('golden: peck and chip-break cycles', async () => {
    for (const strategy of [
      { cycle: 'peck', peckDepth: 4, breakthrough: 0.5 },
      { cycle: 'chipBreak', peckDepth: 4, chipBreakBack: 0.5, breakthrough: 0.5 },
    ] as const) {
      const tp = generateDrilling(
        drillingInput(
          stock,
          hole({ kind: 'drillPoint', depth: 10, pointAngle: 118 }),
          drill(6),
          strategy,
        ),
      ).unwrap()
      expect(
        violations(tp, {
          feedRate: 600,
          plungeRate: 150,
          retractZ: 1.5,
          clearanceZ: 10,
          targetZ: -10.5 - tipLength(6, 118),
          contains: () => true,
        }),
      ).toEqual([])
      await expect(render(tp)).toMatchFileSnapshot(`__golden__/drilling-${strategy.cycle}.txt`)
    }
  })

  it('rejects a drill whose point angle differs from the hole bottom by more than 0.5°', () => {
    const op = hole({ kind: 'drillPoint', depth: 10, pointAngle: 118 })
    const simple = { cycle: 'simple', breakthrough: 0.5 } as const
    const r = generateDrilling(drillingInput(stock, op, drill(6, 135), simple))
    expect(r.unwrapErr().code).toBe('plan.check')
    expect(r.unwrapErr().issues[0]!.rule).toBe('pointAngle')
    expect(generateDrilling(drillingInput(stock, op, drill(6, 118.4), simple)).isOk()).toBe(true)
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
    const helix = {
      cycle: 'helix',
      helixPitch: 1,
      rampAngle: 3,
      breakthrough: 0.5,
      direction: 'climb',
    } as const
    expect(
      code(generateDrilling(drillingInput(stock, hole({ kind: 'through' }), endMill(2), helix))),
    ).toBe('boringToolSize')
    expect(
      code(generateDrilling(drillingInput(stock, hole({ kind: 'through' }), drill(6), helix))),
    ).toBe('helixNeedsEndMill')
  })
})
