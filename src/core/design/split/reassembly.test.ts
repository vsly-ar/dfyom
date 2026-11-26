// The reassembly invariant of split parts 4a (docs/modes/split-parts.md#model): the pieces, each
// evaluated in its own blank and moved back by its offset, are the source inside their cells; the
// dowel holes of 4b are the joint and are not compared (docs/modes/split-parts.md#implementation-4b);
// with keys (4b-2) the source equals the pieces up to the clearance band.
// Oracle: point membership (ray parity) on the evaluated meshes at random points of each cell
// (inside the footprint, between the part's facings), source vs. piece.
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { regionContains } from '../../geometry/2d/measure'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { evaluatePart, type PartEvaluation } from '../../geometry/evaluate'
import { loadManifold } from '../../geometry/manifold'
import type { SolidKernel } from '../../geometry/solid-port'
import { nodeManifoldSource } from '../../geometry/testing/node-wasm'
import { designSetup, type DesignSetup } from '../design.fixture'
import { loadPart, partGeometryInput } from '../load'
import { toGeometryInput } from '../geometry-input'
import { regionLoops } from '../../geometry/2d/model'
import { elementPoint, lineChains } from '../../geometry/line'
import { resolveShape } from '../shape'
import { keyItem, tBoneCentres } from './keys'
import { shapeRegion } from './layout'
import { planPieces } from './pieces'
import {
  ENCLOSURE_LEVEL,
  ENCLOSURE_STOCK,
  enclosureCommands,
  PANEL_LINE,
  PANEL_STOCK,
  panelCommands,
} from './split.fixture'

const region2d = nodeRegion2d()
let kernel: SolidKernel

beforeAll(async () => {
  kernel = expectOk(await loadManifold(nodeManifoldSource()))
})

const mm = (q: { exact: { num: string; den: string } }) =>
  Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

function evaluate(s: DesignSetup, partId: string): PartEvaluation {
  const input = expectOk(partGeometryInput(s.d.doc, partId, region2d))
  return expectOk(kernel.withSolids((solids) => evaluatePart(input, solids, undefined, region2d)))
}

/** Inside the closed mesh: parity of crossings of a slightly skewed ray (Möller–Trumbore). */
function inside(e: PartEvaluation, p: readonly [number, number, number]): boolean {
  const d = [1, 0.000_123_7, 0.000_071_3] as const
  const P = e.positions
  let n = 0
  for (let t = 0; t < e.indices.length; t += 3) {
    const a = 3 * e.indices[t]!
    const b = 3 * e.indices[t + 1]!
    const c = 3 * e.indices[t + 2]!
    const e1 = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!]
    const e2 = [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!]
    const h = [
      d[1] * e2[2]! - d[2] * e2[1]!,
      d[2] * e2[0]! - d[0] * e2[2]!,
      d[0] * e2[1]! - d[1] * e2[0]!,
    ]
    const det = e1[0]! * h[0]! + e1[1]! * h[1]! + e1[2]! * h[2]!
    if (Math.abs(det) < 1e-12) continue
    const f = 1 / det
    const sv = [p[0] - P[a]!, p[1] - P[a + 1]!, p[2] - P[a + 2]!]
    const u = f * (sv[0]! * h[0]! + sv[1]! * h[1]! + sv[2]! * h[2]!)
    if (u < 0 || u > 1) continue
    const q = [
      sv[1]! * e1[2]! - sv[2]! * e1[1]!,
      sv[2]! * e1[0]! - sv[0]! * e1[2]!,
      sv[0]! * e1[1]! - sv[1]! * e1[0]!,
    ]
    const v = f * (d[0] * q[0]! + d[1] * q[1]! + d[2] * q[2]!)
    if (v < 0 || u + v > 1) continue
    if (f * (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) > 0) n++
  }
  return n % 2 === 1
}

/** A small deterministic generator (the oracle must not flake). */
function lcg(seed: number): () => number {
  let x = seed
  return () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648
    return x / 2_147_483_648
  }
}

async function enclosure(): Promise<DesignSetup> {
  const s = await designSetup({ stock: ENCLOSURE_STOCK, services: { region2d } })
  for (const [name, args] of enclosureCommands(s.partId)) await s.run(name, args)
  return s
}

/** A thicker library board of the enclosure's wood (4c): pieces sit on it with 10 mm surplus. */
const THICK = {
  ...ENCLOSURE_STOCK,
  name: 'Block 280 × 200 × 50',
  length: '280',
  width: '200',
  thickness: '50',
}

const cases: [string, object, object?][] = [
  ['one level', { levels: [ENCLOSURE_LEVEL] }],
  ['one level with dowels (4b)', { levels: [ENCLOSURE_LEVEL], dowels: {} }],
  [
    'the level and two lines',
    {
      levels: [ENCLOSURE_LEVEL],
      lines: [
        { axis: 'x', at: '125' },
        { axis: 'y', at: '100' },
      ],
    },
  ],
  // 4c: on a 50 mm library board, the surplus faced off (top facing deeper, or a glue face)
  [
    'the level on thicker library blanks (4c)',
    { levels: [ENCLOSURE_LEVEL], dowels: {}, useStocks: true },
    THICK,
  ],
]

describe('reassembly: pieces == source', () => {
  it.each(cases)(
    '%s',
    async (_, split, board) => {
      const s = await enclosure()
      if (board !== undefined) await s.run('library.stock.add', { values: board })
      await s.run('design.split.set', { partId: s.partId, split })
      const source = evaluate(s, s.partId)
      const loaded = expectOk(loadPart(s.d.doc, s.partId, 'test'))
      const planned = expectOk(planPieces(loaded, loaded.dto.split!, region2d))
      const random = lcg(7)
      let solid = 0
      let checked = 0
      for (const plan of planned.pieces) {
        const piece = Object.values(s.d.doc.parts).find((p) => p.derivedFrom?.index === plan.n)!
        const off = piece.offset!.map(mm)
        const e = evaluate(s, piece.id)
        // a pocket through the piece maps to an inside profile: its core is waste (an offcut)
        const pieceLoaded = expectOk(loadPart(s.d.doc, piece.id, 'test'))
        const geometry = expectOk(toGeometryInput(pieceLoaded.part, pieceLoaded.stock, region2d))
        const waste = geometry.operations.flatMap((g) =>
          g.kind === 'profile' && g.side === 'inside' ? [shapeRegion(g.shape)!] : [],
        )
        // dowel holes (4b) are the joint, not the source: their columns are not compared
        const blankW = pieceLoaded.stock.width.canonical
        const dowels = pieceLoaded.part.operations.flatMap((op, i) => {
          const g = geometry.operations[i]
          if (!op.id.startsWith('split1_dowel') || g?.kind !== 'drilling') return []
          const v = g.direction === '-z' ? blankW - g.center[1] : g.center[1]
          const depth = g.bottom.kind === 'through' ? 0 : g.bottom.depth
          const T = pieceLoaded.stock.thickness.canonical
          const z = g.direction === '-z' ? -T + depth / 2 : -depth / 2
          return [{ c: [g.center[0], v] as const, r: g.diameter / 2 + 0.01, z }]
        })
        // and they are cut: empty at half their depth
        for (const d of dowels) expect(inside(e, [d.c[0], d.c[1], d.z]), plan.name).toBe(false)
        const { bounds, band } = plan.cell
        // 4c: the surplus above the piece is faced off
        const T = pieceLoaded.stock.thickness.canonical
        const surplus = T - (band.zt - band.zb)
        if (board !== undefined) {
          expect(surplus, plan.name).toBeCloseTo(10, 6)
          const mid = [
            (bounds.min[0] + bounds.max[0]) / 2 + off[0]!,
            bounds.min[1] + 3 + off[1]!,
            -surplus / 2,
          ] as const
          expect(inside(e, mid), plan.name).toBe(false)
        }
        // the part between its facings: 9.738 below the top, above the bottom
        const zt = Math.min(band.zt, -9.738)
        const zb = Math.max(band.zb, -80 + 9.738)
        for (let k = 0; k < 150; k++) {
          const p: [number, number, number] = [
            bounds.min[0] + (0.002 + 0.996 * random()) * (bounds.max[0] - bounds.min[0]),
            bounds.min[1] + (0.002 + 0.996 * random()) * (bounds.max[1] - bounds.min[1]),
            zb + (0.002 + 0.996 * random()) * (zt - zb),
          ]
          if (!regionContains(plan.cell.region, [p[0], p[1]])) continue
          if (waste.some((w) => regionContains(w, [p[0] + off[0]!, p[1] + off[1]!]))) continue
          const q = [p[0] + off[0]!, p[1] + off[1]!] as const
          if (dowels.some((d) => Math.hypot(q[0] - d.c[0], q[1] - d.c[1]) <= d.r)) continue
          const want = inside(source, p)
          const got = inside(e, [p[0] + off[0]!, p[1] + off[1]!, p[2] + off[2]!])
          expect([plan.n, p, got]).toEqual([plan.n, p, want])
          checked++
          if (want) solid++
        }
      }
      // the sample hit both material and the cavity
      expect(checked).toBeGreaterThan(50 * planned.pieces.length)
      expect(solid).toBeGreaterThan(0)
      expect(solid).toBeLessThan(checked)
    },
    60_000,
  )
})

// Split parts 4b-2: with keys the pieces meet along the keyed boundary, the knob in the female's
// cell, so a point is checked against every piece of its band: in the source ⇔ in exactly one
// piece, except in the clearance band (the socket around the knob, at most the clearance wide).
describe('reassembly with keys (4b-2): pieces == source up to the clearance band', () => {
  // fingers (4d): their T-bones are relief, missing from both pieces like the clearance band
  it.each(['puzzle', 'dovetail', 'finger'] as const)(
    '%s on the 600 × 400 panel',
    async (kind) => {
      const s = await designSetup({ stock: PANEL_STOCK, services: { region2d } })
      for (const [name, args] of panelCommands(s.partId)) await s.run(name, args)
      await s.run('design.split.set', {
        partId: s.partId,
        split: { lines: [PANEL_LINE], joint: kind },
      })
      const source = evaluate(s, s.partId)
      const loaded = expectOk(loadPart(s.d.doc, s.partId, 'test'))
      const planned = expectOk(planPieces(loaded, loaded.dto.split!, region2d))
      expect(planned.keys.keys.length).toBe(kind === 'finger' ? 10 : 2)
      const pieces = planned.pieces.map((plan) => {
        const piece = Object.values(s.d.doc.parts).find((p) => p.derivedFrom?.index === plan.n)!
        // the blank outside the outline's slot stays as an offcut: only the piece is compared
        const pl = expectOk(loadPart(s.d.doc, piece.id, 'test'))
        const g = expectOk(toGeometryInput(pl.part, pl.stock, region2d)).operations
        const at = pl.part.operations.findIndex((o) => o.id === 'split1_outline')
        const og = g[at]
        const outline = og?.kind === 'profile' ? shapeRegion(og.shape) : undefined
        expect(outline).toBeDefined()
        return { plan, off: piece.offset!.map(mm), e: evaluate(s, piece.id), outline: outline! }
      })
      const knobs = planned.keys.keys.map((k) => {
        const r = expectOk(resolveShape(region2d, [keyItem(k, 'male')]))
        return r.kind === 'region' ? regionLoops(r.region) : []
      })
      const c = planned.keys.keys[0]!.clearance
      const tBones = planned.keys.keys.flatMap((k) =>
        k.size.kind !== 'finger'
          ? []
          : (['male', 'female'] as const).flatMap((side) =>
              tBoneCentres(k.size, c, side).map((q) => ({
                at: [k.at + q[1], k.u + q[0]] as const,
                r: k.size.fillet + 0.01,
              })),
            ),
      )
      const inBand = (p: readonly [number, number]) =>
        knobs.some((loops) => (region2d.distance(loops, p)?.distance ?? Infinity) <= c + 0.01) ||
        tBones.some((t) => Math.hypot(p[0] - t.at[0], p[1] - t.at[1]) <= t.r)
      const random = lcg(11)
      const points: [number, number, number][] = []
      for (let k = 0; k < 300; k++)
        points.push([5 + 600 * random(), 5 + 400 * random(), -18 * (0.01 + 0.98 * random())])
      // and dense around each key, where the pieces meet
      for (const key of planned.keys.keys)
        for (let k = 0; k < 250; k++)
          points.push([
            key.at - 5 + (key.size.depth + 10) * random(),
            key.u - key.size.half + 2 * key.size.half * random(),
            -18 * (0.01 + 0.98 * random()),
          ])
      let solid = 0
      let band = 0
      for (const p of points) {
        const want = inside(source, p)
        const hits = pieces.filter(
          ({ off, e, outline }) =>
            regionContains(outline, [p[0] + off[0]!, p[1] + off[1]!]) &&
            inside(e, [p[0] + off[0]!, p[1] + off[1]!, p[2] + off[2]!]),
        ).length
        if (want && hits === 0 && inBand([p[0], p[1]])) {
          band++
          continue
        }
        expect([p, hits]).toEqual([p, want ? 1 : 0])
        if (want) solid++
      }
      expect(solid).toBeGreaterThan(400)
      expect(band).toBeLessThan(kind === 'finger' ? 200 : 40)
    },
    60_000,
  )
})

// Split parts 4d: a half lap. The male keeps the bottom half over the lap, the female the top
// half; a point of the source is in exactly one piece, or in none only in the clearance at the
// two ends of the lap (the female's tongue end and its pocket's far wall).
describe('reassembly with a half lap (4d): pieces == source up to the clearance', () => {
  it('on the 600 × 400 panel', async () => {
    const s = await designSetup({ stock: PANEL_STOCK, services: { region2d } })
    for (const [name, args] of panelCommands(s.partId)) await s.run(name, args)
    await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: [PANEL_LINE], joint: 'halfLap' },
    })
    const source = evaluate(s, s.partId)
    const loaded = expectOk(loadPart(s.d.doc, s.partId, 'test'))
    const planned = expectOk(planPieces(loaded, loaded.dto.split!, region2d))
    expect(planned.laps).toHaveLength(1)
    const lap = planned.laps[0]!
    const pieces = planned.pieces.map((plan) => {
      const piece = Object.values(s.d.doc.parts).find((p) => p.derivedFrom?.index === plan.n)!
      const pl = expectOk(loadPart(s.d.doc, piece.id, 'test'))
      const g = expectOk(toGeometryInput(pl.part, pl.stock, region2d)).operations
      const og = g[pl.part.operations.findIndex((o) => o.id === 'split1_outline')]
      const outline = og?.kind === 'profile' ? shapeRegion(og.shape) : undefined
      expect(outline).toBeDefined()
      return { off: piece.offset!.map(mm), e: evaluate(s, piece.id), outline: outline! }
    })
    const h = lap.length / 2
    const c = lap.clearance
    const inBand = (x: number) =>
      Math.abs(x - (lap.at - h)) <= c + 0.01 || Math.abs(x - (lap.at + h)) <= c + 0.01
    const random = lcg(13)
    const points: [number, number, number][] = []
    for (let k = 0; k < 200; k++)
      points.push([5 + 600 * random(), 5 + 400 * random(), -18 * (0.01 + 0.98 * random())])
    // dense over the lap, both halves
    for (let k = 0; k < 600; k++)
      points.push([
        lap.at - h - 4 + (2 * h + 8) * random(),
        6 + 398 * random(),
        -18 * (0.01 + 0.98 * random()),
      ])
    let solid = 0
    let band = 0
    for (const p of points) {
      const want = inside(source, p)
      const hits = pieces.filter(
        ({ off, e, outline }) =>
          regionContains(outline, [p[0] + off[0]!, p[1] + off[1]!]) &&
          inside(e, [p[0] + off[0]!, p[1] + off[1]!, p[2] + off[2]!]),
      ).length
      if (want && hits === 0 && inBand(p[0])) {
        band++
        continue
      }
      expect([p, hits]).toEqual([p, want ? 1 : 0])
      if (want) solid++
    }
    expect(solid).toBeGreaterThan(600)
    expect(band).toBeLessThan(20)
  }, 60_000)
})

// Engraved patterns (engraved-patterns.md § Split pieces): a Line with a ramp (an open path and a
// loop) and an engraved pattern cross the line; each piece carries them cut at its cell grown by
// the groove's half width, so a point near the grooves at the seam is in exactly one piece.
describe('reassembly with Lines crossing the split (engraved patterns)', () => {
  it('on the 600 × 400 panel', async () => {
    const s = await designSetup({ stock: PANEL_STOCK, services: { region2d } })
    for (const [name, args] of panelCommands(s.partId)) await s.run(name, args)
    const shape = async (items: object[]) =>
      ((await s.run('design.shape.add', { partId: s.partId, items })) as { shapeId: string })
        .shapeId
    const diagonal = await shape([
      {
        kind: 'path',
        closed: false,
        start: ['-30', '-20'],
        segments: [{ kind: 'line', to: ['30', '20'] }],
      },
    ])
    const ring = await shape([{ kind: 'circle', op: 'add', center: ['0', '0'], diameter: '40' }])
    const disc = await shape([{ kind: 'circle', op: 'add', center: ['0', '0'], diameter: '60' }])
    await s.run('design.line.add', {
      partId: s.partId,
      paths: [
        { shapeId: diagonal, center: ['305', '150'] },
        { shapeId: ring, center: ['305', '300'] },
      ],
      depth: { start: '0.2', end: '1.5' },
    })
    await s.run('design.engraving.add', {
      partId: s.partId,
      motif: { preset: 'waves' },
      boundary: { shapeId: disc, center: ['305', '80'] },
    })
    const r = (await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: [PANEL_LINE] },
    })) as { findings: { params: { rule: string; operationId?: string } }[] }
    // no finding about the Lines: they are carried
    expect(r.findings.filter((f) => f.params.operationId?.includes('line'))).toEqual([])
    const source = evaluate(s, s.partId)
    const loaded = expectOk(loadPart(s.d.doc, s.partId, 'test'))
    const planned = expectOk(planPieces(loaded, loaded.dto.split!, region2d))
    expect(planned.pieces).toHaveLength(2)
    const pieces = planned.pieces.map((plan) => {
      const piece = Object.values(s.d.doc.parts).find((p) => p.derivedFrom?.index === plan.n)!
      // both Lines, cut at the cell; the engraving's owned shape stays with its Line
      for (const id of ['line1', 'engraving1_line'])
        expect(
          piece.operations.find((o) => o.id === id),
          `${plan.n} ${id}`,
        ).toMatchObject({
          kind: 'line',
          within: { min: [{}, {}], max: [{}, {}] },
        })
      expect(piece.shapes?.some((x) => x.id === 'engraving1_lines')).toBe(true)
      const pl = expectOk(loadPart(s.d.doc, piece.id, 'test'))
      const g = expectOk(toGeometryInput(pl.part, pl.stock, region2d)).operations
      const og = g[pl.part.operations.findIndex((o) => o.id === 'split1_outline')]
      const outline = og?.kind === 'profile' ? shapeRegion(og.shape) : undefined
      expect(outline).toBeDefined()
      return { off: piece.offset!.map(mm), e: evaluate(s, piece.id), outline: outline! }
    })
    // points round the source's grooves within 6 mm of the seam, beside and below them
    const sg = expectOk(toGeometryInput(loaded.part, loaded.stock, region2d)).operations
    const random = lcg(17)
    const points: [number, number, number][] = []
    for (const g of sg) {
      if (g.kind !== 'line') continue
      for (const l of lineChains(g).lines)
        for (const el of l.elements)
          for (let k = 0; k < 40; k++) {
            const u = random()
            const p = elementPoint(el, u)
            if (Math.abs(p[0] - 305) > 6) continue
            const q = elementPoint(el, Math.min(1, u + 1e-3))
            const t = [q[0] - p[0], q[1] - p[1]] as const
            const n = Math.hypot(t[0], t[1]) || 1
            const side = (random() - 0.5) * 2.4
            const x = p[0] - (t[1] / n) * side
            if (Math.abs(x - 305) < 0.02) continue
            points.push([x, p[1] + (t[0] / n) * side, -1.6 * random() - 0.005])
          }
    }
    expect(points.length).toBeGreaterThan(200)
    let empty = 0
    for (const p of points) {
      const want = inside(source, p)
      const hits = pieces.filter(
        ({ off, e, outline }) =>
          regionContains(outline, [p[0] + off[0]!, p[1] + off[1]!]) &&
          inside(e, [p[0] + off[0]!, p[1] + off[1]!, p[2] + off[2]!]),
      ).length
      expect([p, hits]).toEqual([p, want ? 1 : 0])
      if (!want) empty++
    }
    // the sample hit the grooves and the wood beside them
    expect(empty).toBeGreaterThan(50)
    expect(empty).toBeLessThan(points.length - 50)
  }, 60_000)
})
