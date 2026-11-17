import { describe, expect, it } from 'vitest'
import { generateFacing, rowPositions } from './facing'
import { bullNose, endMill, facingInput } from './testing/fixtures'
import { Heightmap, render, steps } from './testing/oracles'
import { cuttingLevels, stepsWithin, violations } from './testing/rules'

const stock = { length: 30, width: 20, thickness: 10 }

describe('generateFacing', () => {
  it('golden: zigzag along X, climb, one level', async () => {
    const tp = generateFacing(facingInput(stock, endMill(10))).unwrap()
    await expect(render(tp)).toMatchFileSnapshot('__golden__/facing-zigzag.txt')
  })

  it('golden: one-way along Y, conventional, two levels', async () => {
    const input = facingInput(stock, endMill(10), {
      strategy: { pattern: 'oneWay', axis: 'y', overshoot: 1, direction: 'conventional' },
      operation: { kind: 'facing', id: 'facing1', depth: 1 },
    })
    await expect(render(generateFacing(input).unwrap())).toMatchFileSnapshot(
      '__golden__/facing-oneway.txt',
    )
  })

  for (const pattern of ['zigzag', 'oneWay'] as const)
    for (const axis of ['x', 'y'] as const)
      it(`${pattern} along ${axis}: levels, stepover, coverage and safety`, () => {
        const tool = endMill(8)
        const input = facingInput(stock, tool, {
          strategy: { pattern, axis, overshoot: 1, direction: 'climb' },
          operation: { kind: 'facing', id: 'facing1', depth: 1.3 },
        })
        const tp = generateFacing(input).unwrap()
        expect(
          violations(tp, {
            feedRate: input.cutting.feedRate,
            plungeRate: input.cutting.plungeRate,
            retractZ: 2,
            clearanceZ: 10,
            contains: (p) => p[2] >= -1.3 - 1e-9,
          }),
        ).toEqual([])
        const zs = cuttingLevels(tp)
        expect(zs.at(-1)).toBeCloseTo(-1.3, 12)
        expect(stepsWithin(zs, 0, input.cutting.stepdown)).toBe(true)
        // rows step by at most the stepover
        const across = new Set<number>()
        for (const s of steps(tp))
          if (s.move.kind === 'line' && s.move.to[2] === -1.3)
            across.add(Math.round((axis === 'x' ? s.move.to[1] : s.move.to[0]) * 1e9) / 1e9)
        const rows = [...across].sort((a, b) => a - b)
        for (let i = 1; i < rows.length; i++)
          expect(rows[i]! - rows[i - 1]!).toBeLessThanOrEqual(input.cutting.stepover + 1e-9)
        // the whole stock top comes down to the facing depth
        const map = new Heightmap(stock.length, stock.width, 0.25)
        map.sweep(tool, tp)
        expect(Math.max(...map.z)).toBeCloseTo(-1.3, 9)
        // entered from the side: every plunge is outside the stock
        for (const s of steps(tp))
          if (s.move.kind === 'line' && s.move.to[2] < s.from[2]) {
            const [x, y] = s.move.to
            const out = x < -tool.diameter / 2 || x > 30 + tool.diameter / 2 || y < -4 || y > 24
            expect(out, `plunge at ${x}, ${y}`).toBe(true)
          }
      })

  it('climb rows run −X along X and +Y along Y (M3, material on the right)', () => {
    const first = (axis: 'x' | 'y', direction: 'climb' | 'conventional') => {
      const tp = generateFacing(
        facingInput(stock, endMill(10), {
          strategy: { pattern: 'oneWay', axis, overshoot: 1, direction },
        }),
      ).unwrap()
      const cut = steps(tp).find((s) => s.move.kind === 'line' && s.move.to[2] === s.from[2])!
      return axis === 'x'
        ? Math.sign(cut.move.to[0] - cut.from[0])
        : Math.sign(cut.move.to[1] - cut.from[1])
    }
    expect(first('x', 'climb')).toBe(-1)
    expect(first('x', 'conventional')).toBe(1)
    expect(first('y', 'climb')).toBe(1)
    expect(first('y', 'conventional')).toBe(-1)
  })

  it('a bull nose steps by at most its flat diameter', () => {
    const tool = bullNose(10, 3)
    const tp = generateFacing(facingInput(stock, tool)).unwrap()
    const map = new Heightmap(stock.length, stock.width, 0.25)
    map.sweep(tool, tp)
    expect(Math.max(...map.z)).toBeCloseTo(-0.5, 9)
  })

  it('rejects invalid values and a tool without a flat', () => {
    const bad = generateFacing(
      facingInput(stock, endMill(10), { operation: { kind: 'facing', id: 'f', depth: 0 } }),
    )
    expect(bad.unwrapErr().code).toBe('model.invariant')
    expect(bad.unwrapErr().issues[0]!.path).toEqual(['operation', 'depth'])
    const ball = generateFacing(facingInput(stock, { ...endMill(10), cornerRadius: 5 }))
    expect(ball.unwrapErr().code).toBe('plan.check')
  })
})

describe('rowPositions', () => {
  it('spreads rows evenly with at most the step between them', () => {
    expect(rowPositions(0, 10, 4)).toEqual([0, 10 / 3, 20 / 3, 10])
    expect(rowPositions(0, 8, 4)).toEqual([0, 4, 8])
    expect(rowPositions(5, 3, 4)).toEqual([4])
  })
})
