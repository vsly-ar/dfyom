// Edge chamfers E1 (inside edges): the removal solid of a chamfer along a pocket's loops,
// islands included, against the analytic volume (rectangles, circles) or the 2D oracle (spike
// S7's morphological opening by Simpson's rule), within half the chord-tolerance band (edge length ×
// depth × 0.01 mm). The offset-loft and the swept-chords fallback. E2: outside edges (the annular
// V-groove against M − M⊖ρ), a split piece's `within` mask and the enclosure outline.
// Doc: docs/modes/edge-chamfers.md#implementation-e1, docs/modes/edge-chamfers.md#implementation-e2,
// docs/research/2026-11-25-spike-s7-edge-chamfers.md. Patterns P3: an edge of several pieces is lofted
// and checked piece by piece (docs/modes/patterns.md#implementation-p3).
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import {
  loopChamferConstruction,
  loopChamferPieces,
  type ChamferSolidsContext,
} from './chamfer-solids'
import { evaluatePart, type PartEvaluation } from './evaluate'
import { loadManifold } from './manifold'
import {
  CHORD_TOLERANCE,
  type LoopChamferGeometry,
  type OperationGeometry,
  type StockGeometry,
} from './model'
import { needsRegion2d } from './operations'
import { loopChamferRegion } from './outline'
import { parameterChecks } from './dfm'
import { regionArea, regionLoops, type Region } from './2d/model'
import { numberRegion } from './2d/place'
import { nodeRegion2d } from './2d/testing/node-wasm'
import type { SolidKernel } from './solid-port'
import { signedVolume } from './testing/mesh-oracles'
import { circleLoop, regionPocket, roundedRectLoop } from './testing/shape-regions'
import { ENCLOSURE_SECTIONS_SVG } from '../design/enclosure-sections.testing'
import { importSvg } from '../import/svg/import'
import { placeLoops } from '../toolpath/testing/region-coverage'

let kernel: SolidKernel
const port = nodeRegion2d()

beforeAll(async () => {
  kernel = expectOk(await loadManifold())
})

const STOCK: StockGeometry = { length: 120, width: 80, thickness: 20 }

const evaluate = (operations: OperationGeometry[], stock = STOCK): PartEvaluation =>
  expectOk(kernel.withSolids((s) => evaluatePart({ stock, operations }, s, undefined, port)))

/** Big enough for the enclosure placed with a 12 mm margin (spike S7). */
const ENCLOSURE_STOCK: StockGeometry = { length: 260, width: 200, thickness: 40 }
/** The enclosure's outline (249.5 × 177) at a 12 mm margin with its 6 mm slot inside the stock. */
const OUTLINE_STOCK: StockGeometry = { length: 285, width: 215, thickness: 40 }

function chamferOf(edge: OperationGeometry, width: number, angle = 90): LoopChamferGeometry {
  if (edge.kind !== 'pocket') throw new Error('test: a pocket edge')
  return {
    kind: 'chamfer',
    id: 'chamfer1',
    onZ: edge.onZ,
    edgeOf: edge.id,
    edge: { shape: edge.shape, side: 'inside', depth: edge.depth },
    width,
    angle,
  }
}

/** The bevel's volume: the part with the pocket minus the part with pocket and chamfer. */
function removed(
  edge: OperationGeometry,
  chamfer: LoopChamferGeometry,
  before: OperationGeometry[] = [],
  stock = STOCK,
  pieces = 1,
): number {
  const without = evaluate([...before, edge], stock)
  const withC = evaluate([...before, edge, chamfer], stock)
  const v = signedVolume({
    positions: Float64Array.from(withC.positions),
    triangles: withC.indices,
  })
  expect(v).toBeCloseTo(withC.volume, 0)
  expect(withC.pieces ?? 1).toBe(pieces)
  expect(kernel.liveObjects()).toBe(0)
  return without.volume - withC.volume
}

/** Edge length × depth × chord tolerance (mm³): the volume a 0.01 mm shift of the bevel moves. */
function band(air: Region, depth: number): number {
  const length = regionLoops(air).reduce((s, l) => s + port.length(l), 0)
  return length * depth * CHORD_TOLERANCE
}

/**
 * Spike S7's oracle for a pointed bit: at depth t below the face the removed area is
 * (A ⊕ ρ(t)) minus A, ρ(t) = (h − t)·tan(α/2); Simpson's rule over t.
 */
function oracle(air: Region, width: number, angle = 90, n = 24): number {
  const tan = Math.tan(((angle / 2) * Math.PI) / 180)
  const h = width / tan
  const base = regionArea(air)
  const f = (t: number): number => {
    const rho = (h - t) * tan
    if (rho <= 0) return 0
    const grown = expectOk(port.offset(air, -rho))
    return regionArea(expectOk(port.union(grown, air))) - base
  }
  let sum = f(0) + f(h)
  for (let k = 1; k < n; k++) sum += (k % 2 === 1 ? 4 : 2) * f((k * h) / n)
  return (sum * h) / (3 * n)
}

const OPTIONS = { tools: [], unitSystem: 'metric', region2d: port } as const

const ctx: ChamferSolidsContext = {
  triangulate: (r) => kernel.withSolids((s) => s.triangulate(r)),
  region2d: port,
}

describe('loop chamfer solids (E1, inside edges)', () => {
  it('a rounded rectangle pocket: h(P·w/2 + πw²/3), one loft', () => {
    const outer = roundedRectLoop(20, 15, 100, 65, 3)
    const pocket = regionPocket('pocket1', numberRegion({ pieces: [{ outer, holes: [] }] }), 5)
    const c = chamferOf(pocket, 1)
    const P = port.length(outer)
    const analytic = P * 0.5 + Math.PI / 3
    expect(loopChamferConstruction(c, ctx)).toBe('loft')
    expect(Math.abs(removed(pocket, c) - analytic)).toBeLessThan(band(loopChamferRegion(c), 1) / 2)
  })

  it('an analytic rectangle pocket (v0.1 contour) takes the general path too', () => {
    const pocket: OperationGeometry = {
      kind: 'pocket',
      id: 'pocket1',
      onZ: 0,
      shape: {
        center: [60, 40],
        contour: { kind: 'rectangle', length: 80, width: 50, cornerRadius: 3 },
      },
      depth: 5,
      floorRadius: 0,
    }
    const c = chamferOf(pocket, 1)
    expect(needsRegion2d({ stock: STOCK, operations: [pocket, c] })).toBe(true)
    const P = 2 * (80 + 50) - 8 * 3 + 2 * Math.PI * 3
    expect(Math.abs(removed(pocket, c) - (P * 0.5 + Math.PI / 3))).toBeLessThan(
      band(loopChamferRegion(c), 1) / 2,
    )
  })

  it('sharp corners keep the V-bit cone: (a+b)wh + 4w²h/3 − 4·(4−π)/12·h·w²', () => {
    const outer = roundedRectLoop(20, 15, 100, 65, 0)
    const pocket = regionPocket('pocket1', numberRegion({ pieces: [{ outer, holes: [] }] }), 5)
    const c = chamferOf(pocket, 2)
    const mitred = (80 + 50) * 2 * 2 + (4 * 4 * 2) / 3
    const cones = 4 * ((4 - Math.PI) / 12) * 2 * 4
    expect(Math.abs(removed(pocket, c) - (mitred - cones))).toBeLessThan(
      band(loopChamferRegion(c), 2) / 2,
    )
  })

  it('E4a corner lift: the mitre, (a+b)wh + 4w²h/3 with the cones filled', () => {
    const outer = roundedRectLoop(20, 15, 100, 65, 0)
    const pocket = regionPocket('pocket1', numberRegion({ pieces: [{ outer, holes: [] }] }), 5)
    const c: LoopChamferGeometry = { ...chamferOf(pocket, 2), cornerLift: true }
    const mitred = (80 + 50) * 2 * 2 + (4 * 4 * 2) / 3
    expect(Math.abs(removed(pocket, c) - mitred)).toBeLessThan(band(loopChamferRegion(c), 2) / 2)
  })

  it('E4a chosen loops: the rim only leaves the island sharp, the island only the rim', () => {
    const outer = roundedRectLoop(20, 15, 100, 65, 3)
    const island = circleLoop([60, 40], 10, false)
    const region = numberRegion({ pieces: [{ outer, holes: [island] }] })
    const pocket = regionPocket('pocket1', region, 5)
    const all = chamferOf(pocket, 1)
    const rim = port.length(outer) * 0.5 + Math.PI / 3
    const isle = Math.PI * (10 * 1 - 1 / 3)
    const tol = band(region, 1) / 2
    const only = (loops: number[]): LoopChamferGeometry => ({
      ...all,
      edge: { ...all.edge, loops },
    })
    expect(Math.abs(removed(pocket, only([0])) - rim)).toBeLessThan(tol)
    expect(Math.abs(removed(pocket, only([1])) - isle)).toBeLessThan(tol)
    expect(Math.abs(removed(pocket, only([0, 1])) - (rim + isle))).toBeLessThan(tol)
  })

  it('a pocket with an island: the rim and the island, one piece', () => {
    const outer = roundedRectLoop(20, 15, 100, 65, 3)
    const island = circleLoop([60, 40], 10, false)
    const region = numberRegion({ pieces: [{ outer, holes: [island] }] })
    const pocket = regionPocket('pocket1', region, 5)
    const c = chamferOf(pocket, 1)
    const rim = port.length(outer) * 0.5 + Math.PI / 3
    const isle = Math.PI * (10 * 1 - 1 / 3)
    expect(loopChamferConstruction(c, ctx)).toBe('loft')
    const v = removed(pocket, c)
    expect(Math.abs(v - (rim + isle))).toBeLessThan(band(region, 1) / 2)
    expect(Math.abs(v - oracle(region, 1))).toBeLessThan(band(region, 1) / 2)
  })

  it('60° and a pocket on a floor: the oracle at the floor level', () => {
    const outer = roundedRectLoop(30, 20, 90, 60, 4)
    const region = numberRegion({ pieces: [{ outer, holes: [circleLoop([60, 40], 6, false)] }] })
    const pocket = regionPocket('pocket1', region, 4, undefined, -2)
    const c = chamferOf(pocket, 0.8, 60)
    const depth = 0.8 / Math.tan(Math.PI / 6)
    // the floor is a facing's, 2 mm down
    const facing: OperationGeometry = { kind: 'facing', id: 'facing1', depth: 2 }
    expect(Math.abs(removed(pocket, c, [facing]) - oracle(region, 0.8, 60))).toBeLessThan(
      band(region, depth) / 2,
    )
  })

  it('an island narrower than 2 × width (the bevels meet): the swept-chords fallback', () => {
    const outer = roundedRectLoop(20, 15, 100, 65, 3)
    const tooth = roundedRectLoop(40, 39.5, 80, 40.5, 0, false)
    const region = numberRegion({ pieces: [{ outer, holes: [tooth] }] })
    const pocket = regionPocket('pocket1', region, 5)
    const c = chamferOf(pocket, 1)
    expect(loopChamferConstruction(c, ctx)).toBe('fallback')
    expect(Math.abs(removed(pocket, c) - oracle(region, 1))).toBeLessThan(band(region, 1) / 2)
  })

  it('the enclosure cavity rim, 1 × 45° (E1 exit): the oracle within the band, one loft', () => {
    const proc = (
      globalThis as unknown as {
        process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, e: 'utf8'): string } }
      }
    ).process
    const svg = proc.getBuiltinModule('node:fs').readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8')
    const item = expectOk(importSvg(svg)).shapes.find((x) => x.name === 'cavity')!.items[0]!
    if (item.kind !== 'loop') throw new Error('test: the cavity is a loop')
    const cavity = placeLoops([item.loop], 12).loops[0]!
    const region = numberRegion({ pieces: [{ outer: cavity, holes: [] }] })
    const pocket = regionPocket('pocket1', region, 10)
    const c = chamferOf(pocket, 1)
    expect(loopChamferConstruction(c, ctx)).toBe('loft')
    expect(Math.abs(removed(pocket, c, [], ENCLOSURE_STOCK) - oracle(region, 1))).toBeLessThan(
      band(region, 1) / 2,
    )
  })

  it('DFM: chamferTooDeep for a pocket shallower than the bevel; no warning otherwise', () => {
    const outer = roundedRectLoop(20, 15, 100, 65, 3)
    const shallow = regionPocket('pocket1', numberRegion({ pieces: [{ outer, holes: [] }] }), 1)
    const deep = regionPocket('pocket1', numberRegion({ pieces: [{ outer, holes: [] }] }), 5)
    const codes = (ops: OperationGeometry[]) =>
      parameterChecks({ stock: STOCK, operations: ops }, OPTIONS).map((w) => w.code)
    const tooDeep = parameterChecks(
      { stock: STOCK, operations: [shallow, chamferOf(shallow, 1.5)] },
      OPTIONS,
    ).filter((w) => w.code === 'dfm.chamferTooDeep')
    expect(tooDeep).toHaveLength(1)
    expect(tooDeep[0]!.suggestion).toEqual({ relation: 'atMost', value: expect.closeTo(1, 6) })
    expect(codes([deep, chamferOf(deep, 1)])).not.toContain('dfm.chamferTooDeep')
  })
})

/** A through outside profile on `region`'s loop (6 mm slot, no tabs), its edge chamfered. */
function outsideOf(region: Region, id = 'profile1'): OperationGeometry {
  return {
    kind: 'profile',
    id,
    shape: { center: [0, 0], contour: { kind: 'region', region } },
    side: 'outside',
    slotWidth: 6,
    tabs: { count: 0, width: 6, thickness: 2 },
  }
}

function outsideChamfer(
  edge: OperationGeometry,
  width: number,
  extra: Partial<LoopChamferGeometry['edge']> = {},
): LoopChamferGeometry {
  if (edge.kind !== 'profile') throw new Error('test: a profile edge')
  return {
    kind: 'chamfer',
    id: 'chamfer1',
    onZ: 0,
    edgeOf: edge.id,
    edge: { shape: edge.shape, side: 'outside', ...extra },
    width,
    angle: 90,
  }
}

/**
 * Spike S7's oracle for an outside edge of the part M: at depth t the removed area is M minus
 * (M ⊖ ρ(t)), ρ(t) = (h − t)·tan(α/2); Simpson's rule over t.
 */
function outsideOracle(part: Region, width: number, angle = 90, n = 24): number {
  const tan = Math.tan(((angle / 2) * Math.PI) / 180)
  const h = width / tan
  const base = regionArea(part)
  const f = (t: number): number => {
    const rho = (h - t) * tan
    return rho <= 0 ? 0 : base - regionArea(expectOk(port.offset(part, rho)))
  }
  let sum = f(0) + f(h)
  for (let k = 1; k < n; k++) sum += (k % 2 === 1 ? 4 : 2) * f((k * h) / n)
  return (sum * h) / (3 * n)
}

describe('loop chamfer solids (E2, outside edges)', () => {
  it('a rectangle outline 100 × 60: 355.5 mm³ (S7), one annular loft, part and offcut', () => {
    const part = numberRegion({
      pieces: [{ outer: roundedRectLoop(10, 10, 110, 70, 0), holes: [] }],
    })
    const profile = outsideOf(part)
    const c = outsideChamfer(profile, 1.5)
    expect(loopChamferConstruction(c, ctx)).toBe('loft')
    // h((a+b)w − 4w²/3) (spike S7): 320 mm of edge × w·h/2, less the mitred corners
    const analytic = 1.5 * (160 * 1.5 - (4 * 1.5 * 1.5) / 3)
    expect(analytic).toBeCloseTo(355.5, 9)
    const v = removed(profile, c, [], STOCK, 2)
    expect(Math.abs(v - analytic)).toBeLessThan(band(part, 1.5) / 2)
  })

  it('a rounded outline with fitted arcs against the 2D oracle, 60°', () => {
    const part = numberRegion({
      pieces: [{ outer: roundedRectLoop(15, 12, 105, 68, 8), holes: [] }],
    })
    const profile = outsideOf(part)
    const c = { ...outsideChamfer(profile, 1), angle: 60 }
    const depth = 1 / Math.tan(Math.PI / 6)
    expect(loopChamferConstruction(c, ctx)).toBe('loft')
    expect(Math.abs(removed(profile, c, [], STOCK, 2) - outsideOracle(part, 1, 60))).toBeLessThan(
      band(part, depth) / 2,
    )
  })

  it('a part narrower than 2 × width: the swept-chords fallback, still the oracle', () => {
    const part = numberRegion({
      pieces: [{ outer: roundedRectLoop(20, 39, 100, 41, 0), holes: [] }],
    })
    const profile = outsideOf(part)
    const c = outsideChamfer(profile, 1.5)
    expect(loopChamferConstruction(c, ctx)).toBe('fallback')
    expect(Math.abs(removed(profile, c, [], STOCK, 2) - outsideOracle(part, 1.5))).toBeLessThan(
      band(part, 1.5) / 2,
    )
  })

  it('a split piece (`within`): only the edge in the cell, the bevel stops past the split line', () => {
    const part = numberRegion({
      pieces: [{ outer: roundedRectLoop(10, 10, 110, 70, 0), holes: [] }],
    })
    const profile = outsideOf(part)
    const full = removed(profile, outsideChamfer(profile, 1.5), [], STOCK, 2)
    const half = removed(
      profile,
      outsideChamfer(profile, 1.5, { within: { min: [-10, -10], max: [60, 90] } }),
      [],
      STOCK,
      2,
    )
    // the left half, and the top and bottom bevels on to the mask at 60 + the reach at the face
    const reach = 1.5 + 4 * CHORD_TOLERANCE
    const expected = full / 2 + 2 * reach * ((1.5 * 1.5) / 2)
    expect(Math.abs(half - expected)).toBeLessThan(band(part, 1.5) / 2)
  })

  it('E4b tabs: the bevel is masked round each tab centre (a disc of the gap less w/2)', () => {
    const part = numberRegion({
      pieces: [{ outer: roundedRectLoop(10, 10, 110, 70, 0), holes: [] }],
    })
    const profile = outsideOf(part)
    const w = 1.5
    const full = removed(profile, outsideChamfer(profile, w), [], STOCK, 2)
    const tabs = [
      { at: [60, 10] as const, width: 6 },
      { at: [110, 40] as const, width: 6 },
      { at: [60, 70] as const, width: 6 },
      { at: [10, 40] as const, width: 6 },
    ]
    const masked = removed(profile, outsideChamfer(profile, w, { tabs }), [], STOCK, 2)
    // per tab the bevel (depth w − d at d into the part, 45°) within the disc of radius r
    const r = 3 + w / 2 + 1
    const n = 200
    let lost = 0
    for (let k = 0; k < n; k++) {
      const d = ((k + 0.5) * w) / n
      lost += (w - d) * 2 * Math.sqrt(r * r - d * d) * (w / n)
    }
    expect(Math.abs(full - masked - 4 * lost)).toBeLessThan(band(part, w) / 2)
  })

  it('the enclosure outline, 1.5 × 45° (DF77, E2 exit): the oracle within the band, one loft', () => {
    const proc = (
      globalThis as unknown as {
        process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, e: 'utf8'): string } }
      }
    ).process
    const svg = proc.getBuiltinModule('node:fs').readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8')
    const item = expectOk(importSvg(svg)).shapes.find((x) => x.name === 'outline')!
    const loopItem = item.items[0]!
    if (loopItem.kind !== 'loop') throw new Error('test: the outline is a loop')
    const outline = placeLoops([loopItem.loop], 12).loops[0]!
    const part = numberRegion({ pieces: [{ outer: outline, holes: [] }] })
    const profile = outsideOf(part)
    const c = outsideChamfer(profile, 1.5)
    expect(loopChamferConstruction(c, ctx)).toBe('loft')
    // fitted arcs: the profile's part is flattened circumscribed and the bevel inscribed, both
    // by the chord tolerance, so the error reaches ≈ 0.7 of the band (S7 measured 0.69–0.71)
    expect(
      Math.abs(removed(profile, c, [], OUTLINE_STOCK, 2) - outsideOracle(part, 1.5)),
    ).toBeLessThan(band(part, 1.5))
  })
})

describe('loop chamfer solids piece by piece (patterns P3)', () => {
  const cells = (xs: readonly number[], size = 10): Region =>
    numberRegion({
      pieces: xs.map((x) => ({ outer: roundedRectLoop(x, 20, x + size, 20 + size, 2), holes: [] })),
    })

  it('cells apart: one loft and one mesh for every copy, the oracle', () => {
    const region = cells([10, 25, 40, 55])
    const pocket = regionPocket('pocket1', region, 3)
    const c = chamferOf(pocket, 1)
    expect(loopChamferPieces(c, ctx)).toEqual({ lofted: 4, fallback: 0, meshes: 1, groups: 1 })
    expect(loopChamferConstruction(c, ctx)).toBe('loft')
    expect(Math.abs(removed(pocket, c) - oracle(region, 1))).toBeLessThan(band(region, 1) / 2)
  })

  it('bevels meeting on a 1 mm web: neighbours in different meshes, still lofted, the oracle', () => {
    // webs of 1 mm under 2 × 1.5: every neighbour pair meets; alternate cells share a mesh
    const region = cells([10, 21, 32, 43])
    const pocket = regionPocket('pocket1', region, 3)
    const c = chamferOf(pocket, 1.5)
    expect(loopChamferPieces(c, ctx)).toEqual({ lofted: 4, fallback: 0, meshes: 2, groups: 1 })
    expect(Math.abs(removed(pocket, c) - oracle(region, 1.5))).toBeLessThan(band(region, 1.5) / 2)
  })

  it('one piece whose own offset changes structure is swept alone; the others keep the loft', () => {
    // a piece with a 1 mm tooth (a hole narrower than 2 × width) next to two plain cells
    const tooth = roundedRectLoop(80, 29.5, 95, 30.5, 0, false)
    const region = numberRegion({
      pieces: [
        { outer: roundedRectLoop(10, 20, 20, 30, 2), holes: [] },
        { outer: roundedRectLoop(25, 20, 35, 30, 2), holes: [] },
        { outer: roundedRectLoop(70, 15, 105, 45, 3), holes: [tooth] },
      ],
    })
    const pocket = regionPocket('pocket1', region, 3)
    const c = chamferOf(pocket, 1)
    const stats = loopChamferPieces(c, ctx)!
    expect(stats).toMatchObject({ lofted: 2, fallback: 1, groups: 2 })
    expect(loopChamferConstruction(c, ctx)).toBe('fallback')
    expect(Math.abs(removed(pocket, c) - oracle(region, 1))).toBeLessThan(band(region, 1) / 2)
  })
})
