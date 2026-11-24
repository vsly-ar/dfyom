/**
 * `run.align.goto` and `run.align.tick`: the Run alignment step (hardening DF78, alignment phase
 * 1). Machine commands: the UI on every connection, other sources on the virtual machine only
 * (Q64, the default permission policy). The pointer's moves are jogs (cancelled by the jog cancel
 * and Stop; the host refuses one outside the travel, `run.travel`).
 * Doc: docs/modes/alignment.md#run-the-alignment-step, #commands
 */
import { z } from 'zod'
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import { defineCommand } from '../commands/define'
import { loadPlan } from '../plan/plan'
import { PlanIdSchema, PlanRecordIdSchema } from '../plan/plan.dto'
import { setupWorkholding } from '../plan/workholding/setup'
import {
  alignmentEntries,
  AlignmentStepSchema,
  confirmStep,
  entryTo,
  pointerMoves,
  pointerReady,
  startStep,
  tickEntry,
  type AlignmentStep,
} from './alignment'
import { machineOf } from './job'
import type { MachineService } from './service'

const ALIGN_GOTO = 'run.align.goto'
const ALIGN_TICK = 'run.align.tick'

/** The step of the setup, kept when one runs for it, else a new one (rule `noAlignment`). */
function stepFor(
  m: MachineService,
  doc: Parameters<typeof loadPlan>[0],
  planId: string,
  setupId: string,
  services: { region2d?: Parameters<typeof alignmentEntries>[2] },
): AppResult<{ step: AlignmentStep; clearance: number }> {
  const where = ALIGN_GOTO
  const loaded = loadPlan(doc, planId, where)
  if (loaded.isErr()) return Err(loaded.unwrapErr())
  const plan = loaded.unwrap()
  const setup = plan.setups.find((s) => s.id === setupId)
  if (setup === undefined)
    return fail('input.malformed', `plan ${planId} has no setup ${setupId}`, {
      where,
      issues: [{ path: ['setupId'], rule: 'unknownSetup', message: 'no such setup' }],
    })
  if ((setup.alignment?.length ?? 0) === 0)
    return fail('run.state', `${setup.name} has no alignment points`, {
      where,
      data: { setupId },
      issues: [{ path: ['setupId'], rule: 'noAlignment', message: 'the setup has no points' }],
    })
  // the clearance the program uses: it follows the workholding (workholding.md#links-and-safe-heights)
  const clearance = setupWorkholding(setup, plan.stock).clearance
  const kept = m.alignmentStep()
  if (kept !== undefined && kept.planId === planId && kept.setupId === setupId)
    return Ok({ step: kept, clearance })
  const entries = alignmentEntries(plan, setup, services.region2d)
  return Ok({ step: startStep(planId, setupId, entries, m.status()), clearance })
}

export const runAlignGoto = defineCommand({
  kind: 'effect',
  name: ALIGN_GOTO,
  summary:
    'Alignment step: jog the pointer (spindle off) at clearance height to the zero or a point.',
  title: () => 'Go to alignment point',
  machine: true,
  args: z.object({
    planId: PlanIdSchema,
    setupId: PlanRecordIdSchema,
    to: z.string().min(1).describe("'zero', a point id, 'next', 'previous'"),
  }),
  result: z.object({
    current: z.string(),
    target: z.tuple([z.number(), z.number()]),
  }),
  async run(doc, args, ctx) {
    const where = ALIGN_GOTO
    const machine = machineOf(ctx.services, where)
    if (machine.isErr()) return machine
    const m = machine.unwrap()
    const status = m.status()
    if (status.job !== undefined || status.connection.state !== 'open')
      return fail('run.busy', status.job ? `job ${status.job.jobId} is running` : 'not connected', {
        where,
      })
    const ready = pointerReady(status, where)
    if (ready.isErr()) return ready
    const found = stepFor(m, doc, args.planId, args.setupId, ctx.services)
    if (found.isErr()) return found
    const { step, clearance } = found.unwrap()
    const entry = entryTo(step, args.to)
    if (entry === undefined)
      return fail('input.malformed', `the step has no entry ${args.to}`, {
        where,
        issues: [{ path: ['to'], rule: 'unknownEntry', message: 'not an entry of this step' }],
      })
    m.setAlignmentStep({ ...step, current: entry.id })
    for (const move of pointerMoves(status, entry.target, clearance)) {
      const r = await m.machine({ kind: 'jog', to: [...move.to], feed: move.feed })
      if (r.isErr()) return Err(r.unwrapErr().withContext(where))
    }
    return Ok({ current: entry.id, target: [entry.target[0], entry.target[1]] as [number, number] })
  },
})

export const runAlignTick = defineCommand({
  kind: 'effect',
  name: ALIGN_TICK,
  summary: 'Alignment step: tick or untick an entry (pointer at it), and/or confirm.',
  title: () => 'Check alignment point',
  machine: true,
  args: z
    .object({
      entry: z.string().min(1).optional().describe("'zero' or a point id"),
      ticked: z.boolean().optional(),
      confirm: z.literal(true).optional(),
      skipUnticked: z.literal(true).optional(),
    })
    .refine((a) => a.entry !== undefined || a.confirm === true, 'give entry or confirm'),
  result: AlignmentStepSchema,
  run: async (_doc, args, ctx) => {
    const where = ALIGN_TICK
    const machine = machineOf(ctx.services, where)
    if (machine.isErr()) return machine
    const m = machine.unwrap()
    const step = m.alignmentStep()
    if (step === undefined)
      return fail('run.state', 'no alignment step runs; go to the work zero first', {
        where,
        issues: [{ path: [], rule: 'noAlignment', message: 'start the step with run.align.goto' }],
      })
    let next = step
    if (args.entry !== undefined) {
      const t = tickEntry(next, args.entry, args.ticked ?? true, m.status(), where)
      if (t.isErr()) return t
      next = t.unwrap()
    }
    if (args.confirm === true) {
      const c = confirmStep(next, args.skipUnticked === true, where)
      if (c.isErr()) return c
      next = c.unwrap()
    }
    m.setAlignmentStep(next)
    return Ok(next)
  },
})
