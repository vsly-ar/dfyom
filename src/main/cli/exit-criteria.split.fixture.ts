// Test-only: the split parts 4a exit criterion (hardening DF91), run headless through the bundled
// CLI (exit-criteria.mcp.test.ts): the enclosure (split.fixture.ts, built from scratch) split by
// one level, then by the level and two lines; every piece is planned, exported and run on the
// virtual machine, setup by setup. Not app code.
// Docs: docs/modes/split-parts.md#implementation-4a, docs/modes/split-parts.md#slices
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { len, libraryInput, machineValues } from '../../core/library/library.fixture'
import { flat4, flat6 } from '../../core/plan/plan.fixture'
import {
  ENCLOSURE_LEVEL,
  ENCLOSURE_STOCK,
  enclosureCommands,
} from '../../core/design/split/split.fixture'
import { agentSession, type Call, type RunJobStatus } from './exit-criteria.fixture'

interface SplitResult {
  pieces: { partId: string; name: string; index: number; blank: number[] }[]
  findings: { severity: string; params: { rule: string } }[]
}
interface PlanGet {
  plan: { setups: { id: string; name: string; direction: string }[] }
}
interface RunStatus {
  state: string
  mpos: [number, number, number]
  workZero: [number, number, number]
}

/** A 6 mm flat that reaches through a 40 mm piece (the cavity is 30 mm deep in a piece). */
const flat6Long = () => ({
  ...flat6(),
  name: 'Flat 6 long',
  fluteLength: len('45'),
  overallLength: len('90'),
})

export async function exitCriteriaSplitFlow(
  call: Call,
  dir: string,
): Promise<{ pieces: number; setups: number }> {
  const { ok, waitJob } = agentSession(call)
  for (const t of [flat6Long(), flat4()]) await ok('library.tool.add', { values: libraryInput(t) })
  const machine = (
    await ok<{ id: string }>('library.machine.add', { values: libraryInput(machineValues()) })
  ).value.id
  const created = await ok<{ revision: number }>('project.create', {
    name: 'Enclosure split',
    unitSystem: 'mm',
  })
  const { partId } = (
    await ok<{ partId: string }>('design.part.add', {
      name: 'Enclosure',
      stock: ENCLOSURE_STOCK,
      expectedRevision: created.value.revision,
    })
  ).value
  for (const [name, args] of enclosureCommands(partId)) await ok(name, args)

  let pieces = 0
  let setups = 0
  const splits: [string, object][] = [
    ['level', { levels: [ENCLOSURE_LEVEL] }],
    [
      'level-lines',
      {
        levels: [ENCLOSURE_LEVEL],
        lines: [
          { axis: 'x', at: '125' },
          { axis: 'y', at: '100' },
        ],
      },
    ],
  ]
  for (const [label, split] of splits) {
    const r = (await ok<SplitResult>('design.split.set', { partId, split, confirm: true })).value
    expect(r.pieces).toHaveLength(label === 'level' ? 2 : 8)
    for (const piece of r.pieces) {
      const { planId } = (
        await ok<{ planId: string }>('plan.create', {
          partId: piece.partId,
          machineLibraryItemId: machine,
        })
      ).value
      const errors = (
        await ok<{ warnings: { severity: string; message: string }[] }>('plan.warning.list', {
          planId,
          detail: 'full',
        })
      ).value.warnings.filter((w) => w.severity === 'error')
      expect(errors, `${label} ${piece.name}`).toEqual([])
      const plan = (await ok<PlanGet>('plan.get', { planId })).value.plan
      await ok('run.connection.open', {
        target: 'virtual',
        planId,
        timeScale: 'max',
        prepare: true,
      })
      for (const [n, setup] of plan.setups.entries()) {
        const target = join(dir, `${label}-${piece.index}-${n + 1}.nc`)
        await ok('plan.export', { planId, setupId: setup.id, target })
        // the program is for the piece's own blank
        const [bl, bw, bt] = piece.blank.map((v) => +v.toFixed(3))
        const gcode = readFileSync(target, 'utf8')
        expect(gcode).toContain(`(Stock X ${bl} Y ${bw} Z ${bt} mm`)
        // tools zeroed on a floor (the rim holes on the top facing's floor): touch off there
        const floorZero = new Map(
          [...gcode.matchAll(/\(Z0 for tool (\d+): .*?, ([\d.]+) below the stock top\)/g)].map(
            (x) => [Number(x[1]), Number(x[2])],
          ),
        )
        if (n > 0) {
          // the next setup's stock zeroed at the same machine place (centred, as prepare)
          const s = (await ok<RunStatus>('run.status.get')).value
          const g54 = [-400 - piece.blank[0]! / 2, -400 - piece.blank[1]! / 2, s.workZero[2]]
          await ok('run.workZero.set', {
            axes: ['x', 'y', 'z'],
            values: s.mpos.map((m, i) => m - g54[i]!),
          })
        }
        const topZero = (await ok<RunStatus>('run.status.get')).value.workZero[2]
        const run = await ok<{ jobId: string }>('run.job.start', { planId, setupId: setup.id })
        const ended = await waitJob(run.value.jobId, async (job: RunJobStatus) => {
          if (job.phase === 'toolChange') {
            const s = (await ok<RunStatus>('run.status.get')).value
            const below = floorZero.get(job.toolChange!.n) ?? 0
            await ok('run.workZero.set', {
              axes: ['z'],
              values: [0, 0, s.mpos[2] - (topZero - below)],
            })
            await ok('run.job.continue', { jobId: run.value.jobId, toolChange: job.toolChange!.n })
          } else if (job.phase === 'programPause')
            await ok('run.job.continue', { jobId: run.value.jobId, pause: job.pause })
        })
        expect(ended.ok, `${label} ${piece.name} ${setup.name}: ${JSON.stringify(ended)}`).toBe(
          true,
        )
        setups++
      }
      await ok('run.connection.close')
      pieces++
    }
  }
  await ok('project.save', { target: join(dir, 'enclosure-split.dfyom') })
  return { pieces, setups }
}
