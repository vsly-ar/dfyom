// The reassembly invariant of split parts 4a (docs/modes/split-parts.md#model): the pieces, each
// evaluated in its own blank and moved back by its offset, are the source inside their cells.
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
import { shapeRegion } from './layout'
import { planPieces } from './pieces'
import { ENCLOSURE_LEVEL, ENCLOSURE_STOCK, enclosureCommands } from './split.fixture'

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

const cases: [string, object][] = [
  ['one level', { levels: [ENCLOSURE_LEVEL] }],
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
]

describe('reassembly: pieces == source', () => {
  it.each(cases)(
    '%s',
    async (_, split) => {
      const s = await enclosure()
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
        const { bounds, band } = plan.cell
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
