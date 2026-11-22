// Solids of shape operations (v0.3 G1): labelled region prisms with islands, profile slots
// `outside` / `inside` / `on` (closed, open, blind), tabs on general loops (the toolpath's bands),
// part-frame placement (the two-direction wall slivers, G2), and the exit part's shapes from
// enclosure-sections.svg. Doc: docs/architecture/shapes.md#implementation-g1
import { beforeAll, describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { ENCLOSURE_SECTIONS_SVG } from '../design/enclosure-sections.testing'
import { importSvg } from '../import/svg/import'
import { evaluatePart, type PartEvaluation } from './evaluate'
import type { Direction } from './face'
import { loadManifold } from './manifold'
import {
  CHORD_TOLERANCE,
  type OperationGeometry,
  type PartGeometryInput,
  type StockGeometry,
} from './model'
import { chainLength, elementClosest } from './2d/measure'
import { line, regionArea, regionLoops, type Loop, type Region, type Element } from './2d/model'
import { numberRegion, translateRegion } from './2d/place'
import { nodeRegion2d } from './2d/testing/node-wasm'
import { flattenRegion, chordCount } from './prism'
import { shapeChords } from './shape-solids'
import type { SolidKernel } from './solid-port'
import { generalTabBands } from './tab-bands'
import { signedVolume } from './testing/mesh-oracles'
import {
  circleLoop,
  islandsRegion,
  meetPockets,
  randomMeet,
  regionPocket,
  roundedRectLoop,
  scallopLoop,
  starRegion,
  trianglesInPlane,
} from './testing/shape-regions'
import { tabCentres } from './outline'

let kernel: SolidKernel
const region2d = nodeRegion2d()

beforeAll(async () => {
  kernel = expectOk(await loadManifold())
})

const STOCK: StockGeometry = { length: 200, width: 120, thickness: 30 }

const input = (operations: OperationGeometry[], stock = STOCK): PartGeometryInput => ({
  stock,
  operations,
})

const evaluate = (i: PartGeometryInput): PartEvaluation =>
  expectOk(kernel.withSolids((s) => evaluatePart(i, s, undefined, region2d)))

const stockVolume = (s: StockGeometry) => s.length * s.width * s.thickness

/** The mesh is closed and its signed volume is Manifold's volume. */
function expectWatertight(e: PartEvaluation): void {
  const v = signedVolume({ positions: Float64Array.from(e.positions), triangles: e.indices })
  expect(v).toBeCloseTo(e.volume, 0)
  expect(kernel.liveObjects()).toBe(0)
}

/** Centroids (part frame) of the triangles labelled `id`. */
function centroids(e: PartEvaluation, id: string): [number, number, number][] {
  const s = e.surfaces.indexOf(id)
  const out: [number, number, number][] = []
  for (let t = 0; t < e.triangleSurface.length; t++) {
    if (e.triangleSurface[t] !== s) continue
    const c: [number, number, number] = [0, 0, 0]
    for (let k = 0; k < 3; k++) {
      const v = e.indices[3 * t + k]!
      for (let a = 0; a < 3; a++) c[a]! += e.positions[3 * v + a]! / 3
    }
    out.push(c)
  }
  return out
}

/** Every `wall[i]` / `corner[i]` triangle of `op` lies on element i (top face: x, y = u, v). */
function expectWallsOnElements(e: PartEvaluation, op: string, loops: readonly Loop[]): void {
  const els = loops.flatMap((l) => l.elements)
  let checked = 0
  for (const id of e.surfaces.filter(
    (s) => s.startsWith(`${op}.wall[`) || s.startsWith(`${op}.corner[`),
  )) {
    const i = Number(/\[(\d+)\]/.exec(id)![1])
    const el = els[i]!
    expect(id.includes('wall') ? 'line' : 'arc', id).toBe(el.kind)
    for (const c of centroids(e, id)) {
      const q = elementClosest(el, [c[0], c[1]])
      expect(Math.hypot(q[0] - c[0], q[1] - c[1]), id).toBeLessThanOrEqual(CHORD_TOLERANCE + 1e-4)
      checked++
    }
  }
  expect(checked).toBeGreaterThan(0)
}

const regionOf = (outer: Loop, holes: Loop[] = []): Region =>
  numberRegion({ pieces: [{ outer, holes }] })

function profile(
  id: string,
  loop: Loop | { path: Loop },
  side: 'outside' | 'inside' | 'on',
  extra: Partial<Extract<OperationGeometry, { kind: 'profile' }>> = {},
): OperationGeometry {
  const contour =
    'path' in loop
      ? ({ kind: 'path', path: loop.path } as const)
      : ({ kind: 'region', region: regionOf(loop) } as const)
  return {
    kind: 'profile',
    id,
    shape: { center: [0, 0], contour },
    side,
    slotWidth: 6,
    tabs: { count: 0, width: 8, thickness: 3 },
    ...extra,
  }
}

describe('pockets of general regions', () => {
  it.each([
    ['star 50', starRegion(50)],
    ['star 500', starRegion(500)],
    ['islands 100', islandsRegion(100)],
  ])('%s: islands at full height, every element labelled, volume = area × depth', (_, region) => {
    const depth = 7.3
    const e = evaluate(input([regionPocket('pocket1', region, depth)]))
    expect(e.pieces).toBe(1)
    expect(e.surfaces).toContain('pocket1.floor')
    expect(e.surfaces).toContain('stock.top')
    expectWatertight(e)
    // every element survives as its own surface
    const n = regionLoops(region).reduce((k, l) => k + l.elements.length, 0)
    const walls = e.surfaces.filter((s) => /^pocket1\.(wall|corner)\[/.test(s))
    expect(walls).toHaveLength(n)
    expectWallsOnElements(e, 'pocket1', regionLoops(region))
    const removed = stockVolume(STOCK) - e.volume
    const exact = regionArea(region) * depth
    // inscribed outer arcs, circumscribed island arcs: never more removed than the exact area
    expect(removed).toBeLessThanOrEqual(exact + 1e-3)
    expect(removed).toBeGreaterThan(exact * 0.999)
    for (const c of centroids(e, 'pocket1.floor')) expect(c[2]).toBeCloseTo(-depth, 4)
  })

  it.each<Direction>(['-z', '+x', '-y'])('builds on the %s face, labels intact', (d) => {
    const stock = { length: 120, width: 120, thickness: 120 }
    const region = starRegion(60, [60, 60], 40)
    const e = evaluate(input([regionPocket('pocket1', region, 5, d)], stock))
    expect(e.pieces).toBe(1)
    expect(e.surfaces).toContain('pocket1.floor')
    expect(e.surfaces.filter((s) => s.startsWith('pocket1.corner['))).not.toHaveLength(0)
    expectWatertight(e)
    expect(stockVolume(stock) - e.volume).toBeCloseTo(regionArea(region) * 5, -1)
  })

  it('a rotated rectangle (general) removes what the analytic one does when not rotated', () => {
    const r = roundedRectLoop(40, 30, 120, 80, 6)
    const general = evaluate(input([regionPocket('pocket1', regionOf(r), 4)]))
    const analytic = evaluate(
      input([
        {
          kind: 'pocket',
          id: 'pocket1',
          onZ: 0,
          shape: {
            center: [80, 55],
            contour: { kind: 'rectangle', length: 80, width: 50, cornerRadius: 6 },
          },
          depth: 4,
          floorRadius: 0,
        },
      ]),
    )
    expect(general.volume).toBeCloseTo(analytic.volume, 2)
  })

  it('needs the 2D port (a host bug without)', () => {
    const i = input([regionPocket('pocket1', starRegion(20), 2)])
    expectErrCode(
      kernel.withSolids((s) => evaluatePart(i, s)),
      'internal.unexpected',
    )
  })
})

describe('profile slots on general loops', () => {
  const star = scallopLoop([100, 60], 40, 12)

  it('outside: the slot is the loop grown by the slot width; walls by element, offcut outside', () => {
    const loop = regionOf(star).pieces[0]!.outer
    const e = evaluate(
      input([profile('profile1', star, 'outside', { tabs: { count: 3, width: 8, thickness: 3 } })]),
    )
    expectWatertight(e)
    expect(e.pieces).toBe(1)
    expect(e.warnings).toEqual([])
    expect(e.surfaces).toContain('profile1.offcut')
    expectWallsOnElements(e, 'profile1', [loop])
    for (let i = 0; i < 3; i++) {
      expect(e.surfaces).toContain(`profile1.tab[${i}].top`)
      expect(e.surfaces).toContain(`profile1.tab[${i}].end[0]`)
      expect(e.surfaces).toContain(`profile1.tab[${i}].end[1]`)
      for (const c of centroids(e, `profile1.tab[${i}].top`)) expect(c[2]).toBeCloseTo(-27, 4)
    }
    // part = stock − slot + tabs (the toolpath's bands across the slot)
    const shape = { pieces: [{ outer: loop, holes: [] }] }
    const slot = regionArea(expectOk(region2d.offset(shape, -6))) - regionArea(shape)
    const L = chainLength(loop)
    const tabs = generalTabBands(loop, tabCentres(L, { count: 3 }), 8, -6, 0)
      .map((b) => regionArea(expectOk(region2d.normalise(b.map((p) => p.loop)))))
      .reduce((a, b) => a + b, 0)
    const exact = stockVolume(STOCK) - slot * 30 + tabs * 3
    expect(Math.abs(e.volume - exact) / exact).toBeLessThan(2e-4)
  })

  it('without tabs the part comes loose from its frame', () => {
    const e = evaluate(input([profile('profile1', star, 'outside')]))
    expect(e.pieces).toBe(2)
    expect(e.warnings.map((w) => [w.code, w.params['offcut']])).toEqual([['dfm.loosePiece', true]])
  })

  it('inside: an opening, the slug held by tabs; a slot covering a small opening leaves no cut', () => {
    const e = evaluate(
      input([profile('profile1', star, 'inside', { tabs: { count: 2, width: 6, thickness: 2 } })]),
    )
    expectWatertight(e)
    expect(e.pieces).toBe(1)
    expect(e.surfaces).toContain('profile1.tab[1].top')
    const small = circleLoop([30, 30], 2.5)
    const c = evaluate(
      input([profile('profile1', small, 'inside', { tabs: { count: 2, width: 2, thickness: 2 } })]),
    )
    expect(c.pieces).toBe(1)
    expect(c.surfaces.filter((s) => s.includes('tab'))).toEqual([])
    expect(stockVolume(STOCK) - c.volume).toBeCloseTo(Math.PI * 2.5 * 2.5 * 30, -1)
  })

  it('on, closed and through: the band both sides of the loop, tabs hold the inside', () => {
    const loop = roundedRectLoop(40, 30, 160, 90, 10)
    const e = evaluate(
      input([profile('profile1', loop, 'on', { tabs: { count: 4, width: 8, thickness: 3 } })]),
    )
    expectWatertight(e)
    expect(e.pieces).toBe(1)
    expect(e.surfaces).toContain('profile1.tab[3].end[1]')
    expect(e.surfaces).not.toContain('profile1.offcut')
    // the groove's walls: lines and arcs of the centre loop
    expect(e.surfaces).toContain('profile1.wall[0]')
    expect(e.surfaces).toContain('profile1.corner[1]')
    const shape = regionOf(loop)
    const band =
      regionArea(expectOk(region2d.offset(shape, -3))) -
      regionArea(expectOk(region2d.offset(shape, 3)))
    const tabs = 4 * 8 * 6 // tabs on straight walls: width × slot
    expect(Math.abs(stockVolume(STOCK) - e.volume - (band * 30 - tabs * 3))).toBeLessThan(30)
  })

  it('on, open path: through (round ends) and blind with a floor', () => {
    const path: Loop = {
      elements: [line([30, 30], [100, 30]), line([100, 30], [100, 80])],
    }
    const area = regionArea(expectOk(region2d.offsetPath(path, 3)))
    const through = evaluate(
      input([profile('profile1', { path }, 'on', { tabs: { count: 4, width: 8, thickness: 3 } })]),
    )
    expectWatertight(through)
    expect(through.surfaces.filter((s) => s.includes('tab'))).toEqual([])
    expect(stockVolume(STOCK) - through.volume).toBeCloseTo(area * 30, -1)
    const blind = evaluate(input([profile('profile1', { path }, 'on', { depth: 4.2 })]))
    expectWatertight(blind)
    expect(blind.surfaces).toContain('profile1.floor')
    for (const c of centroids(blind, 'profile1.floor')) expect(c[2]).toBeCloseTo(-4.2, 4)
    expect(stockVolume(STOCK) - blind.volume).toBeCloseTo(area * 4.2, -1)
    expect(blind.surfaces).toContain('profile1.wall[0]')
    expect(blind.surfaces).toContain('profile1.wall[1]')
  })

  it('tabs on arcs: end faces on the loop normals (radial), top at the tab thickness', () => {
    const c: [number, number] = [100, 60]
    const loop = circleLoop(c, 30)
    const L = 2 * Math.PI * 30
    const positions = [L / 8, L / 2]
    const e = evaluate(
      input([
        profile('profile1', loop, 'outside', {
          tabs: { count: 0, width: 10, thickness: 4, positions },
        }),
      ]),
    )
    expectWatertight(e)
    expect(e.pieces).toBe(1)
    for (const i of [0, 1]) {
      for (const k of [0, 1]) {
        const id = `profile1.tab[${i}].end[${k}]`
        const pts = centroids(e, id)
        expect(pts.length, id).toBeGreaterThan(0)
        // all on one radial line through the centre
        const angle = (p: number[]) => Math.atan2(p[1]! - c[1], p[0]! - c[0])
        const a0 = angle(pts[0]!)
        for (const p of pts) expect(Math.abs(angle(p) - a0), id).toBeLessThan(1e-3)
        // at the stretch end: centre ∓ width / 2 along the loop (from its start point, the bottom)
        const s = positions[i]! + (k === 0 ? -5 : 5)
        const expected = -Math.PI / 2 + s / 30
        const d = Math.atan2(Math.sin(a0 - expected), Math.cos(a0 - expected))
        expect(Math.abs(d), id).toBeLessThan(1e-3)
      }
      for (const p of centroids(e, `profile1.tab[${i}].top`)) expect(p[2]).toBeCloseTo(-26, 4)
    }
    // the tabs are annular sectors across the slot: (R² − r²)/2 · θ each
    const theta = 10 / 30
    const tabArea = ((36 * 36 - 30 * 30) / 2) * theta
    const slot = Math.PI * (36 * 36 - 30 * 30)
    const exact = stockVolume(STOCK) - slot * 30 + 2 * tabArea * 4
    expect(Math.abs(e.volume - exact) / exact).toBeLessThan(1e-4)
  })

  it('tab positions straddling the start point wrap', () => {
    const loop = roundedRectLoop(40, 30, 160, 90, 5)
    const e = evaluate(
      input([
        profile('profile1', loop, 'outside', {
          tabs: { count: 0, width: 10, thickness: 3, positions: [1, 100] },
        }),
      ]),
    )
    expectWatertight(e)
    expect(e.pieces).toBe(1)
    expect(e.surfaces).toContain('profile1.tab[0].end[0]')
    expect(e.surfaces).toContain('profile1.tab[0].end[1]')
  })
})

describe('part-frame placement (two directions meeting, G2)', () => {
  it('leaves no triangle in the plane where a top and a side pocket meet (30 seeded cases)', () => {
    let bad = 0
    for (let seed = 1; seed <= 30; seed++) {
      const m = randomMeet(seed)
      const e = evaluate(input(meetPockets(m), m.stock))
      expect(e.pieces, `seed ${seed}`).toBe(1)
      if (trianglesInPlane(e.positions, e.indices, m) > 0) bad++
    }
    expect(bad).toBe(0)
  })

  it('the same for analytic rectangle pockets (the v0.2 backlog case)', () => {
    let bad = 0
    for (let seed = 31; seed <= 50; seed++) {
      const m = randomMeet(seed)
      // the general pockets' bounding boxes as v0.1 rectangles (corner radius 0)
      const ops = meetPockets(m).map((op): OperationGeometry => {
        if (op.kind !== 'pocket' || op.shape.contour.kind !== 'region') return op
        const pts = op.shape.contour.region.pieces[0]!.outer.elements.flatMap((x: Element) => [
          x.a,
          x.b,
        ])
        const xs = pts.map((p) => p[0])
        const ys = pts.map((p) => p[1])
        const [x0, x1, y0, y1] = [
          Math.min(...xs),
          Math.max(...xs),
          Math.min(...ys),
          Math.max(...ys),
        ]
        return {
          ...op,
          shape: {
            center: [(x0 + x1) / 2, (y0 + y1) / 2],
            contour: { kind: 'rectangle', length: x1 - x0, width: y1 - y0, cornerRadius: 0 },
          },
        }
      })
      const e = evaluate(input(ops, m.stock))
      if (trianglesInPlane(e.positions, e.indices, m) > 0) bad++
    }
    expect(bad).toBe(0)
  })
})

describe('the exit part (enclosure-sections.svg)', () => {
  interface NodeProcess {
    getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, encoding: 'utf8'): string }
  }
  const fs = (globalThis as unknown as { process: NodeProcess }).process.getBuiltinModule('node:fs')
  const shapes = expectOk(importSvg(fs.readFileSync(ENCLOSURE_SECTIONS_SVG, 'utf8'))).shapes
  const stock: StockGeometry = { length: 255, width: 185, thickness: 40 }
  // the 250 × 178 page centred on the stock
  const placed = (name: string): Region => {
    const s = shapes.find((x) => x.name === name)!
    const loops = s.items.map((i) => (i.kind === 'loop' ? i.loop : i.path))
    return numberRegion(translateRegion(expectOk(region2d.normalise(loops)), [2.5, 3.5]))
  }
  const outline = placed('outline')
  const cavity = placed('cavity')

  it('facing, the cavity pocket on the facing floor and the outline profile with 4 tabs', () => {
    const ops: OperationGeometry[] = [
      { kind: 'facing', id: 'facing1', depth: 0.5 },
      regionPocket('pocket1', cavity, 34.8, undefined, -0.5),
      profile('profile1', outline.pieces[0]!.outer, 'outside', {
        tabs: { count: 4, width: 8, thickness: 3 },
      }),
    ]
    const e = evaluate(input(ops, stock))
    expectWatertight(e)
    expect(e.pieces).toBe(1)
    expect(e.warnings).toEqual([])
    for (const id of ['facing1.floor', 'pocket1.floor', 'profile1.offcut', 'stock.bottom'])
      expect(e.surfaces).toContain(id)
    for (let i = 0; i < 4; i++) expect(e.surfaces).toContain(`profile1.tab[${i}].top`)
    expectWallsOnElements(e, 'pocket1', regionLoops(cavity))
    expectWallsOnElements(e, 'profile1', regionLoops(outline))
    for (const c of centroids(e, 'pocket1.floor')) expect(c[2]).toBeCloseTo(-35.3, 4)
    // volume: stock − facing − cavity − slot (clipped to the stock) + tabs
    const stockRect: Region = {
      pieces: [{ outer: roundedRectLoop(0, 0, 255, 185, 0), holes: [] }],
    }
    const grown = expectOk(region2d.intersect(expectOk(region2d.offset(outline, -6)), stockRect))
    const slot = regionArea(grown) - regionArea(outline)
    const loop = outline.pieces[0]!.outer
    const tabs = generalTabBands(loop, tabCentres(chainLength(loop), { count: 4 }), 8, -6, 0)
      .map((b) => regionArea(expectOk(region2d.normalise(b.map((p) => p.loop)))))
      .reduce((a, b) => a + b, 0)
    const exact =
      stockVolume(stock) - 255 * 185 * 0.5 - regionArea(cavity) * 34.8 - slot * 39.5 + tabs * 3
    expect(Math.abs(e.volume - exact) / exact).toBeLessThan(5e-4)
  })

  it('counts chords for the cost note (dfm.shapeHeavy)', () => {
    const op = regionPocket('pocket1', cavity, 10)
    expect(op.kind === 'pocket' && shapeChords(op)).toBe(
      chordCount(flattenRegion(cavity, 'shrink')),
    )
    expect(op.kind === 'pocket' && shapeChords(op)).toBeLessThan(3000)
  })
})
