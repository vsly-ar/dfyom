// X0 (v0.4-llm-first): the exit part's fixture recomputed from the STL with the app's own
// reference tools (design.reference.find levels, section, holes) and from the black-box test's
// saved programs, so `enclosure-exit.testing.ts` cannot drift.
// Docs: docs/plans/v0.4-llm-first.md#exit-criteria, docs/modes/reference-tools.md
import { describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { gcodeClearance, type OracleBox } from '../plan/workholding/gcode-oracle.testing'
import {
  ENCLOSURE_BOTTOM_NC,
  ENCLOSURE_STOCK,
  ENCLOSURE_TOP_NC,
  parseGcode,
  readGcode,
} from '../toolpath/testing/gcode'
import {
  EXIT_CLAMP_REACH,
  EXIT_CLAMPS,
  EXIT_FINDINGS,
  EXIT_HOLES,
  EXIT_LEVELS,
  EXIT_MARGIN,
  EXIT_PLACED,
  EXIT_SECTIONS,
  EXIT_STOCK,
  type ExpectedLoop,
} from './enclosure-exit.testing'
import { compareSetup, SOURCES } from './reference-compare.testing'
import { enclosureStl } from './stl.testing'

const ui = { kind: 'ui', id: 'w' } as const
const STL = '/models/enclosure-wood-base.stl'

/** Lengths to 0.002 mm, areas to 0.05 mm² (results are rounded to 0.001; platform slack). */
function expectNear(actual: unknown, expected: unknown, path = '$'): void {
  if (typeof expected === 'number') {
    expect(typeof actual, path).toBe('number')
    const tol = /area|Area/.test(path) ? 0.05 : 0.002
    expect(
      Math.abs((actual as number) - expected),
      `${path}: ${actual} vs ${expected}`,
    ).toBeLessThanOrEqual(tol)
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true)
    expect((actual as unknown[]).length, `${path}.length`).toBe(expected.length)
    expected.forEach((e, i) => expectNear((actual as unknown[])[i], e, `${path}[${i}]`))
  } else if (typeof expected === 'object' && expected !== null) {
    const a = actual as Record<string, unknown>
    expect(Object.keys(a).sort(), path).toEqual(Object.keys(expected).sort())
    for (const [k, e] of Object.entries(expected)) expectNear(a[k], e, `${path}.${k}`)
  } else expect(actual, path).toBe(expected)
}

interface Loop {
  role: 'outer' | 'hole'
  area: number
  bounds: [[number, number], [number, number]]
  circle?: { center: [number, number]; diameter: number }
  corners: { minInsideRadius?: number; sharp: [number, number][] }
}

/** The fields the fixture keeps, in its order: role, then bounds' min v, then min u. */
const loopsOf = (loops: Loop[]): ExpectedLoop[] =>
  loops
    .map((l) => ({
      role: l.role,
      area: l.area,
      bounds: l.bounds,
      ...(l.circle === undefined ? {} : { circle: l.circle }),
      ...(l.corners.minInsideRadius === undefined
        ? {}
        : { minInsideRadius: l.corners.minInsideRadius }),
      sharp: l.corners.sharp,
    }))
    .sort(
      (a, b) =>
        a.role.localeCompare(b.role) ||
        a.bounds[0][1] - b.bounds[0][1] ||
        a.bounds[0][0] - b.bounds[0][0],
    )

/** The parts of `design.reference.find` results the test reads. */
interface Found {
  more?: number
  levels?: unknown
  loops?: Loop[]
  holeCount?: number
  groups?: Record<string, unknown>[]
}

async function enclosure() {
  SOURCES[STL] ??= enclosureStl()
  const s = await compareSetup(EXIT_STOCK)
  const imported = (await s.run('design.reference.import', {
    partId: s.partId,
    path: STL,
    sourceUnit: 'mm',
  })) as { placed: unknown }
  const find = async (args: object) =>
    expectOk(await s.d.queryAsync('design.reference.find', { partId: s.partId, ...args }, ui))
      .value as Found
  return { imported, find }
}

describe('X0: the exit part read from its STL (enclosure-exit.testing.ts)', () => {
  it('placement, levels, sections and holes equal the fixture', { timeout: 60_000 }, async () => {
    const { imported, find } = await enclosure()
    expectNear(imported.placed, EXIT_PLACED, 'placed')

    const levels = await find({ kind: 'levels' })
    expect(levels.more).toBeUndefined()
    expectNear(levels.levels, EXIT_LEVELS, 'levels')

    for (const sec of EXIT_SECTIONS) {
      const r = await find({ kind: 'section', face: sec.face, depth: String(sec.depth) })
      expectNear(loopsOf(r.loops!), sec.loops, `section ${sec.face} ${sec.depth}`)
    }

    const top = await find({ kind: 'holes' })
    expect(top.holeCount).toBe(EXIT_HOLES.top.holeCount)
    const bottom = await find({ kind: 'holes', face: 'stock.bottom' })
    expect(bottom.holeCount).toBe(EXIT_HOLES.bottom.holeCount)
    const [group, ...others] = bottom.groups!
    expect(others).toEqual([])
    const { suggest, message: _, ...rest } = group!
    expectNear(rest, EXIT_HOLES.bottom.group, 'holes')
    expect((suggest as { note?: string }).note).toBe(EXIT_HOLES.bottom.note)
  })

  it('the saved programs: the drill breaks through the web (an expected finding, not a pass)', () => {
    const f = EXIT_FINDINGS.drillBreakthrough
    // the reference: the hole ends and the cavity floor, from the stock bottom (levels above)
    const fromBottom = (d: number) => EXIT_LEVELS.find((l) => l.depthFromOpposite === d)
    expect(fromBottom(f.holeEnd)?.depth).toBe(ENCLOSURE_STOCK.thickness - f.holeEnd)
    expect(EXIT_HOLES.bottom.group.size.depth).toBe(f.holeEnd)
    expect(fromBottom(f.cavityFloor)).toBeDefined()
    expect(
      EXIT_LEVELS.some(
        (l) => l.facing === 'face' && l.depth === ENCLOSURE_STOCK.thickness - f.cavityFloor,
      ),
    ).toBe(true)
    expect(f.cavityFloor - f.holeEnd).toBeCloseTo(f.web, 3)
    // the program: the drill's deepest Z (Z0 on the stock bottom), its 118° point length
    const drill = parseGcode(readGcode(ENCLOSURE_BOTTOM_NC)).find(
      (p) => p.tool.diameter === f.drillDiameter,
    )!
    const tip = -Math.min(
      ...drill.toolpath.passes.flatMap((p) =>
        p.moves.map((m) => (m.kind === 'drill' ? m.bottom : m.to[2])),
      ),
    )
    expect(tip).toBeCloseTo(f.drillTip, 3)
    const point = f.drillDiameter / 2 / Math.tan((59 * Math.PI) / 180)
    expect(point).toBeCloseTo(f.pointLength, 3)
    // the shoulder stops at the hole's flat end; the point passes the cavity floor
    expect(Math.abs(tip - point - f.holeEnd)).toBeLessThan(0.01)
    expect(tip - f.cavityFloor).toBeCloseTo(f.pastFloor, 3)
    expect(f.pastFloor).toBeGreaterThan(f.web)
  })

  it('the saved programs against the clamps: the top clears them, the bottom misses 2 mm', () => {
    const { length, width } = ENCLOSURE_STOCK
    const boxes: OracleBox[] = EXIT_CLAMPS.map((c) => {
      const at = Number(c.at)
      const half = Number(c.width) / 2
      const grip = Number(c.grip)
      return {
        x: [at - half, at + half],
        y: c.edge === 'vMin' ? [-EXIT_CLAMP_REACH, grip] : [width - grip, width + EXIT_CLAMP_REACH],
        top: Number(c.top),
      }
    })
    expect(boxes.every((b) => b.x[0] >= 0 && b.x[1] <= length)).toBe(true)
    const gap = (url: URL, margin = EXIT_MARGIN) =>
      Math.round(gcodeClearance(readGcode(url), boxes, 3, margin) * 1000) / 1000
    const f = EXIT_FINDINGS.savedClearance
    expect(gap(ENCLOSURE_TOP_NC)).toBe(f.top)
    expect(f.top).toBeGreaterThanOrEqual(EXIT_MARGIN)
    expect(gap(ENCLOSURE_BOTTOM_NC)).toBe(f.bottom)
    expect(gap(ENCLOSURE_BOTTOM_NC, EXIT_MARGIN - 1.001)).toBe(f.bottomBelowZ26)
    expect(f.bottomBelowZ26).toBeLessThan(EXIT_MARGIN)
  })
})
