// DF126 M1 headless: the user's case (TG #413), a pair of handle pockets as one pocket and a Clones
// mirror row across the stock centre, through `dfyom batch` and the agent's tools only; the plan,
// the toolpath, the export against its golden and a run on the virtual machine to Idle.
// Spec: docs/modes/clones-mirror.md#slices (M1)
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
const GOLDEN = './__golden__/exit-criteria-clones-mirror-handles.nc'

const t = tempDir('dfyom-e2e-mirror-')
afterAll(() => t.cleanup())

describe(
  'DF126 M1: two handle pockets mirrored across the stock centre, headless',
  {
    timeout: 180_000,
  },
  () => {
    it('designs, plans, exports and runs the mirrored pair on the virtual machine', async () => {
      const cli = spawnCli(['batch'], t.dir)
      const call = async (name: string, args: object = {}): Promise<CallResult> => {
        cli.send({ name, args })
        return (await cli.next()) as unknown as CallResult
      }
      const { ok, waitJob, untilLabel } = agentSession(call)

      const stock = (
        await ok<{ id: string }>('library.stock.add', {
          values: {
            name: 'Birch plywood 12',
            shape: 'block',
            length: '160',
            width: '80',
            thickness: '12',
            material: { name: 'Birch plywood', class: 'sheetGood' },
          },
        })
      ).value.id
      for (const tool of TOOLS) await ok('library.tool.add', { values: tool })
      const machine = (await ok<{ id: string }>('library.machine.add', { values: MACHINE })).value
        .id
      const created = await ok<{ revision: number }>('project.create', {
        name: 'Tray',
        unitSystem: 'mm',
      })
      const { partId } = (
        await ok<{ partId: string }>('design.part.add', {
          name: 'Tray',
          stockLibraryItemId: stock,
          expectedRevision: created.value.revision,
        })
      ).value
      // the left handle: a rounded slot 40 × 14, its outer end 12 mm in from the left edge, tilted
      await ok('design.pocket.add', {
        partId,
        shape: {
          kind: 'rectangle',
          center: ['12', '40'],
          length: '40',
          width: '14',
          cornerRadius: '7',
          rotation: '8',
        },
        anchor: { u: 'min', v: 'centre' },
        depth: '6',
      })
      const mirrored = (
        await ok<{ featureId: string; operationIds: string[]; warnings: { count: number } }>(
          'design.clones.add',
          {
            partId,
            source: { operationIds: ['pocket1'] },
            rows: [{ kind: 'mirror', flip: 'u' }],
          },
        )
      ).value
      expect(mirrored.operationIds).toEqual(['clones1_2_pocket1'])
      expect(mirrored.warnings.count).toBe(0)
      const part = (
        await ok<{ part: { operations: { id: string; shape?: object }[] } }>('design.part.get', {
          partId,
        })
      ).value.part
      // the right handle: the anchor's u point swapped, the rotation negated, 2·80 − 12 = 148
      expect(part.operations.find((o) => o.id === 'clones1_2_pocket1')).toMatchObject({
        shape: { anchor: { u: 'max', v: 'centre' }, center: [148, 40], rotation: -8 },
      })

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
      expect(setup.operations).toHaveLength(1) // the pocket and its mirror: one clone group (DF146)
      const gen = await ok<{ jobId: string }>('plan.toolpath.generate', { planId })
      const generated = (await waitJob(gen.value.jobId)) as { ok: boolean }
      expect(generated.ok, JSON.stringify(generated)).toBe(true)

      await ok('run.connection.open', {
        target: 'virtual',
        planId,
        timeScale: 'max',
        prepare: true,
      })
      const target = join(t.dir, 'tray.nc')
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
      // the cut is symmetric about X 80: the extreme X values mirror each other (X0: the move home)
      const xs = [...program.matchAll(/X(-?\d+(?:\.\d+)?)/g)]
        .map((m) => Number(m[1]))
        .filter((x) => x !== 0)
      expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(160, 2)
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
      await ok('project.save', { target: join(t.dir, 'tray.dfyom') })
      cli.end()
      expect(await cli.exited).toMatchObject({ code: 0, stderr: '' })
    })
  },
)
