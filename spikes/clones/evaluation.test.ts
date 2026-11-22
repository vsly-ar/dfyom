/**
 * Spike S6, part 1: evaluation of 100 / 500 / 1000 clone instances against the 50 ms budget.
 * Prints tables (`--silent=false`); asserts only that every way gives the same part.
 * Report: docs/research/s6-clone-budgets.md.
 */
import { expect, it } from 'vitest'
import { evaluatePart } from '../../src/core/geometry/evaluate'
import { loadManifold } from '../../src/core/geometry/manifold'
import { OperationCache } from '../../src/core/geometry/operation-cache'
import { nodeManifoldSource } from '../../src/core/geometry/testing/node-wasm'
import { evaluateClones, type Mode, type Timings } from './evaluate'
import { counterbores, expanded, slots, sourceEdited } from './workload'

const COUNTS = (process.env['S6_COUNTS'] ?? '100,500,1000').split(',').map(Number)
const RUNS = Number(process.env['S6_RUNS'] ?? 5)

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

const f = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1))

it('evaluates clone instances (production path and levers)', async () => {
  const kernel = (await loadManifold(nodeManifoldSource())).unwrap()
  const rows: string[] = [
    '| Workload | Path | Layers | Build | Compose | Subtract (unions; max layer) | toMesh | Label | Total | Triangles |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  const prodRows: string[] = [
    '| Workload | Operations | Fresh | Unchanged (caches) | Source edited (caches) | Triangles |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const make of [counterbores, slots])
    for (const n of COUNTS) {
      const w = make(n)
      const input = expanded(w)
      // ---- production evaluatePart: fresh, unchanged and source edited with the worker caches
      const once = kernel.withSolids((s) => evaluatePart(input, s)).unwrap()
      const fresh: number[] = []
      for (let r = 0; r < RUNS; r++) {
        const t = performance.now()
        kernel.withSolids((s) => evaluatePart(input, s)).unwrap()
        fresh.push(performance.now() - t)
      }
      kernel.keepSolids(150_000)
      const cache = new OperationCache()
      kernel.withSolids((s) => evaluatePart(input, s, undefined, undefined, cache)).unwrap()
      const unchanged: number[] = []
      for (let r = 0; r < RUNS; r++) {
        const t = performance.now()
        kernel.withSolids((s) => evaluatePart(input, s, undefined, undefined, cache)).unwrap()
        unchanged.push(performance.now() - t)
      }
      const edited: number[] = []
      for (let r = 0; r < RUNS; r++) {
        const e = expanded(sourceEdited(w, r + 1))
        const t = performance.now()
        kernel.withSolids((s) => evaluatePart(e, s, undefined, undefined, cache)).unwrap()
        edited.push(performance.now() - t)
      }
      kernel.keepSolids(0)
      prodRows.push(
        `| ${w.name} | ${input.operations.length} | ${f(median(fresh))} | ${f(median(unchanged))} | ` +
          `${f(median(edited))} | ${once.stats.triangles} |`,
      )

      // ---- spike paths (no geometry checks)
      const paths: [string, Mode, number][] = [
        ['perOp, layers of 25 (today)', 'perOp', 25],
        ['perOp, layers of 100', 'perOp', 100],
        ['perOp, one layer per disjoint set', 'perOp', Infinity],
        ['translateMesh, layers of 25', 'translateMesh', 25],
        ['translateMesh, one layer', 'translateMesh', Infinity],
        ['transform, layers of 25', 'transform', 25],
        ['transform, layers of 100', 'transform', 100],
        ['transform, one layer', 'transform', Infinity],
      ]
      const volumes: number[] = []
      for (const [label, mode, chunk] of paths) {
        const runs: Timings[] = []
        for (let r = 0; r < RUNS; r++)
          runs.push(kernel.withSolids((s) => evaluateClones(w, s, { mode, chunk })).unwrap())
        const m = (k: keyof Timings) => median(runs.map((t) => t[k]))
        volumes.push(runs[0]!.volume)
        expect(m('unlabelled')).toBe(0)
        rows.push(
          `| ${w.name} | ${label} | ${m('layers')} | ${f(m('build'))} | ${f(m('compose'))} | ` +
            `${f(m('subtract'))} (${f(m('union'))}; ${f(m('maxLayer'))}) | ${f(m('toMesh'))} | ${f(m('label'))} | ` +
            `**${f(m('total'))}** | ${m('triangles')} |`,
        )
      }
      // with caches: unchanged re-evaluation and a source edit (cache per source + offset)
      for (const [label, mode] of [
        ['translateMesh, one layer, caches', 'translateMesh'],
        ['transform, one layer, caches', 'transform'],
      ] as const) {
        kernel.keepSolids(150_000)
        const c = new OperationCache()
        kernel.withSolids((s) =>
          evaluateClones(w, s, { mode, chunk: Infinity, cache: c, keep: true }),
        )
        const un: number[] = []
        const ed: number[] = []
        for (let r = 0; r < RUNS; r++) {
          un.push(
            kernel
              .withSolids((s) =>
                evaluateClones(w, s, { mode, chunk: Infinity, cache: c, keep: true }),
              )
              .unwrap().total,
          )
          const e = sourceEdited(w, r + 1)
          ed.push(
            kernel
              .withSolids((s) =>
                evaluateClones(e, s, { mode, chunk: Infinity, cache: c, keep: true }),
              )
              .unwrap().total,
          )
        }
        kernel.keepSolids(0)
        rows.push(
          `| ${w.name} | ${label} | | | | | | | unchanged **${f(median(un))}**, source edited ` +
            `**${f(median(ed))}** | |`,
        )
      }
      for (const v of volumes) expect(Math.abs(v - volumes[0]!) / volumes[0]!).toBeLessThan(1e-6)
      expect(Math.abs(once.volume - volumes[0]!) / volumes[0]!).toBeLessThan(1e-6)
    }
  console.log(['', 'Production evaluatePart (ms, median):', ...prodRows].join('\n'))
  console.log(['', 'Spike paths (ms, median; no geometry checks):', ...rows].join('\n'))
  expect(kernel.liveObjects()).toBe(0)
})
