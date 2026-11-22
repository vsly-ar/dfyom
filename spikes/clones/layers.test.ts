/**
 * Spike S6 follow-up: production `evaluatePart` before (no `cloneGroups`: layers of 25 over every
 * operation) and after (clone layers of up to `CLONE_LAYER` first, the part after them kept).
 * N counterbored holes next to a 60 × 200 pocket; fresh, unchanged and source edited with the
 * worker caches, and an edit of the pocket. Prints a table (`--silent=false`); asserts the same
 * volume. Report: docs/research/s6-clone-budgets.md#follow-up-clone-layers.
 */
import { expect, it } from 'vitest'
import { Ok } from '../../src/shared/result'
import { evaluatePart } from '../../src/core/geometry/evaluate'
import { loadManifold } from '../../src/core/geometry/manifold'
import type { OperationGeometry, PartGeometryInput } from '../../src/core/geometry/model'
import { OperationCache } from '../../src/core/geometry/operation-cache'
import { nodeManifoldSource } from '../../src/core/geometry/testing/node-wasm'
import { KEPT_TRIANGLES } from '../../src/core/workers/tasks'
import { counterbores, expanded, sourceEdited, translated, type Workload } from './workload'

const COUNTS = (process.env['S6_COUNTS'] ?? '16,100').split(',').map(Number)
const RUNS = Number(process.env['S6_RUNS'] ?? 7)
const f = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1))
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

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

/** The expansion plus the pocket; with `groups`, the clone groups toGeometryInput writes. */
function input(w: Workload, depth: number, groups: boolean): PartGeometryInput {
  const e = expanded(w)
  const cloneGroups = w.group.source.map((op) =>
    w.group.offsets.map((d, i) => translated(op, d, i + 1).id),
  )
  return {
    ...e,
    operations: [...e.operations, other(depth)],
    ...(groups ? { cloneGroups } : {}),
  }
}

it('evaluates N counterbored holes before and after clone layers', async () => {
  const kernel = (await loadManifold(nodeManifoldSource())).unwrap()
  const rows = [
    '| Clones | Path | Fresh | Unchanged (caches) | Source edited (caches) | Pocket edited (caches) | Longest step | Kept solids | Triangles |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const n of COUNTS) {
    const base = counterbores(n)
    const w: Workload = { ...base, stock: { ...base.stock, length: base.stock.length + 80 } }
    // every step's duration: the longest is the longest abortable step
    let longest = 0
    let last = 0
    const steps = {
      step: () => {
        const now = performance.now()
        longest = Math.max(longest, now - last)
        last = now
        return Ok(undefined)
      },
    }
    const time = (i: PartGeometryInput, cache?: OperationCache) => {
      longest = 0
      const t = (last = performance.now())
      const e = kernel.withSolids((s) => evaluatePart(i, s, steps, undefined, cache)).unwrap()
      return { ms: performance.now() - t, longest, triangles: e.stats.triangles, volume: e.volume }
    }
    // fresh runs interleaved (before, after, before, …): load swings hit both alike
    const fresh = [false, true].map(() => ({ ms: [] as number[], longest: [] as number[] }))
    const volumes: number[] = []
    let triangles = 0
    for (let r = 0; r < RUNS; r++)
      for (const [k, groups] of [false, true].entries()) {
        const t = time(input(w, 3, groups))
        fresh[k]!.ms.push(t.ms)
        fresh[k]!.longest.push(t.longest)
        triangles = t.triangles
        if (r === 0) volumes.push(t.volume)
      }
    for (const [k, groups] of [false, true].entries()) {
      kernel.keepSolids(KEPT_TRIANGLES)
      const cache = new OperationCache()
      time(input(w, 3, groups), cache)
      const unchanged: number[] = []
      const pocket: number[] = []
      const edited: number[] = []
      for (let r = 0; r < RUNS; r++) unchanged.push(time(input(w, 3, groups), cache).ms)
      for (let r = 0; r < RUNS; r++)
        pocket.push(time(input(w, 3 + 0.1 * (r + 1), groups), cache).ms)
      const kept = kernel.keptObjects()
      for (let r = 0; r < RUNS; r++)
        edited.push(time(input(sourceEdited(w, r + 1), 3, groups), cache).ms)
      kernel.keepSolids(0)
      rows.push(
        `| ${n} counterbored holes | ${groups ? 'clone layers (after)' : 'layers of 25 (before)'} | ` +
          `${f(median(fresh[k]!.ms))} | ${f(median(unchanged))} | ${f(median(edited))} | ` +
          `**${f(median(pocket))}** | ${f(median(fresh[k]!.longest))} | ${kept} | ${triangles} |`,
      )
    }
    for (const v of volumes) expect(Math.abs(v - volumes[0]!)).toBeLessThan(1e-6 * volumes[0]!)
  }
  console.log(
    ['', 'Production evaluatePart, before / after clone layers (ms, median):', ...rows].join('\n'),
  )
  expect(kernel.liveObjects()).toBe(0)
})
