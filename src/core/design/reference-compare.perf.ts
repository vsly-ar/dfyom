/**
 * Compare timings (DF60 P4/P5, docs/modes/reference-tools.md#performance): the full enclosure
 * (77 K triangles) against its approximated design, in-process. The first run reads the STL and
 * prepares the reference; the next ones, after a design edit as the overlay re-runs, reuse what
 * the worker keeps. Outside `npm run check` (timings are flaky in CI). Run: `npm run perf`.
 */
import { expect, it } from 'vitest'
import { referenceCompareView } from '../workers/tasks'
import { ghostMatrix } from './reference'
import { storedPlacement } from './reference-find'
import { compare, enclosureDesign } from './reference-compare.testing'

/** Target per run after an edit (the reference already read), dev machine. */
const BUDGET_MS = 2000

it('compares the enclosure within the budget once the reference is kept', async () => {
  const s = await enclosureDesign('56.338')
  s.evaluations.state(s.d.doc, s.partId)
  const time = async () => {
    const t0 = performance.now()
    await compare(s)
    return performance.now() - t0
  }
  const first = await time()
  const runs: number[] = []
  for (const depth of ['56.5', '57', '56.338']) {
    await s.run('design.pocket.update', { partId: s.partId, operationId: 'pocket1', depth })
    // the evaluation is done before the overlay re-runs: not part of the compare's time
    s.evaluations.state(s.d.doc, s.partId)
    runs.push(await time())
  }
  runs.sort((a, b) => a - b)
  const median = runs[1]!
  console.log(
    `compare enclosure: first ${first.toFixed(0)} ms, after an edit ${runs.map((r) => r.toFixed(0)).join(' / ')} ms`,
  )
  expect(median).toBeLessThan(BUDGET_MS)

  // the overlay's view of the evaluated mesh (P5): signed distances on the kept BVH
  const state = s.evaluations.state(s.d.doc, s.partId)
  if (state.evaluation === undefined) throw new Error('no evaluation')
  const ref = Object.values(s.d.doc.references)[0]!
  const t0 = performance.now()
  const v = await s.workers.run(
    referenceCompareView,
    {
      path: `/work/${ref.asset.path}`,
      triangles: ref.asset.triangles,
      matrix: ghostMatrix(ref.asset.bounds, storedPlacement(ref, 'perf').unwrap()),
      positions: state.evaluation.positions,
      threshold: 0.1,
    },
    { signal: new AbortController().signal, progress: () => undefined },
  )
  console.log(
    `compare view: ${(performance.now() - t0).toFixed(0)} ms for ${state.evaluation.positions.length / 3} vertices`,
  )
  expect(v.isOk()).toBe(true)
}, 300_000)
