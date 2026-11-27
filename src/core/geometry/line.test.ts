// Line (engraved-patterns.md E1): the groove's removal solid against the swept-cone integral
// (the slice's exit: a curved open line fluting 0.2 → 1.5 mm with a 60° V-bit, within 1 %), a
// closed V-groove, the ball's and flat's grooves, the width read-out, the DFM findings and the
// solid's cost on ≈ 1 400 mm of line. Doc: docs/modes/engraved-patterns.md#implementation-e1
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { arc, line } from './2d/model'
import { parameterChecks } from './dfm'
import { evaluatePart } from './evaluate'
import { grooveWidth, lineChains, vBitEdgeHeight } from './line'
import { loadManifold } from './manifold'
import type { LineCutter, LineGeometry, OperationGeometry, Shape, StockGeometry } from './model'
import type { SolidKernel } from './solid-port'

let kernel: SolidKernel
beforeAll(async () => {
  kernel = expectOk(await loadManifold())
})

const STOCK: StockGeometry = { length: 100, width: 60, thickness: 10 }
const V60: LineCutter = { kind: 'vBit', diameter: 6, angle: 60, tipDiameter: 0 }
const TAN30 = Math.tan(Math.PI / 6)

/** A straight 40 mm line then a half circle (r 10): 71.4 mm, placed at (50, 30). */
const curve: Shape = {
  center: [50, 30],
  contour: {
    kind: 'path',
    path: { elements: [line([-30, 0], [10, 0]), arc([10, 0], [30, 0], [20, 0], true)] },
  },
}
const CURVE_LENGTH = 40 + 10 * Math.PI

const lineOf = (
  paths: Shape[],
  start: number,
  end = start,
  cutter: LineCutter = V60,
): LineGeometry => ({ kind: 'line', id: 'line1', onZ: 0, paths, depth: { start, end }, cutter })

function removed(ops: OperationGeometry[]): { volume: number; ms: number } {
  const stockVolume = STOCK.length * STOCK.width * STOCK.thickness
  const t0 = performance.now()
  const e = expectOk(kernel.withSolids((s) => evaluatePart({ stock: STOCK, operations: ops }, s)))
  const ms = performance.now() - t0
  expect(kernel.liveObjects()).toBe(0)
  return { volume: stockVolume - e.volume, ms }
}

/** A pointed V-groove's volume: ∫ d² tan(α/2) ds and a half cone at each end. */
function vGrooveVolume(length: number, a: number, b: number): number {
  const body = (TAN30 * length * (a * a + a * b + b * b)) / 3
  const ends = (Math.PI / 6) * TAN30 * TAN30 * (a ** 3 + b ** 3)
  return body + ends
}

describe('removal solid', () => {
  it('a curved open line fluting 0.2 → 1.5 mm with a 60° V-bit: the swept-cone volume ± 1 %', () => {
    const v = removed([lineOf([curve], 0.2, 1.5)]).volume
    const expected = vGrooveVolume(CURVE_LENGTH, 0.2, 1.5)
    expect(Math.abs(v - expected) / expected).toBeLessThan(0.01)
  })

  it('a constant V-groove round a closed square: four sides and the corners', () => {
    const s = 30
    const square: Shape = {
      center: [50, 30],
      contour: {
        kind: 'region',
        region: {
          pieces: [
            {
              outer: {
                elements: [
                  line([-15, -15], [15, -15]),
                  line([15, -15], [15, 15]),
                  line([15, 15], [-15, 15]),
                  line([-15, 15], [-15, -15]),
                ],
              },
              holes: [],
            },
          ],
        },
      },
    }
    const d = 1
    const v = removed([lineOf([square], d)]).volume
    // four prisms on the centreline (outer and inner corners cancel to first order) plus the
    // outer corner wedges: 4 × a quarter cone of the groove
    const expected = 4 * s * d * d * TAN30 + 4 * (Math.PI / 12) * TAN30 * TAN30 * d ** 3
    expect(Math.abs(v - expected) / expected).toBeLessThan(0.01)
  })

  it('a ball end mill leaves a half-round groove, a flat one a slot', () => {
    const straight: Shape = {
      center: [50, 30],
      contour: { kind: 'path', path: { elements: [line([-20, 0], [20, 0])] } },
    }
    const ball = removed([lineOf([straight], 1, 1, { kind: 'ball', diameter: 2 })]).volume
    // a half disc along 40 mm and a half ball at the ends
    const ballExpected = 40 * (Math.PI / 2) + (4 / 3) * Math.PI * 0.5
    expect(Math.abs(ball - ballExpected) / ballExpected).toBeLessThan(0.01)
    const flat = removed([lineOf([straight], 1, 1, { kind: 'flat', diameter: 2 })]).volume
    const flatExpected = 40 * 2 + Math.PI
    expect(Math.abs(flat - flatExpected) / flatExpected).toBeLessThan(0.01)
  })

  it('costs within the evaluation budget on ≈ 1 400 mm of line (measured, E1)', () => {
    // 20 copies of the curve (71.4 mm each) = 1 428 mm
    const paths = Array.from({ length: 20 }, (_, i): Shape => ({
      ...curve,
      center: [50, 4 + i * 2.6],
    }))
    const r = removed([lineOf(paths, 0.2, 1)])
    // 0.53 s measured (the doc records it); generous for CI and a shared machine
    expect(r.ms).toBeLessThan(5_000)
  })
})

describe('width and depth read-outs', () => {
  it('gives the groove width at a depth (research § Tools)', () => {
    expect(grooveWidth(V60, 1)).toBeCloseTo(2 * TAN30, 9)
    expect(grooveWidth({ ...V60, tipDiameter: 0.2 }, 1)).toBeCloseTo(0.2 + 2 * TAN30, 9)
    expect(grooveWidth(V60, 10)).toBe(6)
    expect(grooveWidth({ kind: 'ball', diameter: 4 }, 1)).toBeCloseTo(2 * Math.sqrt(3), 9)
    expect(grooveWidth({ kind: 'ball', diameter: 4 }, 3)).toBe(4)
    expect(grooveWidth({ kind: 'flat', diameter: 3 }, 0.1)).toBe(3)
    expect(vBitEdgeHeight(V60)).toBeCloseTo(3 / TAN30, 9)
    expect(vBitEdgeHeight({ kind: 'flat', diameter: 3 })).toBeUndefined()
  })

  it('splits a line into pieces with their own depth when a coincident element goes', () => {
    const c = lineChains(lineOf([curve], 0.2, 1.5))
    expect(c.lines).toHaveLength(1)
    expect(c.lines[0]!.length).toBeCloseTo(CURVE_LENGTH, 9)
    expect(c.lines[0]!.profile.d).toEqual([0.2, 1.5])
  })
})

describe('DFM', () => {
  const checks = (op: LineGeometry, fluteLength?: number) =>
    parameterChecks(
      { stock: STOCK, operations: [op] },
      {
        tools: [],
        unitSystem: 'metric',
        operationTools:
          fluteLength === undefined
            ? {}
            : {
                line1: {
                  tool: { type: 'ballEndMill', diameter: 2, fluteLength },
                  label: 'Ø 2 mm ball end mill',
                  generalized: false,
                  locked: true,
                },
              },
      },
    ).map((w) => [w.code, w.severity])

  it('dfm.lineTooDeep: deeper than the V-bit edge (DC − dt) / 2 / tan(α/2) or the flutes', () => {
    const small: LineCutter = { kind: 'vBit', diameter: 2, angle: 60, tipDiameter: 0 }
    // edge height 1 / tan 30° = 1.73 mm
    expect(checks(lineOf([curve], 0.5, 2, small))).toContainEqual(['dfm.lineTooDeep', 'warning'])
    expect(checks(lineOf([curve], 0.5, 1.5, small))).toEqual([])
    const ball: LineCutter = { kind: 'ball', diameter: 2 }
    expect(checks(lineOf([curve], 3, 3, ball), 2.5)).toContainEqual(['dfm.lineTooDeep', 'warning'])
  })

  it('DF123: a 15° V-bit cuts to its flute length when that is shorter than its cone', () => {
    const v15: LineCutter = { kind: 'vBit', diameter: 3.175, angle: 15, tipDiameter: 0 }
    // the cone is 1.5875 / tan 7.5° = 12.06 mm tall; the flutes 6 mm
    expect(vBitEdgeHeight(v15)).toBeCloseTo(1.5875 / Math.tan((7.5 * Math.PI) / 180), 9)
    const withFlutes = (op: LineGeometry, fluteLength: number) =>
      parameterChecks(
        { stock: STOCK, operations: [op] },
        {
          tools: [],
          unitSystem: 'metric',
          operationTools: {
            line1: {
              tool: { type: 'chamferMill', diameter: 3.175, angle: 15, fluteLength },
              label: '15° V-bit',
              generalized: false,
              locked: true,
            },
          },
        },
      ).find((w) => w.code === 'dfm.lineTooDeep')
    expect(withFlutes(lineOf([curve], 0.5, 7, v15), 6)?.params).toMatchObject({ depth: 7, cuts: 6 })
    expect(withFlutes(lineOf([curve], 0.5, 5, v15), 6)).toBeUndefined()
    // no flute length known (a generalized tool): the cone's height
    expect(checks(lineOf([curve], 0.5, 7, v15))).toEqual([])
    expect(checks(lineOf([curve], 0.5, 13, v15))).toContainEqual(['dfm.lineTooDeep', 'warning'])
    // the groove at 1 mm: 2 × tan 7.5° = 0.263 mm
    expect(grooveWidth(v15, 1)).toBeCloseTo(2 * Math.tan((7.5 * Math.PI) / 180), 9)
  })

  it('dfm.lineShallow (info) under 0.05 mm', () => {
    expect(checks(lineOf([curve], 0.03, 1))).toEqual([['dfm.lineShallow', 'info']])
  })
})
