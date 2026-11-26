// Engraved patterns E1 headless: a Line fluting an open curve from 0.2 to 1.5 mm with a 60° V-bit
// on a lid, through `dfyom batch` and the agent's tools only: the shape, `design.line.add` with a
// `{ start, end }` depth, the plan (the V-bit chosen from the library), the toolpath, the export
// and a run on the virtual machine to Idle.
// Spec: docs/modes/engraved-patterns.md#implementation-e1
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { tempDir } from '../host/host.fixture'
import { spawnCli } from './cli.fixture'
import {
  agentSession,
  programEnd,
  type CallResult,
  type RunJobStatus,
} from './exit-criteria.fixture'
import { MACHINE } from './exit-criteria.v04.fixture'

const t = tempDir('dfyom-e2e-line-')
afterAll(() => t.cleanup())

const V_BIT = {
  name: 'V-bit 60 × 6',
  type: 'chamferMill',
  diameter: '6',
  angle: '60',
  fluteLength: '6',
  overallLength: '50',
  fluteCount: '2',
  toolMaterial: 'carbide',
  presets: [
    {
      name: 'Plywood',
      materialClass: 'sheetGood',
      spindleSpeed: '18000',
      feedRate: '1500',
      plungeRate: '400',
      stepdown: '0.5',
    },
  ],
}

describe('E1: a Line fluting 0.2 → 1.5 mm with a V-bit, headless', { timeout: 180_000 }, () => {
  it('designs, plans, exports and runs the line on the virtual machine', async () => {
    const cli = spawnCli(['batch'], t.dir)
    const call = async (name: string, args: object = {}): Promise<CallResult> => {
      cli.send({ name, args })
      return (await cli.next()) as unknown as CallResult
    }
    const { ok, waitJob, untilLabel } = agentSession(call)

    const stock = (
      await ok<{ id: string }>('library.stock.add', {
        values: {
          name: 'Birch plywood 6',
          shape: 'block',
          length: '120',
          width: '80',
          thickness: '6',
          material: { name: 'Birch plywood', class: 'sheetGood' },
        },
      })
    ).value.id
    await ok('library.tool.add', { values: V_BIT })
    const machine = (await ok<{ id: string }>('library.machine.add', { values: MACHINE })).value.id
    const created = await ok<{ revision: number }>('project.create', {
      name: 'Line lid',
      unitSystem: 'mm',
    })
    const { partId } = (
      await ok<{ partId: string }>('design.part.add', {
        name: 'Lid',
        stockLibraryItemId: stock,
        expectedRevision: created.value.revision,
      })
    ).value
    // a curved open line: a straight run into a half circle and back out
    const { shapeId } = (
      await ok<{ shapeId: string }>('design.shape.add', {
        partId,
        name: 'Flute',
        items: [
          {
            kind: 'path',
            closed: false,
            start: ['0', '0'],
            segments: [
              { kind: 'line', to: ['40', '0'] },
              { kind: 'arc', to: ['60', '0'], radius: '10', cw: false },
              { kind: 'line', to: ['80', '0'] },
            ],
          },
        ],
      })
    ).value
    const added = (
      await ok<{ operationId: string; warnings: { count: number } }>('design.line.add', {
        partId,
        paths: [{ shapeId, center: ['60', '40'] }],
        depth: { start: '0.2', end: '1.5' },
      })
    ).value
    expect(added.operationId).toBe('line1')
    expect(added.warnings.count).toBe(0)

    const { planId } = (
      await ok<{ planId: string }>('plan.create', { partId, machineLibraryItemId: machine })
    ).value
    const { plan } = (
      await ok<{
        plan: {
          setups: { id: string; operations: { kind: string; tool: string }[] }[]
        }
      }>('plan.get', { planId })
    ).value
    expect(plan.setups).toHaveLength(1)
    const setup = plan.setups[0]!
    expect(setup.operations.map((o) => [o.kind, o.tool])).toEqual([['line', V_BIT.name]])
    const gen = await ok<{ jobId: string }>('plan.toolpath.generate', { planId })
    const generated = (await waitJob(gen.value.jobId)) as { ok: boolean }
    expect(generated.ok, JSON.stringify(generated)).toBe(true)

    await ok('run.connection.open', { target: 'virtual', planId, timeScale: 'max', prepare: true })
    const target = join(t.dir, 'line-lid.nc')
    const exported = (
      await ok<{ lines: number; warnings: unknown[] }>('plan.export', {
        planId,
        setupId: setup.id,
        target,
      })
    ).value
    expect(exported.warnings).toEqual([])
    const program = readFileSync(target, 'utf8')
    // three passes down to 1.5 mm, helical arcs on the half circle
    const zs = [...program.matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))
    expect(Math.min(...zs)).toBeCloseTo(-1.5, 3)
    expect(program).toMatch(/^G[23] .*Z-/m)
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
    await ok('project.save', { target: join(t.dir, 'line-lid.dfyom') })
    cli.end()
    expect(await cli.exited).toMatchObject({ code: 0, stderr: '' })
  })
})
