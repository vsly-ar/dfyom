// Edge chamfers E3: `dfm.chamferMeets` and `dfm.chamferIncomplete` on spike S7's cases (the comb
// pocket's material teeth 6 / 2 / 1 mm at w 1.5; the dumbbell's 0.4 mm neck with a 0.6 mm tip), an
// island narrower than 2w, outside edges (a thin tongue, a narrow notch), sharp corners left out,
// a split piece's cell, and the wiring into `parameterChecks` with the operation's own tool.
// Doc: docs/modes/edge-chamfers.md#dfm-findings, docs/modes/edge-chamfers.md#implementation-e3
import { describe, expect, it } from 'vitest'
import { chamferIncomplete, chamferMeets } from './chamfer-findings'
import { parameterChecks, type OperationTool } from './dfm'
import type { LoopChamferGeometry, OperationGeometry, StockGeometry } from './model'
import { line, type Loop, type Region } from './2d/model'
import { numberRegion } from './2d/place'
import { nodeRegion2d } from './2d/testing/node-wasm'
import { circleLoop, regionPocket, roundedRectLoop } from './testing/shape-regions'
import { ENCLOSURE_SECTIONS_SVG } from '../design/enclosure-sections.testing'
import { importSvg } from '../import/svg/import'
import { placeLoops } from '../toolpath/testing/region-coverage'
import { expectOk } from '../../shared/testing/result'

const port = nodeRegion2d()
const STOCK: StockGeometry = { length: 200, width: 120, thickness: 20 }

const polygon = (pts: readonly (readonly [number, number])[]): Loop => ({
  elements: pts.map((p, i) =>
    line([p[0], p[1]], [pts[(i + 1) % pts.length]![0], pts[(i + 1) % pts.length]![1]]),
  ),
})
const regionOf = (outer: Loop, holes: Loop[] = []): Region =>
  numberRegion({ pieces: [{ outer, holes }] })

/** Spike S7's comb pocket: a rectangle with `k` material teeth `tooth` wide reaching in from y0. */
function combLoop(
  x0: number,
  y0: number,
  k: number,
  tooth: number,
  gap: number,
  len: number,
  height: number,
): Loop {
  const pts: [number, number][] = [[x0, y0]]
  let x = x0 + gap
  for (let i = 0; i < k; i++) {
    pts.push([x, y0], [x, y0 + len], [x + tooth, y0 + len], [x + tooth, y0])
    x += tooth + gap
  }
  pts.push([x, y0], [x, y0 + height], [x0, y0 + height])
  return polygon(pts)
}

/** Spike S7's dumbbell: two R15 discs joined by a neck 2 × `neck` wide. */
function dumbbell(neck: number): Region {
  const R = 15
  const x = Math.sqrt(R * R - neck * neck)
  const a: [number, number] = [70 + x, 60 - neck]
  const b: [number, number] = [120 - x, 60 - neck]
  const c: [number, number] = [120 - x, 60 + neck]
  const d: [number, number] = [70 + x, 60 + neck]
  return regionOf({
    elements: [
      { kind: 'line', a, b },
      { kind: 'arc', a: b, b: c, centre: [120, 60], ccw: true },
      { kind: 'line', a: c, b: d },
      { kind: 'arc', a: d, b: a, centre: [70, 60], ccw: true },
    ],
  })
}

function pocketChamfer(
  region: Region,
  width: number,
): { edge: OperationGeometry; chamfer: LoopChamferGeometry } {
  const edge = regionPocket('pocket1', region, 8)
  if (edge.kind !== 'pocket') throw new Error('test: a pocket')
  return {
    edge,
    chamfer: {
      kind: 'chamfer',
      id: 'chamfer1',
      onZ: 0,
      edgeOf: 'pocket1',
      edge: { shape: edge.shape, side: 'inside', depth: 8 },
      width,
      angle: 90,
    },
  }
}

function outlineChamfer(
  part: Region,
  width: number,
  within?: LoopChamferGeometry['edge']['within'],
): LoopChamferGeometry {
  return {
    kind: 'chamfer',
    id: 'chamfer1',
    onZ: 0,
    edgeOf: 'profile1',
    edge: {
      shape: { center: [0, 0], contour: { kind: 'region', region: part } },
      side: 'outside',
      ...(within === undefined ? {} : { within }),
    },
    width,
    angle: 90,
  }
}

const vbit = (tip: number): OperationTool => ({
  tool: { type: 'chamferMill', diameter: 12, angle: 90, tipDiameter: tip },
  generalized: false,
  locked: false,
  label: 'V-bit 90°',
})

describe('dfm.chamferMeets (E3)', () => {
  it('the comb: 6 mm teeth keep their top at w 1.5; 2 and 1 mm teeth meet, wall ≈ the tooth', () => {
    expect(
      chamferMeets(pocketChamfer(regionOf(combLoop(40, 30, 8, 6, 6, 30, 60)), 1.5).chamfer, port),
    ).toBeUndefined()
    for (const tooth of [2, 1]) {
      const m = chamferMeets(
        pocketChamfer(regionOf(combLoop(40, 30, 8, tooth, 6, 30, 60)), 1.5).chamfer,
        port,
      )
      expect(m).toBeDefined()
      expect(m!.wall).toBeCloseTo(tooth, 1)
      // the markers lie on the teeth (y within the tooth length)
      expect(m!.at[1]).toBeGreaterThan(30)
      expect(m!.at[1]).toBeLessThan(60)
      expect(m!.points.length / 2).toBe(8)
    }
  })

  it('a 2 mm tooth is no finding at w 0.9 (2w below the tooth)', () => {
    expect(
      chamferMeets(pocketChamfer(regionOf(combLoop(40, 30, 8, 2, 6, 30, 60)), 0.9).chamfer, port),
    ).toBeUndefined()
  })

  it('an island narrower than 2w meets itself; a sharp rectangle pocket does not (mitres)', () => {
    const outer = roundedRectLoop(20, 20, 120, 90, 0)
    const island = circleLoop([70, 55], 1, false)
    const m = chamferMeets(pocketChamfer(regionOf(outer, [island]), 1.5).chamfer, port)
    expect(m?.wall).toBeCloseTo(2, 1)
    expect(chamferMeets(pocketChamfer(regionOf(outer), 1.5).chamfer, port)).toBeUndefined()
  })

  it('an outline with a 2 mm tongue meets at w 1.5; the plain outline does not', () => {
    const tongue = regionOf(
      polygon([
        [20, 20],
        [120, 20],
        [120, 60],
        [70, 60],
        [70, 90],
        [68, 90],
        [68, 60],
        [20, 60],
      ]),
    )
    const m = chamferMeets(outlineChamfer(tongue, 1.5), port)
    expect(m?.wall).toBeCloseTo(2, 1)
    expect(m!.at[1]).toBeGreaterThan(60)
    expect(
      chamferMeets(outlineChamfer(regionOf(roundedRectLoop(20, 20, 120, 60, 0)), 1.5), port),
    ).toBeUndefined()
    // on a split piece whose cell leaves out the tongue: none
    expect(
      chamferMeets(outlineChamfer(tongue, 1.5, { min: [0, 0], max: [60, 120] }), port),
    ).toBeUndefined()
  })
})

describe('dfm.chamferIncomplete (E3)', () => {
  it('the dumbbell: a 0.6 mm tip misses the 0.4 mm neck, both its walls', () => {
    const { chamfer } = pocketChamfer(dumbbell(0.2), 1)
    const miss = chamferIncomplete(chamfer, port, 0.6)
    expect(miss).toBeDefined()
    // the neck is ≈ 20 mm long, two walls, plus a little where it widens into the discs
    expect(miss!.length).toBeGreaterThan(38)
    expect(miss!.length).toBeLessThan(46)
    expect(miss!.at[0]).toBeGreaterThan(85)
    expect(miss!.at[0]).toBeLessThan(105)
    // a pointed bit and a tip that fits the neck reach it all
    expect(chamferIncomplete(chamfer, port, 0)).toBeUndefined()
    expect(chamferIncomplete(chamfer, port, 0.3)).toBeUndefined()
  })

  it('sharp pocket corners are not reported (dfm.cornerSharp covers them)', () => {
    const { chamfer } = pocketChamfer(regionOf(roundedRectLoop(20, 20, 120, 90, 0)), 1)
    expect(chamferIncomplete(chamfer, port, 0.6)).toBeUndefined()
  })

  it('an outline with a 0.4 mm notch: the tip misses its walls', () => {
    const notched = regionOf(
      polygon([
        [20, 20],
        [120, 20],
        [120, 60],
        [70.2, 60],
        [70.2, 50],
        [69.8, 50],
        [69.8, 60],
        [20, 60],
      ]),
    )
    const miss = chamferIncomplete(outlineChamfer(notched, 1), port, 0.6)
    expect(miss).toBeDefined()
    expect(miss!.length).toBeGreaterThan(15)
    expect(miss!.length).toBeLessThan(23)
    expect(miss!.at[0]).toBeCloseTo(70, 0)
  })

  it('parameterChecks: both findings with markers; incomplete only with a tipped own tool', () => {
    const comb = pocketChamfer(regionOf(combLoop(40, 30, 8, 1, 6, 30, 60)), 1.5)
    const neck = pocketChamfer(dumbbell(0.2), 1)
    const run = (ops: OperationGeometry[], tools = {}) =>
      parameterChecks(
        { stock: STOCK, operations: ops },
        { tools: [], unitSystem: 'metric', region2d: port, operationTools: tools },
      )
    const meets = run([comb.edge, comb.chamfer]).find((w) => w.code === 'dfm.chamferMeets')
    expect(meets).toMatchObject({ parameter: 'width', operation: 'chamfer1', severity: 'warning' })
    expect(meets!.suggestion).toEqual({ relation: 'atMost', value: expect.closeTo(0.5, 1) })
    expect(meets!.params['at']).toHaveLength(2)
    const codes = (tools: Record<string, OperationTool>) =>
      run([neck.edge, neck.chamfer], tools).map((w) => w.code)
    expect(codes({})).not.toContain('dfm.chamferIncomplete')
    expect(codes({ chamfer1: vbit(0) })).not.toContain('dfm.chamferIncomplete')
    const inc = run([neck.edge, neck.chamfer], { chamfer1: vbit(0.6) }).find(
      (w) => w.code === 'dfm.chamferIncomplete',
    )
    expect(inc).toMatchObject({
      parameter: 'tool',
      params: { tipDiameter: 0.6, edgeOf: 'pocket1' },
    })
  })
})

describe('the enclosure (E3 budget)', () => {
  it('cavity rim and outline at 1.5 mm with a 0.2 mm tip: no findings, within the DFM budget', () => {
    const proc = (
      globalThis as unknown as {
        process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, e: 'utf8'): string } }
      }
    ).process
    const svg = proc.getBuiltinModule('node:fs').readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8')
    const shapes = expectOk(importSvg(svg)).shapes
    const loopOf = (name: string): Loop => {
      const item = shapes.find((x) => x.name === name)!.items[0]!
      if (item.kind !== 'loop') throw new Error('test: a loop')
      return item.loop
    }
    const placed = placeLoops([loopOf('outline'), loopOf('cavity')], 12).loops
    const outline = outlineChamfer(regionOf(placed[0]!), 1.5)
    const cavity = pocketChamfer(regionOf(placed[1]!), 1.5).chamfer
    const t0 = performance.now()
    for (const c of [outline, cavity]) {
      expect(chamferMeets(c, port)).toBeUndefined()
      expect(chamferIncomplete(c, port, 0.2)).toBeUndefined()
    }
    const ms = performance.now() - t0
    // S7: the edge's offsets take a few ms each; the pass must stay well inside a design change
    expect(ms).toBeLessThan(400)
    console.log(`E3 findings, enclosure outline + cavity: ${ms.toFixed(1)} ms`)
  })
})
