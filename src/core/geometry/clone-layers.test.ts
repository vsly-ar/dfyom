// Clone layers (v0.4, S6 follow-up): clone groups subtracted first in layers of up to
// CLONE_LAYER, the part after them kept across evaluations. Grouping changes the work, never the
// part. Doc: docs/architecture/geometry.md#clone-layers
import { beforeAll, describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { aborted, type StepProgress } from '../workers/steps'
import { KEPT_TRIANGLES } from '../workers/tasks'
import { CLONE_LAYER, cloneOrder, evaluatePart, type PartEvaluation } from './evaluate'
import { loadManifold } from './manifold'
import type { OperationGeometry, PartGeometryInput, Vec2 } from './model'
import { OperationCache } from './operation-cache'
import type { SolidKernel } from './solid-port'

let kernel: SolidKernel

beforeAll(async () => {
  kernel = expectOk(await loadManifold())
})

/**
 * `n` counterbored M3 holes (a Ø6 pocket 3.3 deep, a Ø3.4 through drilling on its floor) as a
 * Clones expansion, step-major, 10 per row at a 10 mm pitch, next to a pocket of depth `depth`
 * (the unrelated operation); `cloneGroups` as toGeometryInput writes them.
 */
function holes(n: number, depth = 3): PartGeometryInput {
  const at = (k: number): Vec2 => [10 + (k % 10) * 10, 10 + Math.floor(k / 10) * 10]
  const id = (base: string, k: number) => (k === 0 ? base : `clones1_${k + 1}_${base}`)
  const counterbores: OperationGeometry[] = []
  const drills: OperationGeometry[] = []
  for (let k = 0; k < n; k++) {
    counterbores.push({
      kind: 'pocket',
      id: id('hole1_counterbore', k),
      onZ: 0,
      shape: { center: at(k), contour: { kind: 'circle', radius: 3 } },
      depth: 3.3,
      floorRadius: 0,
    })
    drills.push({
      kind: 'drilling',
      id: id('hole1_drill', k),
      onZ: -3.3,
      center: at(k),
      diameter: 3.4,
      bottom: { kind: 'through' },
    })
  }
  // source operations first (instance 1), then the instances step-major
  const operations: OperationGeometry[] = [
    counterbores[0]!,
    drills[0]!,
    ...counterbores.slice(1),
    ...drills.slice(1),
    {
      kind: 'pocket',
      id: 'pocket1',
      onZ: 0,
      shape: {
        center: [130, 50],
        contour: { kind: 'rectangle', length: 20, width: 80, cornerRadius: 4 },
      },
      depth,
      floorRadius: 0,
    },
  ]
  return {
    stock: { length: 150, width: 120, thickness: 6 },
    operations,
    cloneGroups: [counterbores.map((o) => o.id), drills.map((o) => o.id)],
  }
}

const ungrouped = ({ cloneGroups: _, ...input }: PartGeometryInput): PartGeometryInput => input

const run = (input: PartGeometryInput, cache?: OperationCache): PartEvaluation =>
  expectOk(kernel.withSolids((s) => evaluatePart(input, s, undefined, undefined, cache)))

/** Each triangle as its surface and corners (rotated to the smallest first), sorted. */
function triangles(e: PartEvaluation): string[] {
  const out: string[] = []
  for (let t = 0; t < e.triangleSurface.length; t++) {
    const corners = [0, 1, 2].map((k) => {
      const v = e.indices[3 * t + k]!
      return `${e.positions[3 * v]},${e.positions[3 * v + 1]},${e.positions[3 * v + 2]}`
    })
    const first = corners.indexOf([...corners].sort()[0]!)
    out.push(
      `${e.surfaces[e.triangleSurface[t]!]} ${[0, 1, 2].map((k) => corners[(first + k) % 3]!).join(' ')}`,
    )
  }
  return out.sort()
}

/**
 * Per surface: its area and its distinct vertices, sorted – the same for any triangulation of
 * the same faces (another subtraction order may triangulate a planar face differently).
 */
function surfaceGeometry(e: PartEvaluation): Map<string, { area: number; vertices: string[] }> {
  const out = new Map<string, { area: number; vertices: Set<string> }>()
  const p = (v: number) => [0, 1, 2].map((k) => e.positions[3 * v + k]!)
  for (let t = 0; t < e.triangleSurface.length; t++) {
    const id = e.surfaces[e.triangleSurface[t]!]!
    const entry = out.get(id) ?? { area: 0, vertices: new Set<string>() }
    out.set(id, entry)
    const [a, b, c] = [0, 1, 2].map((k) => p(e.indices[3 * t + k]!))
    const u = [0, 1, 2].map((k) => b![k]! - a![k]!)
    const w = [0, 1, 2].map((k) => c![k]! - a![k]!)
    const n = [0, 1, 2].map(
      (k) => u[(k + 1) % 3]! * w[(k + 2) % 3]! - u[(k + 2) % 3]! * w[(k + 1) % 3]!,
    )
    entry.area += Math.hypot(...n) / 2
    for (const v of [a, b, c]) entry.vertices.add(v!.join(','))
  }
  return new Map(
    [...out].map(([id, { area, vertices }]) => [id, { area, vertices: [...vertices].sort() }]),
  )
}

/** The same part: exactly the same labelled triangles, or (`exact` false) the same surfaces. */
const same = (a: PartEvaluation, b: PartEvaluation, exact = true) => {
  expect(b.surfaces.toSorted()).toEqual(a.surfaces.toSorted())
  expect(b.stats.triangles).toBe(a.stats.triangles)
  expect(Math.abs(b.volume - a.volume)).toBeLessThan(1e-9 * a.volume)
  expect(b.pieces).toBe(a.pieces)
  expect(b.warnings).toEqual(a.warnings)
  if (exact) {
    expect(triangles(b)).toEqual(triangles(a))
    return
  }
  const [ga, gb] = [surfaceGeometry(a), surfaceGeometry(b)]
  for (const [id, sa] of ga) {
    const sb = gb.get(id)!
    expect(sb.vertices).toEqual(sa.vertices)
    expect(Math.abs(sb.area - sa.area)).toBeLessThan(1e-6 * Math.max(1, sa.area))
  }
}

describe('cloneOrder', () => {
  const t = (id: string) => ({ op: { id } })
  it('takes the groups first, group by group, and the rest in order; unknown ids skipped', () => {
    const tools = ['a', 'b', 'c', 'd', 'e'].map(t)
    const { clones, rest } = cloneOrder(tools, [
      ['d', 'b', 'x'],
      ['c', 'd'],
    ])
    expect(clones.map((c) => c.op.id)).toEqual(['d', 'b', 'c'])
    expect(rest.map((c) => c.op.id)).toEqual(['a', 'e'])
    expect(cloneOrder(tools).rest).toEqual(tools)
  })
})

describe('clone layers', { timeout: 60_000 }, () => {
  it('give the same labelled triangles as layers of 25 (16 counterbored holes)', () => {
    same(run(ungrouped(holes(16))), run(holes(16)))
  })

  it('give the same part as layers of 25 (100 counterbored holes; planar faces may triangulate differently)', () => {
    same(run(ungrouped(holes(100))), run(holes(100)), false)
  })

  it('cap a layer at CLONE_LAYER and step once per layer', () => {
    const n = CLONE_LAYER + 10
    const seen: StepProgress[] = []
    expectOk(
      kernel.withSolids((s) =>
        evaluatePart(holes(n), s, { step: (p) => (seen.push(p!), Ok(undefined)) }),
      ),
    )
    const layers = seen.filter((p) => p.label?.startsWith('subtract')).map((p) => p.label)
    // counterbores 1–100; 101–110 with drills 1–90 (disjoint from them); drills 91–110; the
    // pocket in a layer of its own
    expect(layers).toEqual(['subtract 1/4', 'subtract 2/4', 'subtract 3/4', 'subtract 4/4'])
    expect(seen.at(-1)!.done).toBeLessThanOrEqual(seen.at(-1)!.total!)
  })

  it('keep the part after them: an unrelated edit reuses it, a source edit rebuilds it', () => {
    kernel.keepSolids(KEPT_TRIANGLES)
    try {
      const cache = new OperationCache()
      const first = run(holes(100), cache)
      same(run(holes(100)), first)
      // stock, 201 operations, the clone prefix
      expect(kernel.keptObjects()).toBe(203)
      const labels: string[] = []
      const edited = expectOk(
        kernel.withSolids((s) =>
          evaluatePart(
            holes(100, 4),
            s,
            { step: (p) => (labels.push(p!.label!), Ok(undefined)) },
            undefined,
            cache,
          ),
        ),
      )
      expect(labels.filter((l) => l.startsWith('subtract'))).toEqual(['subtract 3/3'])
      expect(labels).toContain('clone layers')
      same(run(holes(100, 4)), edited)
      // a changed instance: new ids, a new prefix
      const moved = holes(100)
      const ops = moved.operations.map((o) =>
        o.id === 'clones1_5_hole1_drill' && o.kind === 'drilling' ? { ...o, diameter: 3.2 } : o,
      )
      same(run({ ...moved, operations: ops }), run({ ...moved, operations: ops }, cache))
      expect(kernel.liveObjects()).toBe(0)
    } finally {
      kernel.keepSolids(0)
    }
  })

  it('abort between clone layers', () => {
    let count = 0
    const r = kernel.withSolids((s) =>
      evaluatePart(holes(16), s, {
        step: (p) => (p?.label === 'subtract 1/3' || ++count > 1e6 ? aborted() : Ok(undefined)),
      }),
    )
    expect(r.unwrapErr().code).toBe('op.aborted')
    expect(kernel.liveObjects()).toBe(0)
  })
})
