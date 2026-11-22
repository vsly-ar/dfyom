// Parameter DFM checks and tool fit of general shapes (v0.3 K4): inside corners of the cut, width,
// `dfm.restMaterial`, `dfm.shapeOutsideFace`, slot margins from the loop, tabs, the fit table, and
// the enclosure fixture (X0) with typical end mills.
// Doc: docs/modes/design-v0.3.md#dfm-checks-for-shapes, docs/architecture/shapes.md#parameter-checks-for-shapes
import { describe, expect, it } from 'vitest'
import { ENCLOSURE_SECTIONS_SVG } from '../design/enclosure-sections.testing'
import { importSvg } from '../import/svg/import'
import {
  parameterChecks,
  type DfmTool,
  type OperationTool,
  type ParameterCheckOptions,
} from './dfm'
import { line, type Loop, type Region } from './2d/model'
import { circle, dumbbell, rect } from './2d/testing/fixtures'
import { nodeRegion2d } from './2d/testing/node-wasm'
import type { DfmWarning, OperationGeometry, StockGeometry, Vec2 } from './model'
import { CORNER_MIN_TURN, insideCorners, shapeMeasure } from './shape-measure'
import { toolFit } from './tool-fit'

type Op<K extends OperationGeometry['kind']> = Extract<OperationGeometry, { kind: K }>

const port = nodeRegion2d()
const STOCK: StockGeometry = { length: 100, width: 60, thickness: 20 }
const flat = (diameter: number): DfmTool => ({ type: 'flatEndMill', diameter })
const LIBRARY: readonly DfmTool[] = [flat(6), flat(3)]

const poly = (pts: readonly Vec2[]): Loop => ({
  elements: pts.map((p, i) => line(p, pts[(i + 1) % pts.length]!)),
})
const region = (...loops: Loop[]): Region => port.normalise(loops).unwrap()
const shape = (r: Region, center: Vec2 = [50, 30]) => ({
  center,
  contour: { kind: 'region' as const, region: r },
})

const pocket = (r: Region, over: Partial<Op<'pocket'>> = {}): Op<'pocket'> => ({
  kind: 'pocket',
  id: 'pocket1',
  onZ: 0,
  shape: shape(r),
  depth: 5,
  floorRadius: 0,
  ...over,
})
const profile = (r: Region, over: Partial<Op<'profile'>> = {}): Op<'profile'> => ({
  kind: 'profile',
  id: 'profile1',
  shape: shape(r),
  side: 'outside',
  slotWidth: 6,
  tabs: { count: 4, width: 8, thickness: 3 },
  ...over,
})

/** The operation's own tool for the rules (a generalized flat end mill). */
const own = (op: OperationGeometry, diameter: number): Record<string, OperationTool> => ({
  [op.id]: {
    tool: flat(diameter),
    generalized: false,
    locked: false,
    label: `${diameter} mm flat end mill`,
  },
})
const run = (
  op: OperationGeometry,
  over: Partial<ParameterCheckOptions> = {},
  stock: StockGeometry = STOCK,
): DfmWarning[] =>
  parameterChecks(
    { stock, operations: [op] },
    { tools: LIBRARY, unitSystem: 'metric', region2d: port, ...over },
  )
const codes = (ws: readonly DfmWarning[]): string[] => ws.map((w) => w.code)

/** A 40 × 20 rectangle centred on the origin, corner radius `r`. */
const box = (r = 0) => region(rect(-20, -10, 40, 20, r))
/** An L: 40 × 30 with a 20 × 15 notch at the back right (one concave corner at (0, 0)). */
const ellLoop = () =>
  poly([
    [-20, -15],
    [20, -15],
    [20, 0],
    [0, 0],
    [0, 15],
    [-20, 15],
  ])
const ell = () => region(ellLoop())

describe('inside corners of the cut', () => {
  it('reports every sharp corner of a pocket with its marker in the face frame', () => {
    const ws = run(pocket(box()))
    expect(codes(ws)).toEqual(Array(4).fill('dfm.cornerSharp'))
    expect(ws.map((w) => w.params['at'])).toEqual([
      [70, 20],
      [70, 40],
      [30, 40],
      [30, 20],
    ])
    expect(ws[0]).toMatchObject({
      parameter: 'shape',
      suggestion: { relation: 'atLeast', value: 1.5 },
    })
  })

  it('reports arcs below the smallest end mill radius, not those at or above it', () => {
    expect(codes(run(pocket(box(1))))).toEqual(Array(4).fill('dfm.cornerTooSmall'))
    expect(run(pocket(box(1)))[0]!.params).toMatchObject({ cornerRadius: 1, toolRadius: 1.5 })
    expect(run(pocket(box(1.5)))).toEqual([])
    // without end mills in the library, only sharp corners warn
    expect(run(pocket(box(1)), { tools: [] })).toEqual([])
    expect(codes(run(pocket(box()), { tools: [] }))).toEqual(Array(4).fill('dfm.cornerSharp'))
  })

  it('lists 10 corners, then one count warning with the other markers', () => {
    const n = 14
    const pts: Vec2[] = Array.from({ length: n }, (_, i) => [
      20 * Math.cos((2 * Math.PI * i) / n),
      20 * Math.sin((2 * Math.PI * i) / n),
    ])
    const ws = run(pocket(region(poly(pts))))
    expect(ws).toHaveLength(11)
    expect(ws[10]!.params).toMatchObject({ more: 4 })
    expect(ws[10]!.params['points']).toHaveLength(8)
  })

  it('takes the loop corners of an inside profile and the notches of an outside one', () => {
    const at = (ws: DfmWarning[]) =>
      ws.filter((w) => w.code === 'dfm.cornerSharp').map((w) => w.params['at'])
    expect(at(run(profile(ell(), { side: 'outside' })))).toEqual([[50, 30]])
    expect(at(run(profile(ell(), { side: 'inside' })))).toHaveLength(5)
    // an island's notch is a corner of the pocket, its convex corners are not
    const island = region(rect(-30, -20, 60, 40, 3), hole(rect(-5, -5, 10, 10)))
    expect(run(pocket(island))).toEqual([])
    const notchedIsland = region(rect(-30, -25, 60, 50, 3), hole(ellLoop()))
    expect(
      run(pocket(notchedIsland))
        .filter((w) => w.code === 'dfm.cornerSharp')
        .map((w) => w.params['at']),
    ).toEqual([[50, 30]])
    // a groove on the line has no inside corners
    expect(codes(run(profile(box(), { side: 'on' })))).not.toContain('dfm.cornerSharp')
  })

  it('treats tangent joins and kinks below 5° as smooth', () => {
    const round = insideCorners([circle(0, 0, 10)], 1)
    expect(round.map((c) => c.radius)).toEqual([10, 10])
    const kink = CORNER_MIN_TURN * 0.9
    const nearlyStraight: Vec2[] = [
      [0, 0],
      [10, 0],
      [20, 10 * Math.tan(kink)],
      [20, 20],
      [0, 20],
    ]
    const corners = insideCorners([poly(nearlyStraight)], 1)
    expect(corners.filter((c) => c.radius === 0)).toHaveLength(4)
  })
})

/** The loop reversed: a hole. */
function hole(l: Loop): Loop {
  return {
    elements: [...l.elements]
      .reverse()
      .map((e) => (e.kind === 'line' ? line(e.b, e.a) : { ...e, a: e.b, b: e.a, ccw: !e.ccw })),
  }
}

describe('width', () => {
  it('warns when no end mill fits the region and measures its narrowest width', () => {
    // a 2.4 mm wide slot with round ends: no corner below the radius matters, the width does
    const slot = region(rect(-20, -1.2, 40, 2.4, 1.2))
    const ws = run(pocket(slot, { depth: 3 }))
    const w = ws.find((x) => x.code === 'dfm.pocketNoToolFits')!
    expect(w).toBeDefined()
    expect(w.params['narrowest']).toBeCloseTo(2.4, 2)
    expect(w.params['toolDiameter']).toBe(3)
  })

  it('warns about a deep, narrow region by its width', () => {
    const ws = run(pocket(box(3), { depth: 81 }))
    const w = ws.find((x) => x.code === 'dfm.pocketDeepNarrow')!
    expect(w.params['narrowest']).toBeCloseTo(20, 2)
    expect(codes(run(pocket(box(3), { depth: 81 })))).toContain('dfm.pocketDeepNarrow')
    expect(codes(run(pocket(box(3), { depth: 79 })))).not.toContain('dfm.pocketDeepNarrow')
  })

  it('fits tools by the width and the smallest inside corner', () => {
    const m = shapeMeasure(port, pocket(box(3)))!
    const fit = (op: OperationGeometry, d: number) =>
      toolFit(flat(d), op, STOCK, 'metric', shapeMeasure(port, op))?.rule ?? 'fits'
    expect(m.smallestCornerRadius).toBe(3)
    expect(fit(pocket(box(3)), 6)).toBe('fits')
    expect(fit(pocket(box(3)), 6.1)).toBe('cornerRadius')
    expect(fit(pocket(region(rect(-20, -2, 40, 4, 2))), 4)).toBe('fits')
    expect(fit(pocket(region(rect(-20, -2, 40, 4, 2))), 5)).toBe('width')
    expect(fit(pocket(box()), 3)).toBe('cornerRadius')
    // an outside profile: only the concave notch counts; a convex loop fits any slot-sized tool
    expect(fit(profile(ell()), 6)).toBe('cornerRadius')
    expect(fit(profile(box()), 6)).toBe('fits')
    expect(fit(profile(box(), { side: 'inside' }), 6)).toBe('cornerRadius')
    // without the measure (no port) a general shape's size rules are skipped
    expect(toolFit(flat(5), pocket(box()), STOCK, 'metric')).toBeUndefined()
    const slot = pocket(region(rect(-20, -2, 40, 4, 2)))
    expect(toolFit(flat(5), slot, STOCK, 'metric', shapeMeasure(port, slot))).toMatchObject({
      rule: 'width',
      values: { toolDiameter: 5, feature: 'pocket' },
    })
  })
})

describe('dfm.restMaterial', () => {
  it('reports a neck narrower than the own tool, with its area and marker', () => {
    const neck = region(dumbbell(2))
    const op = pocket(neck, { shape: shape(neck, [25, 30]) })
    const ws = run(op, { operationTools: own(op, 6) })
    const w = ws.find((x) => x.code === 'dfm.restMaterial')!
    expect(w).toMatchObject({ parameter: 'tool', severity: 'warning' })
    expect(w.params['area']).toBeGreaterThan(60)
    expect(w.params['area']).toBeLessThan(80)
    const [u, v] = w.params['at'] as number[]
    expect(Math.abs(u! - 50)).toBeLessThan(10)
    expect(Math.abs(v! - 30)).toBeLessThan(3)
    // a tool that passes the neck, or a wider neck, leaves none
    expect(codes(run(op, { operationTools: own(op, 3) }))).not.toContain('dfm.restMaterial')
    const wide = region(dumbbell(5))
    const wideOp = pocket(wide, { shape: shape(wide, [25, 30]) })
    expect(codes(run(wideOp, { operationTools: own(wideOp, 6) }))).not.toContain('dfm.restMaterial')
  })

  it('leaves corners to the corner rules', () => {
    const op = pocket(box())
    expect(codes(run(op, { operationTools: own(op, 6) }))).not.toContain('dfm.restMaterial')
  })

  it('finds a notch of an outside loop narrower than the tool', () => {
    // a 40 × 30 block with a 4 mm wide, 10 mm deep slot from the front (rounded at its end)
    const notched = region(
      poly([
        [-20, -15],
        [-2, -15],
        [-2, -5],
        [2, -5],
        [2, -15],
        [20, -15],
        [20, 15],
        [-20, 15],
      ]),
    )
    const op = profile(notched)
    expect(codes(run(op, { operationTools: own(op, 6) }))).toContain('dfm.restMaterial')
    expect(codes(run(op, { operationTools: own(op, 3) }))).not.toContain('dfm.restMaterial')
  })
})

describe('dfm.shapeOutsideFace', () => {
  it('warns when a general pocket reaches outside the face rectangle', () => {
    const op = pocket(box(3), { shape: shape(box(3), [85, 30]) })
    const w = run(op).find((x) => x.code === 'dfm.shapeOutsideFace')!
    expect(w.params).toMatchObject({ sides: ['stock.side[1]'], by: 5 })
    expect(codes(run(pocket(box(3))))).not.toContain('dfm.shapeOutsideFace')
  })
})

describe('slot margins and tabs of general profiles', () => {
  it('measures the stock margin from the loop, not a box around the placed shape', () => {
    // a diamond: its corners 5 mm from the left and front stock edges
    const diamond = region(
      poly([
        [0, -20],
        [20, 0],
        [0, 20],
        [-20, 0],
      ]),
    )
    const near = profile(diamond, { shape: shape(diamond, [25, 25]) })
    const w = run(near).find((x) => x.code === 'dfm.slotOpensStock')!
    expect(w.params).toMatchObject({ margin: 5, sides: ['stock.side[0]', 'stock.side[3]'] })
    const big: StockGeometry = { length: 200, width: 200, thickness: 20 }
    expect(
      codes(run(profile(diamond, { shape: shape(diamond, [100, 100]) }), {}, big)),
    ).not.toContain('dfm.slotOpensStock')
    expect(
      codes(
        run(
          profile(diamond, { shape: shape(diamond, [10, 10]) }),
          {},
          { length: 20, width: 20, thickness: 20 },
        ),
      ),
    ).toContain('dfm.slotLeavesStock')
  })

  it('applies the tab rules to through cuts of closed loops, with positions as tabs', () => {
    const b = box(3)
    expect(codes(run(profile(b, { tabs: { count: 0, width: 8, thickness: 3 } })))).toContain(
      'dfm.tabsNone',
    )
    expect(
      codes(run(profile(b, { tabs: { count: 0, width: 8, thickness: 3, positions: [10] } }))),
    ).not.toContain('dfm.tabsNone')
    expect(codes(run(profile(b, { tabs: { count: 2, width: 8, thickness: 0.5 } })))).toContain(
      'dfm.tabsThin',
    )
    // a slot covering the whole opening needs no tabs
    const small = region(circle(0, 0, 5))
    expect(codes(run(profile(small, { side: 'inside', slotWidth: 6 })))).toContain('dfm.tabsUnused')
    // a blind groove holds nothing apart
    expect(
      codes(run(profile(b, { side: 'on', depth: 2, tabs: { count: 0, width: 8, thickness: 3 } }))),
    ).not.toContain('dfm.tabsNone')
  })

  it('skips the region rules without the 2D port', () => {
    expect(
      parameterChecks(
        { stock: STOCK, operations: [pocket(box())] },
        { tools: LIBRARY, unitSystem: 'metric' },
      ),
    ).toEqual([])
  })
})

describe('the enclosure fixture (X0) with 3.175 and 6 mm end mills', () => {
  const fs = (
    globalThis as unknown as {
      process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, e: 'utf8'): string } }
    }
  ).process.getBuiltinModule('node:fs')
  const shapes = importSvg(fs.readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8')).unwrap().shapes
  const loopOf = (name: string): Region => {
    const item = shapes.find((s) => s.name === name)!.items[0]!
    if (item.kind !== 'loop') throw new Error('expected a loop')
    return region(item.loop)
  }
  // the 250 × 178 mm page on a 270 × 200 mm board
  const board: StockGeometry = { length: 270, width: 200, thickness: 40 }
  const tools = [flat(3.175), flat(6)]
  const placedAt = (r: Region) => shape(r, [10, 11])

  it('cavity pocket: two sharp corners at the back wall step, no rest material', () => {
    const op = pocket(loopOf('cavity'), { shape: placedAt(loopOf('cavity')), depth: 34.8 })
    for (const d of [3.175, 6]) {
      const ws = run(op, { tools, operationTools: own(op, d) }, board)
      expect(codes(ws)).toEqual(['dfm.cornerSharp', 'dfm.cornerSharp', 'dfm.toolUnfit'])
      expect(ws[2]!.params).toMatchObject({ rule: 'cornerRadius', cornerRadius: 0 })
      expect(ws.map((w) => (w.params['at'] as number[] | undefined)?.map(Math.round))).toEqual([
        [182, 178],
        [88, 178],
        undefined,
      ])
    }
    const m = shapeMeasure(port, op)!
    expect(m.narrowest()).toBeGreaterThan(150)
    expect(m.rest(3 - 0.005)).toEqual([])
    expect(m.rest(1.5875 - 0.005)).toEqual([])
  })

  it('outline outside profile: no notches, no corners, fits both tools', () => {
    const op = profile(loopOf('outline'), { shape: placedAt(loopOf('outline')) })
    for (const d of [3.175, 6]) {
      const ws = run(op, { tools, operationTools: own(op, d) }, board)
      expect(ws).toEqual([])
    }
  })
})
