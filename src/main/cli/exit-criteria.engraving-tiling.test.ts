// Engraved patterns E4 headless: the Waves tile preset (the default motif) tiled over a 150 × 100
// lid and clipped to its rounded-rectangle outline less 3 mm, through `dfyom batch` and the
// agent's tools only: the outline shape, `design.engraving.add`, the plan (the V-bit chosen from
// the library), the toolpath, the export and a run on the virtual machine to Idle. Each inner row
// of waves is one continuous groove (one plunge, no recut seams).
// Spec: docs/modes/engraved-patterns.md#implementation-e4
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

const t = tempDir('dfyom-e2e-engraving-tiling-')
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

describe(
  'E4: an engraved pattern of tiles (Waves) on a lid, headless',
  { timeout: 180_000 },
  () => {
    it('tiles the preset, plans, exports and runs it on the virtual machine', async () => {
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
            length: '150',
            width: '100',
            thickness: '6',
            material: { name: 'Birch plywood', class: 'sheetGood' },
          },
        })
      ).value.id
      await ok('library.tool.add', { values: V_BIT })
      const machine = (await ok<{ id: string }>('library.machine.add', { values: MACHINE })).value
        .id
      const created = await ok<{ revision: number }>('project.create', {
        name: 'Lid',
        unitSystem: 'mm',
      })
      const { partId } = (
        await ok<{ partId: string }>('design.part.add', {
          name: 'Lid',
          stockLibraryItemId: stock,
          expectedRevision: created.value.revision,
        })
      ).value
      // the lid's rounded outline as the boundary; the default motif tiles it, clipped
      const { shapeId } = (
        await ok<{ shapeId: string }>('design.shape.add', {
          partId,
          name: 'Lid outline',
          items: [
            {
              kind: 'rectangle',
              op: 'add',
              center: ['0', '0'],
              length: '140',
              width: '90',
              cornerRadius: '15',
            },
          ],
        })
      ).value
      const added = (
        await ok<{
          featureId: string
          operationIds: string[]
          lines: number
          tiles: number
          warnings: { count: number }
        }>('design.engraving.add', {
          partId,
          boundary: { shapeId, center: ['75', '50'] },
          depth: { min: '0.2', max: '0.6' },
        })
      ).value
      expect(added).toMatchObject({
        featureId: 'engraving1',
        operationIds: ['engraving1_line'],
        warnings: { count: 0 },
      })
      expect(added.tiles).toBeGreaterThan(60)
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

      await ok('run.connection.open', {
        target: 'virtual',
        planId,
        timeScale: 'max',
        prepare: true,
      })
      const target = join(t.dir, 'lid.nc')
      const exported = (
        await ok<{ lines: number; warnings: unknown[] }>('plan.export', {
          planId,
          setupId: setup.id,
          target,
        })
      ).value
      expect(exported.warnings).toEqual([])
      const program = readFileSync(target, 'utf8')
      // the waves at 0.6 mm (level 1), arcs throughout; one plunge per line (seams not recut)
      const zs = [...program.matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))
      const cuts = zs.filter((z) => z < 0)
      expect(Math.min(...cuts)).toBeCloseTo(-0.6, 3)
      expect(program).toMatch(/^G[23] /m)
      const plunges = program.split('\n').filter((l) => /^G1 Z0 /.test(l)).length
      expect(plunges).toBe(added.lines)
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
      await ok('project.save', { target: join(t.dir, 'lid.dfyom') })
      cli.end()
      expect(await cli.exited).toMatchObject({ code: 0, stderr: '' })
    })
  },
)
