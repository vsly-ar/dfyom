// H1 headless: one recessed countersunk M5 hole (a recess, the hole and its countersink on the
// recess floor) through `dfyom batch` and the agent's tools only: `design.hole.add` with
// `type: recessedCountersink`, the plan (an end mill for the recess and the bore, a chamfer mill for
// the cone), the toolpath, the export against its golden and a run on the virtual machine to Idle.
// Spec: docs/modes/hole-slots-and-round-corners.md#implementation-h1
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { withoutAppVersion } from '../../core/post/plan-export'
import { tempDir } from '../host/host.fixture'
import { spawnCli } from './cli.fixture'
import {
  agentSession,
  programEnd,
  type CallResult,
  type RunJobStatus,
} from './exit-criteria.fixture'
import { MACHINE, TOOLS } from './exit-criteria.v04.fixture'

/** Update after an intended post or generator change with `-u` and review the diff. */
const GOLDEN = './__golden__/exit-criteria-recessed-countersink-m5.nc'

const t = tempDir('dfyom-e2e-recessed-')
afterAll(() => t.cleanup())

describe('H1: a recessed countersunk M5 hole, headless', { timeout: 180_000 }, () => {
  it('designs, plans, exports and runs the hole on the virtual machine', async () => {
    const cli = spawnCli(['batch'], t.dir)
    const call = async (name: string, args: object = {}): Promise<CallResult> => {
      cli.send({ name, args })
      return (await cli.next()) as unknown as CallResult
    }
    const { ok, waitJob, untilLabel } = agentSession(call)

    const stock = (
      await ok<{ id: string }>('library.stock.add', {
        values: {
          name: 'Birch plywood 10',
          shape: 'block',
          length: '60',
          width: '40',
          thickness: '10',
          material: { name: 'Birch plywood', class: 'sheetGood' },
        },
      })
    ).value.id
    for (const tool of TOOLS) await ok('library.tool.add', { values: tool })
    const machine = (await ok<{ id: string }>('library.machine.add', { values: MACHINE })).value.id
    const created = await ok<{ revision: number }>('project.create', {
      name: 'Clamp',
      unitSystem: 'mm',
    })
    const { partId } = (
      await ok<{ partId: string }>('design.part.add', {
        name: 'Clamp',
        stockLibraryItemId: stock,
        expectedRevision: created.value.revision,
      })
    ).value
    const added = (
      await ok<{ featureId: string; operationIds: string[]; warnings: { count: number } }>(
        'design.hole.add',
        { partId, center: ['30', '20'], type: 'recessedCountersink', fastener: 'M5' },
      )
    ).value
    expect(added.operationIds).toEqual(['hole1_counterbore', 'hole1_drill', 'hole1_countersink'])
    expect(added.warnings.count).toBe(0)

    const { planId } = (
      await ok<{ planId: string }>('plan.create', { partId, machineLibraryItemId: machine })
    ).value
    const { plan } = (
      await ok<{
        plan: { setups: { id: string; operations: { kind: string; tool: string }[] }[] }
      }>('plan.get', { planId })
    ).value
    expect(plan.setups).toHaveLength(1)
    const setup = plan.setups[0]!
    // the recess follows the hole's end mill (followsHole): one end mill, then the chamfer mill
    const tools = setup.operations.map((o) => o.tool)
    expect(new Set(tools)).toEqual(new Set(['Flat 3', 'Chamfer 90 × 12']))
    const gen = await ok<{ jobId: string }>('plan.toolpath.generate', { planId })
    const generated = (await waitJob(gen.value.jobId)) as { ok: boolean }
    expect(generated.ok, JSON.stringify(generated)).toBe(true)

    await ok('run.connection.open', { target: 'virtual', planId, timeScale: 'max', prepare: true })
    const target = join(t.dir, 'clamp.nc')
    const exported = (
      await ok<{ lines: number; warnings: unknown[] }>('plan.export', {
        planId,
        setupId: setup.id,
        target,
      })
    ).value
    expect(exported.warnings).toEqual([])
    const program = readFileSync(target, 'utf8')
    await expect(withoutAppVersion(program)).toMatchFileSnapshot(GOLDEN)
    // the cone reaches 2 + 3.05 mm below the face; the bore goes through the 10 mm board
    const zs = [...program.matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))
    expect(Math.min(...zs)).toBeLessThan(-10)
    const run = await ok<{ jobId: string }>('run.job.start', { planId, setupId: setup.id })
    const jobId = run.value.jobId
    const ended = (await waitJob(jobId, async (job: RunJobStatus) => {
      if (job.phase === 'toolChange') {
        const tc = job.toolChange!
        await untilLabel(jobId, `Tool change ${tc.n}: ${tc.name}`)
        await ok('run.job.continue', { jobId, toolChange: tc.n })
      } else if (job.phase === 'programPause')
        await ok('run.job.continue', { jobId, pause: job.pause })
    })) as { ok: boolean; value: { lines: number; warnings: unknown[] } }
    expect(ended.ok, JSON.stringify(ended)).toBe(true)
    expect(ended.value).toMatchObject({ lines: exported.lines, warnings: [] })
    const after = (await ok<{ state: string; alarm?: unknown; wpos: number[] }>('run.status.get'))
      .value
    expect(after.state).toBe('Idle')
    expect(after.alarm).toBeUndefined()
    const end = programEnd(program)
    after.wpos.forEach((v, k) => expect(v).toBeCloseTo(end[k]!, 3))
    await ok('run.connection.close')
    await ok('project.save', { target: join(t.dir, 'clamp.dfyom') })
    cli.end()
    expect(await cli.exited).toMatchObject({ code: 0, stderr: '' })
  })
})
