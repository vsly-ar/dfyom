/**
 * Spike S6, part 3: an edit of an unrelated operation on a part that holds N clone instances.
 * Today every evaluation runs all subtraction layers, so the clones cost every edit. Lever: keep
 * the part after the clone layers (subtraction order does not matter) and subtract only the
 * other operations from it. Prints a table (`--silent=false`). Report: docs/research/s6-clone-budgets.md.
 */
import { expect, it } from 'vitest'
import { Ok } from '../../src/shared/result'
import { boxOf } from '../../src/core/geometry/checks'
import { evaluatePart, subtractionLayers } from '../../src/core/geometry/evaluate'
import { loadManifold } from '../../src/core/geometry/manifold'
import { translation, type OperationGeometry } from '../../src/core/geometry/model'
import { OperationCache } from '../../src/core/geometry/operation-cache'
import { operationSolids, stockSolids } from '../../src/core/geometry/operations'
import type { Solid, SolidPort } from '../../src/core/geometry/solid-port'
import { nodeManifoldSource } from '../../src/core/geometry/testing/node-wasm'
import { counterbores, expanded, type Workload } from './workload'

const COUNTS = (process.env['S6_COUNTS'] ?? '100,500,1000').split(',').map(Number)
const RUNS = Number(process.env['S6_RUNS'] ?? 5)
const f = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1))
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

/** A 60 × 200 pocket beside the clone grid (stock made 80 mm longer for it), depth `d`. */
const other = (d: number): OperationGeometry => ({
  kind: 'pocket',
  id: 'pocket_other',
  onZ: 0,
  shape: {
    center: [460, 135],
    contour: { kind: 'rectangle', length: 60, width: 200, cornerRadius: 4 },
  },
  depth: d,
  floorRadius: 0,
})

/** The part after the clone layers (transform instancing, one layer per disjoint set). */
function cloneLayers(w: Workload, solids: SolidPort, stockSolid: Solid): Solid {
  const units: { solid: Solid; box: ReturnType<typeof boxOf> }[] = []
  for (const src of w.group.source) {
    const built = operationSolids(src, w.stock, {
      triangulate: (r) => solids.triangulate(r),
    }).unwrap()
    const id = solids.reserveOriginalId().unwrap()
    const removal = built.removal.map((m) => solids.fromMesh(m.mesh, id).unwrap())
    const solid = removal.length === 1 ? removal[0]! : solids.union(removal).unwrap()
    const box = boxOf(built.removal)
    for (const d of w.group.offsets)
      units.push({
        solid: solids.transform(solid, translation([d[0], d[1], 0])).unwrap(),
        box: {
          min: [box.min[0] + d[0], box.min[1] + d[1], box.min[2]],
          max: [box.max[0] + d[0], box.max[1] + d[1], box.max[2]],
        },
      })
  }
  let part = stockSolid
  for (const layer of subtractionLayers(units, Infinity))
    part = solids.subtract(part, solids.union(layer.map((u) => u.solid)).unwrap()).unwrap()
  solids.status(part).unwrap()
  return part
}

it('edits an unrelated operation next to N clone instances', async () => {
  const kernel = (await loadManifold(nodeManifoldSource())).unwrap()
  const rows = [
    '| Clones | Today: edit, worker caches | Kept clone layers: subtract + toMesh | Part triangles |',
    '| --- | --- | --- | --- |',
  ]
  for (const n of COUNTS) {
    const base = counterbores(n)
    const w: Workload = { ...base, stock: { ...base.stock, length: base.stock.length + 80 } }
    const input = (d: number) => ({
      ...expanded(w),
      operations: [...expanded(w).operations, other(d)],
    })
    // today: the worker's caches, only the other pocket changes
    kernel.keepSolids(1_000_000)
    const cache = new OperationCache()
    kernel.withSolids((s) => evaluatePart(input(3), s, undefined, undefined, cache)).unwrap()
    const today: number[] = []
    for (let r = 0; r < RUNS; r++) {
      const t = performance.now()
      kernel
        .withSolids((s) => evaluatePart(input(3 + 0.1 * (r + 1)), s, undefined, undefined, cache))
        .unwrap()
      today.push(performance.now() - t)
    }
    kernel.keepSolids(0)
    // lever: the part after the clone layers kept across evaluations
    kernel.keepSolids(1_000_000)
    const key = `clones|${n}`
    const prefix = (s: SolidPort) =>
      s.kept(key, () => {
        const stock = stockSolids(w.stock).unwrap()
        const id = s.reserveOriginalId().unwrap()
        const stockSolid = s
          .union(stock.removal.map((m) => s.fromMesh(m.mesh, id).unwrap()))
          .unwrap()
        return Ok({ solid: cloneLayers(w, s, stockSolid), originalId: id })
      })
    kernel.withSolids((s) => prefix(s).map(() => 0)).unwrap()
    const kept: number[] = []
    let triangles = 0
    for (let r = 0; r < RUNS; r++) {
      const t = performance.now()
      kernel
        .withSolids((s) =>
          prefix(s).andThen(({ solid }) => {
            const op = operationSolids(other(3 + 0.1 * (r + 1)), w.stock, {
              triangulate: (x) => s.triangulate(x),
            }).unwrap()
            const tool = s.fromMesh(op.removal[0]!.mesh, s.reserveOriginalId().unwrap()).unwrap()
            return s.toMesh(s.subtract(solid, tool).unwrap()).map((m) => {
              triangles = m.triangleFace.length
              return 0
            })
          }),
        )
        .unwrap()
      kept.push(performance.now() - t)
    }
    kernel.keepSolids(0)
    rows.push(
      `| ${n} counterbored holes | ${f(median(today))} | ${f(median(kept))} | ${triangles} |`,
    )
  }
  console.log(['', 'Unrelated edit next to N clones (ms, median):', ...rows].join('\n'))
  expect(kernel.liveObjects()).toBe(0)
})
