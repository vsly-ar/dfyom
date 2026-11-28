// The X2 lid variant headless (hardening DF40, X2 F3): "a second cutout like the first" as one
// Clones of a group: the Ø 22 cutout, its chamfer and its bolt circle (an arc Clones of a
// counterbored M3 hole) cloned to the other side of the board in one `design.clones.add`, then
// planned, exported and run on the virtual machine through `dfyom batch`, the agent's tools only.
// Spec: docs/modes/features.md#clones-v2-groups-df40, docs/plans/hardening.md (DF40)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BOLT_CIRCLE,
  CUTOUT,
  LID_STOCK,
  LID_TOOLS,
  onBoard,
} from '../../core/design/enclosure-lid.testing'
import type { Vec2 } from '../../core/geometry/model'
import { tempDir } from '../host/host.fixture'
import { spawnCli } from './cli.fixture'
import {
  agentSession,
  programEnd,
  type CallResult,
  type RunJobStatus,
} from './exit-criteria.fixture'
import { MACHINE, TOOLS } from './exit-criteria.v04.fixture'

const t = tempDir('dfyom-e2e-x2-group-')
afterAll(() => t.cleanup())

const at = (p: Vec2): [string, string] => onBoard(p).map((c) => `${c}`) as [string, string]

/** The second cutout: mirrored to the left of the board's centre. */
const SECOND: Vec2 = [-CUTOUT.centre[0], CUTOUT.centre[1]]

interface PlanOp {
  kind: string
  tool: string
  designOperationIds: string[]
}

describe(
  'X2 variant: a cutout and its bolt circle cloned as a group (DF40)',
  { timeout: 180_000 },
  () => {
    it('designs, plans, exports and runs the group on the virtual machine', async () => {
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
            length: `${LID_STOCK.length}`,
            width: `${LID_STOCK.width}`,
            thickness: `${LID_STOCK.thickness}`,
            material: { name: 'Birch plywood', class: LID_STOCK.materialClass },
          },
        })
      ).value.id
      for (const tool of TOOLS) await ok('library.tool.add', { values: tool })
      const machine = (await ok<{ id: string }>('library.machine.add', { values: MACHINE })).value
        .id
      const created = await ok<{ key: string; revision: number }>('project.create', {
        name: 'Lid variant',
        unitSystem: 'mm',
      })
      const { partId } = (
        await ok<{ partId: string }>('design.part.add', {
          name: 'Lid',
          stockLibraryItemId: stock,
          expectedRevision: created.value.revision,
        })
      ).value

      // the first cutout as the base lid has it: profile, chamfer on its edge, the bolt circle
      const cutout = (
        await ok<{ operationId: string }>('design.profile.add', {
          partId,
          shape: { kind: 'circle', center: at(CUTOUT.centre), diameter: `${CUTOUT.diameter}` },
          side: 'inside',
          slotWidth: `${CUTOUT.diameter / 2}`,
          tabs: { count: '0' },
        })
      ).value.operationId
      const chamfer = (
        await ok<{ operationId: string }>('design.chamfer.add', {
          partId,
          edgeOf: cutout,
          width: `${CUTOUT.chamferWidth}`,
        })
      ).value.operationId
      const bolt = (
        await ok<{ featureId: string }>('design.hole.add', {
          partId,
          center: at(BOLT_CIRCLE.source),
          type: BOLT_CIRCLE.type,
          fastener: BOLT_CIRCLE.fastener,
          fit: BOLT_CIRCLE.fit,
        })
      ).value.featureId
      const a = BOLT_CIRCLE.arc
      const boltCircle = (
        await ok<{ featureId: string }>('design.clones.add', {
          partId,
          source: { featureId: bolt },
          rows: [
            {
              kind: 'arc',
              radius: `${a.radius}`,
              angle: `${a.angle}`,
              arc: `${a.sweep}`,
              step: `${a.step}`,
            },
          ],
        })
      ).value.featureId

      // F3: one call clones the whole group (the bolt circle brings its hole)
      const group = { featureIds: [boltCircle], operationIds: [cutout, chamfer] }
      const point = { kind: 'point', u: at(SECOND)[0], v: at(SECOND)[1] }
      const preview = (
        await ok<{ instances: { n: number; at: [number, number] }[]; warnings: unknown[] }>(
          'design.clones.preview',
          { partId, source: group, rows: [point] },
        )
      ).value
      expect(preview.instances.map((i) => i.at)).toEqual([onBoard(CUTOUT.centre), onBoard(SECOND)])
      expect(preview.warnings).toEqual([])
      const second = (
        await ok<{ featureId: string; operationIds: string[] }>('design.clones.add', {
          partId,
          source: group,
          rows: [point],
        })
      ).value
      // cutout, chamfer, hole (counterbore, drill), 5 bolt-circle clones × 2: 14 operations
      expect(second.operationIds).toHaveLength(14)
      expect(second.operationIds).toContain(`${second.featureId}_2_${boltCircle}_4_${bolt}_drill`)

      // an edit of the hole reaches all 12 holes in one command
      await ok('design.hole.update', { partId, featureId: bolt, fastener: 'M4' })
      const part = (
        await ok<{ part: { operations: { id: string; kind: string; diameter?: unknown }[] } }>(
          'design.part.get',
          { partId },
        )
      ).value.part
      const drills = part.operations.filter((o) => o.kind === 'drilling')
      expect(drills).toHaveLength(12)
      expect(new Set(drills.map((o) => JSON.stringify(o.diameter))).size).toBe(1)

      // plan: tool by tool across both groups (D34)
      const { planId } = (
        await ok<{ planId: string }>('plan.create', { partId, machineLibraryItemId: machine })
      ).value
      const { plan } = (
        await ok<{ plan: { setups: { id: string; operations: PlanOp[] }[] } }>('plan.get', {
          planId,
        })
      ).value
      expect(plan.setups).toHaveLength(1)
      const setup = plan.setups[0]!
      const planned = setup.operations.map((o) => [o.kind, o.tool, o.designOperationIds.length])
      // one plan operation per clone source operation (DF146): the 12 counterbores, the 12
      // holes, the cutout and its copy, the two chamfers
      expect(planned).toEqual([
        ['pocket', LID_TOOLS.mill.name, 12],
        ['drilling', LID_TOOLS.mill.name, 12],
        ['profile', LID_TOOLS.profile.name, 2],
        ['chamfer', LID_TOOLS.chamfer.name, 2],
      ])
      const gen = await ok<{ jobId: string }>('plan.toolpath.generate', { planId })
      const generated = (await waitJob(gen.value.jobId)) as { ok: boolean }
      expect(generated.ok, JSON.stringify(generated)).toBe(true)

      // export and run on the virtual machine
      await ok('run.connection.open', {
        target: 'virtual',
        planId,
        timeScale: 'max',
        prepare: true,
      })
      const target = join(t.dir, 'lid-variant.nc')
      const exported = (
        await ok<{ lines: number; stats: { toolChanges: number }; warnings: unknown[] }>(
          'plan.export',
          { planId, setupId: setup.id, target },
        )
      ).value
      expect(exported.warnings).toEqual([])
      expect(exported.stats.toolChanges).toBe(2)
      const program = readFileSync(target, 'utf8')
      const comments = new Set([...program.matchAll(/^\((Clones \d+ #\d+)\)$/gm)].map((m) => m[1]))
      // the inner positions keep their names; the outer one names the second group
      for (const n of [1, 2, 3, 4, 5, 6]) expect(comments).toContain(`Clones 1 #${n}`)
      expect(comments).toContain('Clones 2 #1')
      expect(comments).toContain('Clones 2 #2')
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
      await ok('project.save', { target: join(t.dir, 'lid-variant.dfyom') })
      cli.end()
      expect(await cli.exited).toMatchObject({ code: 0, stderr: '' })
    })
  },
)
