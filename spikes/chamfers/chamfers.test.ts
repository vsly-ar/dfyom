/**
 * Spike S7 tests and measurements (report: docs/research/2026-11-25-spike-s7-edge-chamfers.md).
 * Run: `npx vitest run -c spikes/chamfers/vitest.config.mts --silent=false` (prints the tables).
 *
 * Reassembly: the chamfer's swept solid is subtracted from the part that the app's own
 * `evaluatePart` builds (a SolidPort wrapper subtracts it from the stock before the first layer;
 * subtraction order does not change the solid). Its triangles carry the stock's id and the
 * `top` label, so the app's labelling accepts them.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { evaluatePart, subtractionLayers } from '../../src/core/geometry/evaluate'
import { loadManifold } from '../../src/core/geometry/manifold'
import type { OperationGeometry, StockGeometry } from '../../src/core/geometry/model'
import { stockSolids } from '../../src/core/geometry/operations'
import type { Solid, SolidKernel, SolidPort } from '../../src/core/geometry/solid-port'
import { nodeManifoldSource } from '../../src/core/geometry/testing/node-wasm'
import { nodeRegion2d } from '../../src/core/geometry/2d/testing/node-wasm'
import { numberRegion } from '../../src/core/geometry/2d/place'
import {
  regionArea,
  regionLoops,
  reverseLoop,
  type Loop,
  type Region,
} from '../../src/core/geometry/2d/model'
import type { Region2dPort } from '../../src/core/geometry/2d/port'
import {
  circleLoop,
  islandsRegion,
  roundedRectLoop,
  scallopLoop,
} from '../../src/core/geometry/testing/shape-regions'
import { ENCLOSURE_SECTIONS_SVG } from '../../src/core/design/enclosure-sections.testing'
import { importSvg } from '../../src/core/import/svg/import'
import { placeLoops } from '../../src/core/toolpath/testing/region-coverage'
import { Ok } from '../../src/shared/result'
import { loftFailure, offsetLoft } from './loft'
import {
  tanHalf,
  chamferPath,
  depthOf,
  geometryTool,
  loadWasm,
  removedVolume,
  sweep,
  type ChamferSpec,
  type SweepStats,
  type VTool,
  type Wasm,
} from './sweep'

const MODE = process.env['S7_MODE'] ?? 'union'
type LoftMesh = { positions: Float64Array; triangles: Uint32Array }
let layerCount = 0
function boxOfMesh(p: Float64Array): {
  min: [number, number, number]
  max: [number, number, number]
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, p[i]!)
    max[i % 3] = Math.max(max[i % 3]!, p[i]!)
  }
  return { min, max }
}

let wasm: Wasm
let kernel: SolidKernel
let port: Region2dPort
beforeAll(async () => {
  wasm = await loadWasm()
  kernel = (await loadManifold(nodeManifoldSource())).unwrap()
  port = nodeRegion2d()
})

const spec = (width: number, tool: VTool, face = 0): ChamferSpec => ({
  width,
  tool,
  face,
  overshoot: 1,
  run: 0.04,
  tolerance: 0.01,
})
const V90: VTool = { angle: 90, tip: 0 }

// ── edge operations (the existing evaluation) ─────────────────────────────────────────────────

const pocketOp = (region: Region, depth: number): OperationGeometry => ({
  kind: 'pocket',
  id: 'pocket1',
  onZ: 0,
  shape: { center: [0, 0], contour: { kind: 'region', region: numberRegion(region) } },
  depth,
  floorRadius: 0,
})
const profileOp = (
  region: Region,
  side: 'outside' | 'inside',
  slotWidth = 8,
): OperationGeometry => ({
  kind: 'profile',
  id: 'profile1',
  shape: { center: [0, 0], contour: { kind: 'region', region: numberRegion(region) } },
  side,
  slotWidth,
  tabs: { count: 0, width: 8, thickness: 3 },
})
const regionOf = (outer: Loop, holes: Loop[] = []): Region => ({ pieces: [{ outer, holes }] })

interface Case {
  readonly name: string
  readonly stock: StockGeometry
  readonly op: OperationGeometry
  /** The chamfered loops' material side: `air` region (pocket / holes) or `material` region. */
  readonly air?: Region
  readonly material?: Region
  readonly spec: ChamferSpec
  /** Analytic removed volume, when there is one. */
  readonly analytic?: number
}

interface Result {
  name: string
  elements: number
  pathElements: number
  stats: SweepStats
  /** ms: path offset, chamfer mesh → app solid, evaluation without, with the chamfer. */
  path: number
  toSolid: number
  evalWithout: number
  evalWith: number
  removed: number
  oracle: number
  analytic?: number
  /** Chord-tolerance band: edge length × chamfer depth × chord tolerance (mm³). */
  band: number
  layers: number
  mode: string
  pieces: number
  piecesWithout: number
  triangles: number
  status: string
}

/**
 * Evaluates the case's part with the app's `evaluatePart`, then again with the chamfer solid
 * subtracted (SolidPort wrapper), and returns the volumes and timings.
 */
function run(c: Case): Result {
  const s = c.spec
  const g = geometryTool(s)
  const t0 = performance.now()
  const path = chamferPath(port, c.material, c.air, g.e)
  const t1 = performance.now()
  const { solid, meshes, stats } = sweep(wasm, path, s)
  solid.delete()
  // fast path: one offset-loft per side (spikes/chamfers/loft.ts)
  let lofts: { grow: LoftMesh; shrink?: LoftMesh } | undefined
  let loftMs = 0
  if (MODE === 'loft') {
    const tl = performance.now()
    const pathRegion =
      c.air !== undefined
        ? port.offset(c.air, g.e).unwrap()
        : port.offset(c.material!, -g.e).unwrap()
    const tan = tanHalf(s.tool)
    const rhoB = Math.max(g.r0, s.run / 2)
    const zB = g.tipZ + (rhoB - g.r0) / tan
    const rhoF = g.r0 + (s.face - g.tipZ) * tan
    const n = Math.max(1, Math.ceil((rhoF - rhoB) / 0.5))
    const levels = Array.from({ length: n + 1 }, (_, k) => ({
      z: zB + ((s.face - zB) * k) / n,
      rho: rhoB + ((rhoF - rhoB) * k) / n,
    }))
    const grow = offsetLoft(wasm, port, pathRegion, -1, levels, g.topZ, s.tolerance)
    const shrink =
      c.material !== undefined
        ? offsetLoft(wasm, port, pathRegion, 1, levels, g.topZ, s.tolerance)
        : undefined
    if (grow !== undefined && (c.material === undefined || shrink !== undefined))
      lofts = { grow, ...(shrink === undefined ? {} : { shrink }) }
    loftMs = performance.now() - tl
  }
  const usedLoft = lofts !== undefined
  const input = { stock: c.stock, operations: [c.op] }
  const tWithout = performance.now()
  const without = kernel
    .withSolids((solids) => evaluatePart(input, solids, undefined, port))
    .unwrap()
  const evalWithout = performance.now() - tWithout
  const top = stockSolids(c.stock).unwrap().surfaces.indexOf('top')
  let toSolid = 0
  const tWith = performance.now()
  const withChamfer = kernel
    .withSolids((solids) => {
      let stockId: number | undefined
      const stockSolids = new Set<Solid>()
      let chamfer: Solid | undefined
      let done = false
      const wrapped: SolidPort = {
        ...solids,
        reserveOriginalId: () =>
          solids.reserveOriginalId().map((id) => {
            stockId ??= id
            return id
          }),
        fromMesh: (m, id) =>
          solids.fromMesh(m, id).map((sol) => {
            if (id === stockId) stockSolids.add(sol)
            return sol
          }),
        decompose: (x) =>
          solids.decompose(x).map((ps) => {
            for (const q of ps) {
              const v = solids.volume(q).unwrap()
              if (v > 1) continue
              const m = solids.toMesh(q).unwrap()
              const lo = [Infinity, Infinity, Infinity]
              const hi = [-Infinity, -Infinity, -Infinity]
              for (let i = 0; i < m.positions.length; i++) {
                lo[i % 3] = Math.min(lo[i % 3]!, m.positions[i]!)
                hi[i % 3] = Math.max(hi[i % 3]!, m.positions[i]!)
              }
              const labels = new Map<string, number>()
              for (let t = 0; t < m.triangleFace.length; t++) {
                const k = `${m.triangleOriginal[t]}:${m.triangleFace[t]}`
                labels.set(k, (labels.get(k) ?? 0) + 1)
              }
              if (process.env['S7_DEBUG'])
                console.log('labels', stockId, JSON.stringify([...labels]))
              if (process.env['S7_DEBUG'])
                console.log(
                  'small piece',
                  v.toFixed(3),
                  lo.map((u) => u.toFixed(2)).join(','),
                  hi.map((u) => u.toFixed(2)).join(','),
                )
            }
            return ps
          }),
        subtract: (a, b) => {
          if (!done && stockSolids.has(a)) {
            done = true
            const ts = performance.now()
            // each piece into the kernel, the union inside it (float64): a float32 round trip of
            // the union mesh is not a valid solid (near-coincident faces of nested pieces)
            const label = process.env['S7_DEBUG'] ? top + 1 : top
            if (lofts !== undefined) {
              const solidOf = (m: LoftMesh) =>
                solids
                  .fromMesh(
                    {
                      positions: m.positions,
                      triangles: m.triangles,
                      faces: new Uint32Array(m.triangles.length / 3).fill(label),
                    },
                    stockId!,
                  )
                  .unwrap()
              const grow = solidOf(lofts.grow)
              chamfer = (
                lofts.shrink === undefined ? Ok(grow) : solids.subtract(grow, solidOf(lofts.shrink))
              )
                .andThen((u) => solids.status(u).map(() => u))
                .unwrap()
              toSolid = performance.now() - ts
              return solids.subtract(a, chamfer).andThen((a2) => solids.subtract(a2, b))
            }
            const ps = meshes.map((m) =>
              solids
                .fromMesh(
                  { ...m, faces: new Uint32Array(m.triangles.length / 3).fill(label) },
                  stockId!,
                )
                .unwrap(),
            )
            if (MODE === 'layers') {
              // pairwise-disjoint layers (bounds), each a compose, subtracted one by one
              const tools = ps.map((solid, k) => ({ solid, box: boxOfMesh(meshes[k]!.positions) }))
              let part = a
              const layers = subtractionLayers(tools, 100_000)
              layerCount = layers.length
              for (const layer of layers) {
                const u =
                  layer.length === 1
                    ? layer[0]!.solid
                    : solids.union(layer.map((t) => t.solid)).unwrap()
                part = solids
                  .subtract(part, u)
                  .andThen((x) => solids.status(x).map(() => x))
                  .unwrap()
              }
              toSolid = performance.now() - ts
              return solids.subtract(part, b)
            }
            chamfer = solids
              .union(ps)
              .andThen((u) => solids.status(u).map(() => u))
              .unwrap()
            toSolid = performance.now() - ts
            return solids.subtract(a, chamfer).andThen((a2) => solids.subtract(a2, b))
          }
          return solids.subtract(a, b)
        },
      }
      return evaluatePart(input, wrapped, undefined, port).map((ev) => {
        expect(done).toBe(true)
        return ev
      })
    })
    .unwrap()
  const evalWith = performance.now() - tWith
  if (withChamfer.pieces !== without.pieces)
    console.log(c.name, JSON.stringify(withChamfer.warnings))
  return {
    name: c.name,
    elements: [c.air, c.material]
      .filter((r) => r !== undefined)
      .flatMap((r) => regionLoops(r!))
      .reduce((n, l) => n + l.elements.length, 0),
    pathElements: path.reduce((n, l) => n + l.elements.length, 0),
    stats,
    path: t1 - t0,
    toSolid,
    evalWithout,
    evalWith,
    removed: without.volume - withChamfer.volume,
    oracle: removedVolume(port, c.material, c.air, s),
    ...(c.analytic === undefined ? {} : { analytic: c.analytic }),
    band:
      [c.air, c.material]
        .filter((x) => x !== undefined)
        .flatMap((x) => regionLoops(x!))
        .reduce((n, l) => n + port.length(l), 0) *
      depthOf(s) *
      s.tolerance,
    layers: MODE === 'layers' ? layerCount : 1,
    mode:
      MODE === 'loft'
        ? usedLoft
          ? `loft ${fmt(loftMs)} ms, ${lofts!.grow.triangles.length / 3 + (lofts!.shrink?.triangles.length ?? 0) / 3} tris`
          : `fallback: sweep union (${loftFailure})`
        : MODE,
    pieces: withChamfer.pieces,
    piecesWithout: without.pieces,
    triangles: withChamfer.stats.triangles,
    status: 'ok',
  }
}

const rows: Result[] = []
const path = (air: Region, e: number) => regionLoops(port.offset(air, e).unwrap()).length
const fmt = (v: number, d = 1) => v.toFixed(d)
function table(): string {
  const head =
    '| Case | Edge elements | Path elements | Sweep pieces | Build | Union | Sweep tris | Path | Chamfer → app solid | Eval without | Eval with | Removed mm³ | Oracle mm³ | Δ oracle | Δ / band | Analytic | Δ analytic | Pieces | Layers | Mode |'
  const sep = '|' + ' --- |'.repeat(20)
  const lines = rows.map((r) =>
    [
      r.name,
      r.elements,
      r.pathElements,
      r.stats.pieces,
      fmt(r.stats.build),
      fmt(r.stats.union),
      r.stats.triangles,
      fmt(r.path),
      fmt(r.toSolid),
      fmt(r.evalWithout),
      fmt(r.evalWith),
      fmt(r.removed, 3),
      fmt(r.oracle, 3),
      ((100 * (r.removed - r.oracle)) / r.oracle).toFixed(3) + ' %',
      ((r.removed - r.oracle) / r.band).toFixed(2),
      r.analytic === undefined ? '–' : fmt(r.analytic, 3),
      r.analytic === undefined
        ? '–'
        : ((100 * (r.removed - r.analytic)) / r.analytic).toFixed(3) + ' %',
      `${r.piecesWithout} → ${r.pieces}`,
      r.layers,
      r.mode,
    ].join(' | '),
  )
  return ['', head, sep, ...lines.map((l) => `| ${l} |`)].join('\n')
}

// ── loops ──────────────────────────────────────────────────────────────────────────────────────

const STOCK: StockGeometry = { length: 200, width: 120, thickness: 20 }

function enclosure(): { outline: Loop; cavity: Loop; size: { length: number; width: number } } {
  const proc = (
    globalThis as unknown as {
      process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: URL, e: 'utf8'): string } }
    }
  ).process
  const svg = proc.getBuiltinModule('node:fs').readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8')
  const shapes = importSvg(svg).unwrap().shapes
  const loopOf = (name: string): Loop => {
    const item = shapes.find((x) => x.name === name)!.items[0]!
    if (item.kind !== 'loop') throw new Error('expected a loop')
    return item.loop
  }
  const placed = placeLoops([loopOf('outline'), loopOf('cavity')], 12)
  return { outline: placed.loops[0]!, cavity: placed.loops[1]!, size: placed.size }
}

/** A comb pocket: a rectangle with `k` teeth of material `tooth` wide reaching in from y0. */
function combLoop(
  x0: number,
  y0: number,
  k: number,
  tooth: number,
  gap: number,
  len: number,
  height: number,
): Loop {
  // walk counter-clockwise: bottom edge with teeth (material fingers pointing up into the pocket)
  const pts: [number, number][] = [[x0, y0]]
  let x = x0 + gap
  for (let i = 0; i < k; i++) {
    pts.push([x, y0], [x, y0 + len], [x + tooth, y0 + len], [x + tooth, y0])
    x += tooth + gap
  }
  pts.push([x, y0], [x, y0 + height], [x0, y0 + height])
  const els = pts.map((p, i) => ({ kind: 'line' as const, a: p, b: pts[(i + 1) % pts.length]! }))
  return { elements: els }
}

const ccw = (l: Loop): Loop => l
const cw = (l: Loop): Loop => reverseLoop(l)

describe('spike S7: edge chamfers along general loops', () => {
  it('rectangle outside (convex corners, mitred): analytic h·((a+b)w − 4w²/3)', () => {
    const a = 100
    const b = 60
    const w = 1.5
    const s = spec(w, V90)
    const h = depthOf(s)
    const shape = regionOf(ccw(roundedRectLoop(50, 30, 150, 90, 0)))
    const r = run({
      name: 'rect 100×60 outside, w 1.5, 90°',
      stock: STOCK,
      op: profileOp(shape, 'outside'),
      material: shape,
      spec: s,
      analytic: h * ((a + b) * w - (4 / 3) * w * w),
    })
    rows.push(r)
    expect.soft(Math.abs(r.removed - r.analytic!)).toBeLessThan(r.band)
  })

  it('rectangle outside, 60° bit with 0.2 mm tip', () => {
    const a = 100
    const b = 60
    const w = 1
    const s = spec(w, { angle: 60, tip: 0.2 })
    const h = depthOf(s)
    const shape = regionOf(ccw(roundedRectLoop(50, 30, 150, 90, 0)))
    const r = run({
      name: 'rect outside, w 1, 60° tip 0.2',
      stock: STOCK,
      op: profileOp(shape, 'outside'),
      material: shape,
      spec: s,
      analytic: h * ((a + b) * w - (4 / 3) * w * w),
    })
    rows.push(r)
    expect.soft(Math.abs(r.removed - r.analytic!)).toBeLessThan(r.band)
  })

  it('rounded-rectangle pocket (inside, corners R3): analytic h·(P·w/2 + πw²/3)', () => {
    const a = 80
    const b = 50
    const rc = 3
    const w = 1
    const s = spec(w, V90)
    const h = depthOf(s)
    const P = 2 * (a + b) - 8 * rc + 2 * Math.PI * rc
    const air = regionOf(ccw(roundedRectLoop(60, 35, 140, 85, rc)))
    const r = run({
      name: 'pocket 80×50 R3, w 1, 90°',
      stock: STOCK,
      op: pocketOp(air, 10),
      air,
      spec: s,
      analytic: h * ((P * w) / 2 + (Math.PI * w * w) / 3),
    })
    rows.push(r)
    expect.soft(Math.abs(r.removed - r.analytic!)).toBeLessThan(r.band)
  })

  it('circle pocket (hole mouth) and circle outside: h·(πRw ± πw²/3)', () => {
    const w = 1
    const s = spec(w, V90)
    const h = depthOf(s)
    const air = regionOf(circleLoop([100, 60], 10))
    const r1 = run({
      name: 'circle pocket R10, w 1',
      stock: STOCK,
      op: pocketOp(air, 10),
      air,
      spec: s,
      analytic: h * (Math.PI * 10 * w + (Math.PI * w * w) / 3),
    })
    const mat = regionOf(circleLoop([100, 60], 30))
    const r2 = run({
      name: 'circle outside R30, w 1',
      stock: STOCK,
      op: profileOp(mat, 'outside'),
      material: mat,
      spec: s,
      analytic: h * (Math.PI * 30 * w - (Math.PI * w * w) / 3),
    })
    rows.push(r1, r2)
    for (const r of [r1, r2]) expect.soft(Math.abs(r.removed - r.analytic!)).toBeLessThan(r.band)
  })

  it('sharp-cornered pocket: what the V-bit leaves in inside corners (vs the mitred ideal)', () => {
    const a = 80
    const b = 50
    const w = 2
    for (const tip of [0, 0.5]) {
      const s = spec(w, { angle: 90, tip })
      const h = depthOf(s)
      const air = regionOf(ccw(roundedRectLoop(60, 35, 140, 85, 0)))
      const r = run({
        name: `pocket 80×50 sharp, w 2, tip ${tip} (analytic = mitred ideal)`,
        stock: STOCK,
        op: pocketOp(air, 10),
        air,
        spec: s,
        analytic: h * ((a + b) * w + (4 / 3) * w * w),
      })
      rows.push(r)
      // the V-bit leaves a cone in each sharp inside corner: (4 − π)/12 · h · w² per corner at tip 0
      if (tip === 0)
        expect.soft(r.analytic! - r.oracle).toBeCloseTo((4 * (4 - Math.PI) * h * w * w) / 12, 3)
      expect.soft(Math.abs(r.removed - r.oracle)).toBeLessThan(r.band)
    }
  })

  it('star pocket with islands (lines + concave arcs, many elements)', () => {
    for (const k of [24, 100, 250, 500]) {
      const c: [number, number] = [100, 60]
      const air = regionOf(ccw(scallopLoop(c, 50, k)), [
        cw(circleLoop([c[0] - 50 / 3, c[1]], 50 / 8)),
        cw(circleLoop([c[0] + 50 / 3, c[1]], 50 / 8)),
      ])
      const s = spec(1, V90)
      const r = run({
        name: `star pocket k=${k} + 2 islands, w 1`,
        stock: STOCK,
        op: pocketOp(air, 8),
        air,
        spec: s,
      })
      rows.push(r)
      expect.soft(r.pieces).toBe(1)
      expect.soft(Math.abs(r.removed - r.oracle)).toBeLessThan(r.band)
    }
  })

  it('many segments without a topology change: faceted circle, islands grid', () => {
    for (const n of [250, 1000]) {
      const pts = Array.from({ length: n }, (_, k): [number, number] => [
        100 + 40 * Math.cos((2 * Math.PI * k) / n),
        60 + 40 * Math.sin((2 * Math.PI * k) / n),
      ])
      const loop: Loop = {
        elements: pts.map((a, k) => ({ kind: 'line' as const, a, b: pts[(k + 1) % n]! })),
      }
      const air = regionOf(loop)
      const r = run({
        name: `faceted circle pocket, ${n} lines, w 1`,
        stock: STOCK,
        op: pocketOp(air, 8),
        air,
        spec: spec(1, V90),
      })
      rows.push(r)
      expect.soft(Math.abs(r.removed - r.oracle)).toBeLessThan(r.band)
    }
    for (const n of [100, 500]) {
      const air = islandsRegion(n)
      const r = run({
        name: `islands pocket, ${n} elements, w 0.5`,
        stock: STOCK,
        op: pocketOp(air, 8),
        air,
        spec: spec(0.5, V90),
      })
      rows.push(r)
      expect.soft(Math.abs(r.removed - r.oracle)).toBeLessThan(r.band)
    }
  })

  it('comb pocket: material teeth narrower than 2w (chamfers meet, the tooth tops vanish)', () => {
    for (const tooth of [6, 2, 1]) {
      const air = regionOf(ccw(combLoop(40, 30, 8, tooth, 6, 30, 60)))
      const s = spec(1.5, V90)
      const r = run({
        name: `comb pocket, teeth ${tooth} mm, w 1.5`,
        stock: STOCK,
        op: pocketOp(air, 8),
        air,
        spec: s,
      })
      rows.push(r)
      expect.soft(Math.abs(r.removed - r.oracle)).toBeLessThan(r.band)
    }
  })

  it('narrow pocket neck (air narrower than the tip: the path splits)', () => {
    // dumbbell of two R15 discs joined by a 0.4 mm neck; tip 0.6 cannot enter the neck
    const neck = 0.2
    const R = 15
    const x = Math.sqrt(R * R - neck * neck)
    const e = {
      kind: 'line' as const,
    }
    void e
    const a: [number, number] = [70 + x, 60 - neck]
    const b: [number, number] = [120 - x, 60 - neck]
    const c2: [number, number] = [120 - x, 60 + neck]
    const d: [number, number] = [70 + x, 60 + neck]
    const loop: Loop = {
      elements: [
        { kind: 'line', a, b },
        { kind: 'arc', a: b, b: c2, centre: [120, 60], ccw: true },
        { kind: 'line', a: c2, b: d },
        { kind: 'arc', a: d, b: a, centre: [70, 60], ccw: true },
      ],
    }
    const air = regionOf(loop)
    const s = spec(1, { angle: 90, tip: 0.6 })
    const r = run({
      name: 'dumbbell pocket, neck 0.4, tip 0.6, w 1',
      stock: STOCK,
      op: pocketOp(air, 8),
      air,
      spec: s,
    })
    rows.push(r)
    // what the tip leaves in the neck: the ideal (pointed) chamfer minus the machined one
    const ideal = removedVolume(port, undefined, air, spec(1, V90))
    console.log(
      `dumbbell: ideal ${ideal.toFixed(3)} mm³, machined (tip 0.6) ${r.oracle.toFixed(3)} mm³, path loops ${path(air, 0.3)}`,
    )
    expect(r.pathElements).toBeGreaterThan(0)
    expect.soft(Math.abs(r.removed - r.oracle)).toBeLessThan(r.band)
  })

  it('enclosure outline (outside) and cavity (pocket)', () => {
    const { outline, cavity, size } = enclosure()
    const stock: StockGeometry = { length: size.length, width: size.width, thickness: 40 }
    const mat = regionOf(outline)
    const s = spec(1.5, V90)
    const r1 = run({
      name: 'enclosure outline outside, w 1.5',
      stock,
      op: profileOp(mat, 'outside', 8),
      material: mat,
      spec: s,
    })
    const air = regionOf(cavity)
    const r2 = run({
      name: 'enclosure cavity pocket, w 1',
      stock,
      op: pocketOp(air, 20),
      air,
      spec: spec(1, V90),
    })
    rows.push(r1, r2)
    for (const r of [r1, r2]) expect.soft(Math.abs(r.removed - r.oracle)).toBeLessThan(r.band)
  })

  it('prints the table', () => {
    console.log(table())
    void regionArea
    void Ok
  })
})
