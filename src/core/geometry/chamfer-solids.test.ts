// Edge chamfers E1 (inside edges): the removal solid of a chamfer along a pocket's loops,
// islands included, against the analytic volume (rectangles, circles) or the 2D oracle (spike
// S7's morphological opening by Simpson's rule), within half the chord-tolerance band (edge length ×
// depth × 0.01 mm). The offset-loft and the swept-chords fallback.
// Doc: docs/modes/edge-chamfers.md#implementation-e1, docs/research/2026-11-25-spike-s7-edge-chamfers.md
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { loopChamferConstruction, type ChamferSolidsContext } from './chamfer-solids'
import { evaluatePart, type PartEvaluation } from './evaluate'
import { loadManifold } from './manifold'
import {
  CHORD_TOLERANCE,
  type LoopChamferGeometry,
  type OperationGeometry,
  type StockGeometry,
} from './model'
import { needsRegion2d } from './operations'
import { loopChamferAir } from './outline'
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
): number {
  const without = evaluate([...before, edge], stock)
  const withC = evaluate([...before, edge, chamfer], stock)
  const v = signedVolume({
    positions: Float64Array.from(withC.positions),
    triangles: withC.indices,
  })
  expect(v).toBeCloseTo(withC.volume, 0)
  expect(withC.pieces ?? 1).toBe(1)
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
    expect(Math.abs(removed(pocket, c) - analytic)).toBeLessThan(band(loopChamferAir(c), 1) / 2)
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
      band(loopChamferAir(c), 1) / 2,
    )
  })

  it('sharp corners keep the V-bit cone: (a+b)wh + 4w²h/3 − 4·(4−π)/12·h·w²', () => {
    const outer = roundedRectLoop(20, 15, 100, 65, 0)
    const pocket = regionPocket('pocket1', numberRegion({ pieces: [{ outer, holes: [] }] }), 5)
    const c = chamferOf(pocket, 2)
    const mitred = (80 + 50) * 2 * 2 + (4 * 4 * 2) / 3
    const cones = 4 * ((4 - Math.PI) / 12) * 2 * 4
    expect(Math.abs(removed(pocket, c) - (mitred - cones))).toBeLessThan(
      band(loopChamferAir(c), 2) / 2,
    )
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
