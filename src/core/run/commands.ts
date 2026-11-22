/**
 * `run.*` commands and queries: the connection, machine actions, the time scale, tool-change
 * continue and the status query. The run job is in job.ts.
 * Doc: docs/modes/run-v0.1.md#commands-and-queries
 */
import { z } from 'zod'
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import { defineCommand, defineQuery, type AnyCommand, type QueryDef } from '../commands/define'
import type { JobDirectory, Services } from '../commands/context'
import { Quantity } from '../quantity/quantity'
import { loadPlan } from '../plan/plan'
import { PlanIdSchema } from '../plan/plan.dto'
import { setupStockSize } from '../plan/setups'
import type { ProjectDoc } from '../project/document'
import type { Vec3 } from '../toolpath/model'
import { machineSettings } from './grbl/emulator/settings'
import { machineOf, runJobStart } from './job'
import { machineKeyOf } from './machine-key'
import {
  AXES,
  ControllerInfoSchema,
  TimeScaleSchema,
  Vec3Schema,
  type MachineAction,
} from './host/protocol'
import { RunStatusSchema } from './service'

/** Margin between the clearance plane and the top of the machine travel in `prepare` (mm). */
export const PREPARE_TOP_MARGIN = 5

/**
 * Decision 7: G54 (MPos) that puts the plan's stock centred on the table (XY) with the clearance
 * plane `PREPARE_TOP_MARGIN` below the top of the travel. Work zero = stock front-left corner,
 * Z0 on the stock top (docs/modes/plan-v0.1.md#setup-orientation-work-zero-safe-heights), for the
 * first setup: the stock in its orientation (v0.2, task E2; a top setup: length × width).
 */
export function prepareWorkZero(doc: ProjectDoc, planId: string, where: string): AppResult<Vec3> {
  const loaded = loadPlan(doc, planId, where)
  if (loaded.isErr()) return Err(loaded.unwrapErr())
  const plan = loaded.unwrap()
  if (plan.machine.isNone())
    return fail('post.noMachine', 'the plan has no machine', { where, data: { planId } })
  const machine = plan.machine.unwrap()
  const first = plan.setups[0]!
  const clearanceMm = Quantity.fromDTO(first.clearanceHeight).mapOr(0, (q) => q.canonical)
  const size = setupStockSize(plan.stock, first)
  return Ok([
    -machine.travel.x.canonical / 2 - size.x[1] / 2,
    -machine.travel.y.canonical / 2 - size.y[1] / 2,
    -PREPARE_TOP_MARGIN - clearanceMm,
  ])
}

const Empty = z.object({})
const Done = z.object({})

/** Runs a machine action on the open connection. */
async function act(
  services: Services,
  action: MachineAction,
  where: string,
): Promise<AppResult<unknown>> {
  const m = machineOf(services, where)
  if (m.isErr()) return m
  const r = await m.unwrap().machine(action)
  return r.mapErr((e) => e.withContext(where))
}

export const runConnectionOpen = defineCommand({
  kind: 'effect',
  name: 'run.connection.open',
  summary:
    "Connect to the virtual machine, emulating the plan's machine copy; prepare: true homes it at once and centres the stock on the table.",
  title: () => 'Connect to the virtual machine',
  machine: true,
  args: z.object({
    target: z.literal('virtual').describe('Only the virtual machine (GRBL emulator) in v0.1'),
    planId: PlanIdSchema.describe('The plan whose machine copy the virtual machine emulates'),
    homing: z
      .boolean()
      .default(true)
      .describe('Start in Alarm and require homing, as GRBL with $22=1'),
    timeScale: TimeScaleSchema.default(1).describe('1–100 times real time, or max'),
    prepare: z
      .boolean()
      .default(false)
      .describe('Home at once and set the work zero so the stock sits centred on the table'),
  }),
  result: ControllerInfoSchema,
  async run(doc, args, ctx) {
    const where = 'run.connection.open'
    const m = ctx.services.machine
    if (m === undefined) return fail('run.notConnected', 'no machine service', { where })
    if (m.target !== undefined) return fail('run.busy', 'a connection is already open', { where })
    const loaded = loadPlan(doc, args.planId, where)
    if (loaded.isErr()) return loaded
    const machine = loaded.unwrap().machine
    if (machine.isNone())
      return fail('post.noMachine', 'the plan has no machine to emulate', {
        where,
        data: { planId: args.planId },
      })
    const key = machineKeyOf(doc, args.planId, where)
    if (key.isErr()) return key
    let prepare: { workZero: Vec3 } | undefined
    if (args.prepare) {
      const wz = prepareWorkZero(doc, args.planId, where)
      if (wz.isErr()) return wz
      prepare = { workZero: wz.unwrap() }
    }
    const settings = Object.fromEntries(
      Object.entries(machineSettings(machine.unwrap())).map(([k, v]) => [k, v]),
    )
    const info = await m.connect({
      kind: 'virtual',
      settings,
      homing: args.homing,
      timeScale: args.timeScale,
      machineKey: key.unwrap() ?? '',
      ...(prepare === undefined ? {} : { prepare }),
    })
    return info.mapErr((e) => e.withContext(where, { planId: args.planId }))
  },
})

export const runConnectionClose = defineCommand({
  kind: 'effect',
  name: 'run.connection.close',
  summary: 'Close the machine connection (refused while a run job runs).',
  title: () => 'Disconnect',
  machine: true,
  args: Empty,
  result: Done,
  async run(_doc, _args, ctx) {
    const m = ctx.services.machine
    if (m?.target === undefined) return Ok({})
    return (await m.disconnect()).map(() => ({}))
  },
})

export const runMachineHome = defineCommand({
  kind: 'job',
  name: 'run.machine.home',
  summary: 'Home the machine ($H); takes seconds, so it is a job.',
  title: () => 'Home',
  machine: true,
  args: Empty,
  result: z.object({ workZero: Vec3Schema.describe('G54 in machine coordinates (mm)') }),
  async run(_doc, _args, ctx) {
    const r = await act(ctx.services, { kind: 'home' }, 'run.machine.home')
    if (r.isErr()) return r
    return Ok({ workZero: [...(ctx.services.machine?.status().workZero ?? [0, 0, 0])] as Vec3 })
  },
})

export const runMachineUnlock = defineCommand({
  kind: 'effect',
  name: 'run.machine.unlock',
  summary: 'Unlock the machine from Alarm without homing ($X).',
  title: () => 'Unlock',
  machine: true,
  args: Empty,
  result: Done,
  run: async (_doc, _args, ctx) =>
    (await act(ctx.services, { kind: 'unlock' }, 'run.machine.unlock')).map(() => ({})),
})

export const runMachineJog = defineCommand({
  kind: 'effect',
  name: 'run.machine.jog',
  summary:
    'Jog to a machine position (to) or by a distance (by) in mm at feed mm/min; resolves when GRBL accepted it, motion continues.',
  title: () => 'Jog',
  machine: true,
  args: z
    .object({
      to: Vec3Schema.optional().describe('Target in machine coordinates (mm)'),
      by: Vec3Schema.optional().describe('Relative move (mm)'),
      feed: z.number().positive().max(100_000).describe('mm/min'),
    })
    .refine((a) => (a.to === undefined) !== (a.by === undefined), 'give exactly one of to or by'),
  result: Done,
  run: async (_doc, args, ctx) =>
    (
      await act(
        ctx.services,
        {
          kind: 'jog',
          feed: args.feed,
          ...(args.to === undefined ? {} : { to: args.to }),
          ...(args.by === undefined ? {} : { by: args.by }),
        },
        'run.machine.jog',
      )
    ).map(() => ({})),
})

export const runMachineJogCancel = defineCommand({
  kind: 'effect',
  name: 'run.machine.jogCancel',
  summary: 'Cancel a running jog (0x85).',
  title: () => 'Stop jog',
  machine: true,
  urgent: true,
  args: Empty,
  result: Done,
  run: async (_doc, _args, ctx) =>
    (await act(ctx.services, { kind: 'jogCancel' }, 'run.machine.jogCancel')).map(() => ({})),
})

export const runWorkZeroSet = defineCommand({
  kind: 'effect',
  name: 'run.workZero.set',
  summary:
    'Set the work zero (G54) of the given axes at the current position (or so the current position gets values, mm); allowed when Idle and during a tool change.',
  title: () => 'Set work zero',
  machine: true,
  args: z.object({
    axes: z.array(z.enum(AXES)).min(1).max(3).describe('Axes to zero'),
    values: Vec3Schema.optional().describe('Work coordinates of the current position (mm)'),
  }),
  result: z.object({ workZero: Vec3Schema.describe('New G54 in machine coordinates (mm)') }),
  async run(_doc, args, ctx) {
    const r = await act(
      ctx.services,
      {
        kind: 'setWorkZero',
        axes: args.axes,
        ...(args.values === undefined ? {} : { values: args.values }),
      },
      'run.workZero.set',
    )
    if (r.isErr()) return r
    return Ok({ workZero: r.unwrap() as Vec3 })
  },
})

export const runMachineReset = defineCommand({
  kind: 'effect',
  name: 'run.machine.reset',
  summary:
    'Reset the controller at once (0x18): the emergency path; a running job fails, motion in progress raises ALARM:3.',
  title: () => 'Reset machine',
  machine: true,
  urgent: true,
  args: Empty,
  result: Done,
  run: async (_doc, _args, ctx) =>
    (await act(ctx.services, { kind: 'reset' }, 'run.machine.reset')).map(() => ({})),
})

export const runJobContinue = defineCommand({
  kind: 'effect',
  name: 'run.job.continue',
  summary:
    'Continue a run waiting at a tool change (after the new tool is zeroed) or at an M0 pause.',
  title: () => 'Continue run',
  machine: true,
  args: z
    .object({
      jobId: z.string().min(1).describe('Id returned by run.job.start'),
      toolChange: z
        .number()
        .int()
        .optional()
        .describe('At a tool change: its number, from run.status.get job.toolChange.n'),
      pause: z
        .number()
        .int()
        .optional()
        .describe('At a program pause (M0): its number, from run.status.get job.pause'),
    })
    .refine(
      (a) => (a.toolChange === undefined) !== (a.pause === undefined),
      'name the wait to end: toolChange or pause',
    ),
  result: Done,
  async run(_doc, args, ctx) {
    const where = 'run.job.continue'
    const m = machineOf(ctx.services, where)
    if (m.isErr()) return m
    const job = m.unwrap().status().job
    if (job?.jobId !== args.jobId || (job.phase !== 'toolChange' && job.phase !== 'programPause'))
      return fail('run.state', `job ${args.jobId} is not waiting at a tool change or pause`, {
        where,
        data: { state: m.unwrap().status().state, ...(job ? { phase: job.phase } : {}) },
      })
    // the host checks the named wait against the one it is at (a retried continue skips nothing)
    const expect =
      args.toolChange !== undefined ? { toolChange: args.toolChange } : { pause: args.pause ?? 0 }
    return (await m.unwrap().controlJob(args.jobId, 'continue', expect)).map(() => ({}))
  },
})

export const runTimeScaleSet = defineCommand({
  kind: 'effect',
  name: 'run.timeScale.set',
  summary: 'Set the virtual machine time scale: 1–100 times real time or max; also during a run.',
  title: () => 'Set time scale',
  machine: true,
  args: z.object({ scale: TimeScaleSchema.describe('1–100 or max') }),
  result: Done,
  async run(_doc, args, ctx) {
    const m = machineOf(ctx.services, 'run.timeScale.set')
    if (m.isErr()) return m
    return (await m.unwrap().setTimeScale(args.scale)).map(() => ({}))
  },
})

export const runStatusGet = defineQuery({
  name: 'run.status.get',
  summary:
    'Get the machine status: connection, state, homed, positions, work zero, feed, spindle and the running job.',
  args: Empty,
  result: RunStatusSchema,
  readsDocument: false,
  run: (_doc, _args, ctx) =>
    Ok(
      ctx.services.machine?.status() ?? {
        connection: { state: 'closed' as const, timeScale: 1 },
        state: 'Disconnected',
        homed: false,
        mpos: [0, 0, 0] as const,
        wpos: [0, 0, 0] as const,
        workZero: [0, 0, 0] as const,
        feed: 0,
        spindle: 0,
      },
    ),
})

/**
 * A project whose dispatcher runs a run job cannot close (docs/modes/run-v0.1.md#run-job);
 * whoever closes projects (project IPC, tasks 3.x) calls this first.
 */
export function checkNoRunJob(jobs: JobDirectory): AppResult<void> {
  const running = jobs.list().find((j) => j.name === runJobStart.name && j.state !== 'finished')
  if (running === undefined) return Ok(undefined)
  return fail('run.busy', 'a run job is running in this project; stop it first', {
    where: 'project.close',
    data: { jobId: running.id },
  })
}

export const RUN_COMMANDS: readonly AnyCommand[] = [
  runConnectionOpen,
  runConnectionClose,
  runMachineHome,
  runMachineUnlock,
  runMachineJog,
  runMachineJogCancel,
  runWorkZeroSet,
  runMachineReset,
  runJobStart,
  runJobContinue,
  runTimeScaleSet,
]
export const RUN_QUERIES: readonly QueryDef[] = [runStatusGet]
