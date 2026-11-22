/**
 * Spike S6, part 2: the command side of 100 / 500 / 1000 clone instances, with instances as
 * plain operations added through today's design commands (what an expansion writes):
 * - resolve + checks: `parameterChecks` over the expanded geometry input, and whole design
 *   commands (`toGeometryInput` + `partWarnings` + patches) on a part holding N instances;
 * - Apply (auto tool choice), plan creation, toolpath generation and the GRBL program size.
 * Prints tables (`--silent=false`). Report: docs/research/s6-clone-budgets.md.
 */
import { expect, it } from 'vitest'
import { expectOk } from '../../src/shared/testing/result'
import { inProcessWorkers } from '../../src/core/commands/jobs'
import { parameterChecks, type DfmTool } from '../../src/core/geometry/dfm'
import { exportPlan } from '../../src/core/post/plan-export'
import { planSetup, flat6, drill6, drillPreset } from '../../src/core/plan/plan.fixture'
import { createToolpathCache } from '../../src/core/toolpath/cache'
import { len, libraryInput, machineValues } from '../../src/core/library/library.fixture'
import { counterbores, expanded, slots } from './workload'

const COUNTS = (process.env['S6_COUNTS'] ?? '100,500,1000').split(',').map(Number)
const f = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2))

function median(n: number, fn: () => void): number {
  for (let i = 0; i < 3; i++) fn()
  const times: number[] = []
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    fn()
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(n / 2)]!
}

it('runs parameterChecks over N clone instances', () => {
  const tools: DfmTool[] = [
    { type: 'flatEndMill', diameter: 3 },
    { type: 'flatEndMill', diameter: 6 },
    { type: 'drill', diameter: 3.4 },
  ]
  const rows = [
    '| Workload | Operations | parameterChecks (ms) | per operation (µs) |',
    '| --- | --- | --- | --- |',
  ]
  for (const make of [counterbores, slots])
    for (const n of COUNTS) {
      const input = expanded(make(n))
      const operationTools = Object.fromEntries(
        input.operations.map((op) => [
          op.id,
          {
            tool: op.kind === 'drilling' ? tools[2]! : tools[0]!,
            generalized: false,
            locked: false,
            label: op.kind,
          },
        ]),
      )
      const ms = median(9, () =>
        parameterChecks(input, { tools, unitSystem: 'metric', operationTools }),
      )
      rows.push(
        `| ${make(n).name} | ${input.operations.length} | ${f(ms)} | ${f((1000 * ms) / input.operations.length)} |`,
      )
    }
  console.log(['', 'parameterChecks over the expanded input (median of 9):', ...rows].join('\n'))
})

it('runs design commands, Apply, generation and export with N clone instances', async () => {
  const rows = [
    '| Workload | Operations | Add one more (ms) | Update one (ms) | Apply (auto tools, ms) | plan.create (ms) | Generate + export (ms) | Export, cached (ms) | Plan operations | Program lines | Program size |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const kind of ['counterbores', 'slots'] as const)
    for (const n of COUNTS) {
      const w = kind === 'counterbores' ? counterbores(n) : slots(n)
      const s = await planSetup({
        part: false,
        stock: {
          name: 'Plywood',
          shape: 'block',
          length: String(w.stock.length),
          width: String(w.stock.width),
          thickness: String(w.stock.thickness),
          material: { name: '6061-T6', class: 'aluminum' },
        },
      })
      const add = async (values: object) =>
        ((await s.run('library.tool.add', { values: libraryInput(values) })) as { id: string }).id
      const f6 = flat6()
      await add({
        ...f6,
        name: 'Flat 3',
        diameter: len('3'),
        fluteLength: len('12'),
        presets: f6.presets.map((p) => ({ ...p, stepdown: len('1'), stepover: len('1.2') })),
      })
      await add({ ...drill6(), name: 'Drill 3.4', diameter: len('3.4'), presets: [drillPreset()] })
      const { kind: _, ...m } = machineValues()
      const machineId = (
        (await s.run('library.machine.add', {
          values: libraryInput({
            ...m,
            name: 'Big',
            travel: { x: len('1000'), y: len('1000'), z: len('100') },
          }),
        })) as { id: string }
      ).id
      const partId = s.partId
      const offsets = w.group.offsets
      const str = (v: number) => String(Math.round(v * 1e6) / 1e6)
      const addTimes: number[] = []
      const timed = async (name: string, args: object) => {
        const t = performance.now()
        await s.run(name, args)
        addTimes.push(performance.now() - t)
      }
      if (kind === 'counterbores') {
        for (const d of offsets)
          await timed('design.pocket.add', {
            partId,
            shape: { kind: 'circle', center: [str(10 + d[0]), str(10 + d[1])], diameter: '6' },
            depth: '3.3',
          })
        for (const [i, d] of offsets.entries())
          await timed('design.drilling.add', {
            partId,
            on: `pocket${i + 1}.floor`,
            center: [str(10 + d[0]), str(10 + d[1])],
            diameter: '3.4',
            bottom: 'through',
          })
      } else {
        for (const d of offsets)
          await timed('design.pocket.add', {
            partId,
            shape: {
              kind: 'rectangle',
              center: [str(20 + d[0]), str(10 + d[1])],
              length: '30',
              width: '5',
              cornerRadius: '2.5',
            },
            // a pocket must end above the stock bottom today (through pockets come with v0.4)
            depth: '5.5',
          })
      }
      const ops = s.part().operations.length
      const lastAdds = addTimes.slice(-10).sort((a, b) => a - b)[5]!
      let k = 0
      const update = async () => {
        const t = performance.now()
        await s.run('design.pocket.update', {
          partId,
          operationId: 'pocket1',
          depth: String(3 + (++k % 2) * 0.1),
        })
        return performance.now() - t
      }
      const ups: number[] = []
      for (let i = 0; i < 5; i++) ups.push(await update())
      ups.sort((a, b) => a - b)
      let t = performance.now()
      await s.run('project.apply', {})
      const applyMs = performance.now() - t
      t = performance.now()
      const planId = await s.create({ machineLibraryItemId: machineId })
      const createMs = performance.now() - t
      const planOps = s.plan(planId).setups.reduce((a, st) => a + st.operations.length, 0)
      const services = { workers: inProcessWorkers, toolpaths: createToolpathCache(512 * 2 ** 20) }
      t = performance.now()
      const ex = expectOk(await exportPlan(s.d.doc, planId, services))
      const exportMs = performance.now() - t
      t = performance.now()
      expectOk(await exportPlan(s.d.doc, planId, services))
      const cachedMs = performance.now() - t
      const bytes = new TextEncoder().encode(ex.text).length
      rows.push(
        `| ${w.name} | ${ops} | ${f(lastAdds)} | ${f(ups[2]!)} | ${f(applyMs)} | ${f(createMs)} | ` +
          `${f(exportMs)} | ${f(cachedMs)} | ${planOps} | ${ex.lines.length} | ${(bytes / 1024).toFixed(0)} KB |`,
      )
      expect(ops).toBe(w.group.source.length * n)
      console.log(rows.at(-1))
    }
  console.log(
    ['', 'Design commands, Apply, plan and export (ms; one run each):', ...rows].join('\n'),
  )
})
