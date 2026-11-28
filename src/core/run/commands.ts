/**
 * `run.*` commands and queries: the connection, machine actions, the time scale, tool-change
 * continue and the status query. The run job is in job.ts.
 * Doc: docs/modes/run-v0.1.md#commands-and-queries
 */
import { z } from 'zod'
import {
  Err,
  fail,
  None,
  Ok,
  Some,
  type AppResult,
  type AsyncAppResult,
  type Option,
} from '../../shared/result'
import { defineCommand, defineQuery, type AnyCommand, type QueryDef } from '../commands/define'
import type { JobContext, JobDirectory, Services } from '../commands/context'
import { loadPlan, snapshotById } from '../plan/plan'
import { PlanIdSchema } from '../plan/plan.dto'
import { setupStockSize } from '../plan/setups'
import { setupZero } from '../plan/alignment'
import type { Region2dPort } from '../geometry/2d/port'
import { setupWorkholding } from '../plan/workholding/setup'
import type { ProjectDoc } from '../project/document'
import type { Vec3 } from '../toolpath/model'
import { machineSettings } from './grbl/emulator/settings'
import { ROUTINE_DEFAULTS } from './probe-routines'
import { STILL_STATES } from './grbl/sender'
import { machineOf, runJobCheck, runJobStart } from './job'
import { machineKeyOf } from './machine-key'
import {
  machineWorkArea,
  WORK_AREA_AXES,
  type WorkAreaMarks,
  type WorkAreaSetting,
} from './work-area'
import { Machine, type WorkArea, type WorkAreaSide } from '../library/machine'
import { collectFields, ItemIdSchema } from '../library/item'
import { hashJson } from '../plan/snapshot'
import {
  AXES,
  ControllerInfoSchema,
  OVERRIDE_STEPS,
  PROBE_DEFAULTS,
  ProbeGeometrySchema,
  ProbeRoutineSchema,
  type RapidOverride,
  TimeScaleSchema,
  Vec3Schema,
  VirtualStockSchema,
  WorkAreaSettingSchema,
  type MachineAction,
} from './host/protocol'
import { overrideCap, overrideLimits } from './override'
import { RunStatusSchema, type MachineService } from './service'
import { runAlignGoto, runAlignTick } from './align-commands'
import { DEFAULT_BAUD, SerialPortInfoSchema } from './serial'
import { settingsCheck, SettingsCheckSchema } from './settings-check'
import type { MachineValuesDTO } from '../library/machine.dto'
import { DEFAULT_SPIN_UP_SECONDS } from '../post/grbl/post'
import { Quantity } from '../quantity/quantity'
import type { QuantityDTO } from '../quantity/quantity.dto'

/** Margin between the clearance plane and the top of the machine travel in `prepare` (mm). */
export const PREPARE_TOP_MARGIN = 5

/**
 * Decision 7: G54 (MPos) that puts the plan's stock centred on the table (XY) with the clearance
 * plane `PREPARE_TOP_MARGIN` below the top of the travel. Work zero = stock front-left corner,
 * Z0 on the stock top (docs/modes/plan-v0.1.md#setup-orientation-work-zero-safe-heights), for the
 * first setup: the stock in its orientation (v0.2, task E2; a top setup: length × width). A moved
 * work zero (alignment phase 1, N5) is added back, so the stock stays centred.
 */
export function prepareWorkZero(
  doc: ProjectDoc,
  planId: string,
  where: string,
  port?: Region2dPort,
): AppResult<Vec3> {
  const loaded = loadPlan(doc, planId, where)
  if (loaded.isErr()) return Err(loaded.unwrapErr())
  const plan = loaded.unwrap()
  if (plan.machine.isNone())
    return fail('post.noMachine', 'the plan has no machine', { where, data: { planId } })
  const machine = plan.machine.unwrap()
  const first = plan.setups[0]!
  // the clearance the program uses (it follows the workholding, workholding.md)
  const clearanceMm = setupWorkholding(first, plan.stock).clearance
  const size = setupStockSize(plan.stock, first)
  const zero = setupZero(plan, first, port)
  return Ok([
    -machine.travel.x.canonical / 2 - size.x[1] / 2 + zero[0],
    -machine.travel.y.canonical / 2 - size.y[1] / 2 + zero[1],
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

/**
 * A machine action run by a job (homing, Probe Z): `job.abort` stops the machine with a reset
 * (`0x18`), as Stop does without a run job (GRBL stops a homing cycle only by a reset, DF35;
 * docs/modes/run.md#1-emergency-stop-stop-and-reset). Before, the abort only marked the job and
 * the cycle ran on (and the job with it) until the machine finished. `holdable` (Probe Z, DF82):
 * `job.pause` is a feed hold, paused once the controller reports `Hold:0`; `job.resume` a cycle
 * start (the job's `handled` pause policy).
 */
async function actStoppable(
  ctx: JobContext,
  action: MachineAction,
  where: string,
  holdable = false,
): Promise<AppResult<unknown>> {
  const m = machineOf(ctx.services, where)
  if (m.isErr()) return m
  if (ctx.signal.aborted) return fail('op.aborted', `${where} was aborted`, { where })
  const machine = m.unwrap()
  const stop = () => void machine.machine({ kind: 'reset' })
  ctx.signal.addEventListener('abort', stop, { once: true })
  let controlling = 0
  const control = async (kind: 'feedHold' | 'cycleStart'): AsyncAppResult<void> => {
    controlling++
    try {
      return (await machine.machine({ kind })).map(() => undefined)
    } finally {
      controlling--
    }
  }
  const offPause = holdable
    ? ctx.onPause({ hold: () => control('feedHold'), resume: () => control('cycleStart') })
    : undefined
  const offAdopt = holdable ? adoptMachineHolds(ctx, machine, () => controlling > 0) : undefined
  try {
    const r = await machine.machine(action)
    return r.mapErr((e) => e.withContext(where))
  } finally {
    offAdopt?.()
    offPause?.()
    ctx.signal.removeEventListener('abort', stop)
  }
}

/**
 * A held manual cycle the job did not hold itself (DF82): the machine's hold button, its safety
 * door. When the machine comes to a standstill in a hold (`Hold:0`, `Door:0`/`Door:1`, entered
 * from another state) the job is paused; when a cycle start the job did not send moves it again
 * (`Run`), it runs. Not while its own `job.pause`/`job.resume` is in flight (`controlling`).
 * Doc: docs/modes/run.md#external-holds-df82
 */
function adoptMachineHolds(
  ctx: JobContext,
  machine: MachineService,
  controlling: () => boolean,
): () => void {
  let wasStill = STILL_STATES.has(machine.status().state)
  return machine.onStatus((s) => {
    const still = STILL_STATES.has(s.state)
    if (!controlling()) {
      if (still && !wasStill && !ctx.pause.paused) ctx.adoptPause(true)
      else if (s.state.startsWith('Run') && ctx.pause.paused) ctx.adoptPause(false)
    }
    wasStill = still
  })
}

/**
 * The machine a connection emulates: the plan's machine copy or a library machine (DF31,
 * docs/modes/run.md#connect-without-a-plan-df31), with its identity (machine key).
 */
function connectionMachine(
  doc: ProjectDoc,
  services: Services,
  args: { planId?: string | undefined; machineId?: string | undefined },
  where: string,
): AppResult<{ machine: Machine; key: string; libraryId?: string; workArea?: WorkAreaSetting }> {
  if ((args.planId === undefined) === (args.machineId === undefined))
    return fail('input.malformed', 'give exactly one of planId or machineId', {
      where,
      issues: [{ path: ['planId'], rule: 'oneOf', message: 'give planId or machineId' }],
    })
  if (args.planId !== undefined) {
    const planId = args.planId
    const loaded = loadPlan(doc, planId, where)
    if (loaded.isErr()) return Err(loaded.unwrapErr())
    const machine = loaded.unwrap().machine
    if (machine.isNone())
      return fail('post.noMachine', 'the plan has no machine to emulate', {
        where,
        data: { planId },
      })
    // v0.5 RV7: the work area is the shop's measurement: the library machine's, else the copy's
    const plan = doc.plans[planId]
    const copy = plan?.machine === undefined ? undefined : snapshotById(plan, plan.machine)
    const libraryId = copy?.libraryItemId
    const found =
      libraryId === undefined ? undefined : services.library?.lookup('machine', libraryId)
    const lib =
      found?.state === 'found' && found.item.values instanceof Machine
        ? found.item.values
        : undefined
    const workArea = machineWorkArea(lib ?? machine.unwrap())
    return machineKeyOf(doc, planId, where).map((key) => ({
      machine: machine.unwrap(),
      key: key ?? '',
      ...(libraryId === undefined ? {} : { libraryId }),
      ...(workArea === undefined ? {} : { workArea }),
    }))
  }
  const id = args.machineId!
  const lib = services.library
  if (lib === undefined) return fail('internal.unexpected', 'no library service', { where })
  const found = lib.lookup('machine', id)
  if (found.state !== 'found' || !(found.item.values instanceof Machine))
    return fail('input.malformed', `machine ${id} does not exist or does not load`, {
      where,
      issues: [{ path: ['machineId'], rule: 'unknownItem', message: 'no such library machine' }],
    })
  const machine = found.item.values
  const workArea = machineWorkArea(machine)
  // the same hash a plan's unchanged snapshot of this machine has (machine-key.ts)
  return Ok({
    machine,
    key: hashJson(machine.toDTO()),
    libraryId: id,
    ...(workArea === undefined ? {} : { workArea }),
  })
}

export const runConnectionOpen = defineCommand({
  kind: 'effect',
  name: 'run.connection.open',
  summary:
    "Connect to the virtual machine, emulating the plan's machine copy (planId) or a library machine (machineId, no plan needed); prepare: true (plans only) homes it at once and centres the stock on the table. target 'serial' (a real GRBL controller on path) is for the user in the app only.",
  title: (a) =>
    (a as { target?: string }).target === 'serial'
      ? 'Connect to the machine'
      : 'Connect to the virtual machine',
  machine: true,
  args: z.object({
    target: z
      .enum(['virtual', 'serial'])
      .describe('virtual: the GRBL emulator; serial: a real controller (UI only)'),
    path: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Serial port path from run.ports.scan (target serial)'),
    baud: z
      .number()
      .int()
      .min(300)
      .max(4_000_000)
      .default(DEFAULT_BAUD)
      .describe('Baud rate (target serial)'),
    planId: PlanIdSchema.optional().describe(
      'The plan whose machine copy the virtual machine emulates; or give machineId',
    ),
    machineId: ItemIdSchema.optional().describe(
      'A library machine to emulate without a plan (manual control); or give planId',
    ),
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
  result: ControllerInfoSchema.extend({
    settingsCheck: SettingsCheckSchema.optional().describe(
      "Serial: the controller's $$ against the machine copy; a real run needs matches",
    ),
  }),
  async run(doc, args, ctx) {
    const where = 'run.connection.open'
    const m = ctx.services.machine
    if (m === undefined) return fail('run.notConnected', 'no machine service', { where })
    if (m.target !== undefined) return fail('run.busy', 'a connection is already open', { where })
    const chosen = connectionMachine(doc, ctx.services, args, where)
    if (chosen.isErr()) return chosen
    const { machine, key, libraryId, workArea } = chosen.unwrap()
    // the spindle override's floor (docs/modes/run-machine.md#overrides-m6); a manual spindle
    // ignores S and has no spindle override
    // DF93: the machine values too, for a file run's settings check on a real connection
    const profile = {
      spindleMinSpeed:
        machine.spindle.control === 'gcode'
          ? machine.spindle.minSpeed.mapOr(undefined, (q) => q.canonical)
          : undefined,
      machine: machine.toDTO() as MachineValuesDTO,
      ...(libraryId === undefined ? {} : { libraryMachineId: libraryId }),
      ...(workArea === undefined ? {} : { workArea }),
    }
    const ctxData =
      args.planId === undefined ? { machineId: args.machineId } : { planId: args.planId }
    if (args.target === 'serial') {
      if (args.path === undefined)
        return fail('input.malformed', 'a serial connection needs the port path', {
          where,
          issues: [{ path: ['path'], rule: 'required', message: 'give the port path' }],
        })
      if (args.prepare)
        return fail('input.malformed', 'prepare is for the virtual machine only', {
          where,
          issues: [{ path: ['prepare'], rule: 'virtualOnly', message: 'not for a real machine' }],
        })
      const info = await m.connect(
        { kind: 'serial', path: args.path, baud: args.baud, machineKey: key },
        profile,
      )
      if (info.isErr()) return Err(info.unwrapErr().withContext(where, ctxData))
      const check = settingsCheck(
        machine.toDTO() as MachineValuesDTO,
        info.unwrap().settings,
        args.planId === undefined ? 'machine' : 'plan',
      )
      return Ok({ ...info.unwrap(), settingsCheck: check })
    }
    let prepare: { workZero: Vec3 } | undefined
    if (args.prepare) {
      if (args.planId === undefined)
        return fail('input.malformed', 'prepare needs a plan (its stock)', {
          where,
          issues: [{ path: ['prepare'], rule: 'needsPlan', message: 'prepare needs planId' }],
        })
      const wz = prepareWorkZero(doc, args.planId, where, ctx.services.region2d)
      if (wz.isErr()) return wz
      prepare = { workZero: wz.unwrap() }
    }
    const settings = Object.fromEntries(
      Object.entries(machineSettings(machine)).map(([k, v]) => [k, v]),
    )
    const t = machine.travel
    const position: Vec3 = [-t.x.canonical / 2, -t.y.canonical / 2, -t.z.canonical / 2]
    const info = await m.connect(
      {
        kind: 'virtual',
        settings,
        homing: args.homing,
        timeScale: args.timeScale,
        machineKey: key,
        // powers up at the centre of its travel (grbl.md#homing-and-machine-coordinates)
        ...(args.homing ? { position } : {}),
        ...(prepare === undefined ? {} : { prepare }),
      },
      profile,
    )
    return info.mapErr((e) => e.withContext(where, ctxData))
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
  // GRBL ignores a feed hold during a homing cycle (DF82): only Stop (a reset) stops it
  pause: { kind: 'refuse', message: "Homing can't be paused; use Stop (it resets the controller)" },
  args: Empty,
  result: z.object({ workZero: Vec3Schema.describe('G54 in machine coordinates (mm)') }),
  async run(_doc, _args, ctx) {
    const r = await actStoppable(ctx, { kind: 'home' }, 'run.machine.home')
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
    'Jog to a machine position (to) or by a distance (by) in mm at feed mm/min, or continuously to the travel edge (continuous); resolves when GRBL accepted it, motion continues.',
  title: () => 'Jog',
  machine: true,
  args: z
    .object({
      to: Vec3Schema.optional().describe('Target in machine coordinates (mm)'),
      by: Vec3Schema.optional().describe('Relative move (mm)'),
      feed: z.number().positive().max(100_000).describe('mm/min'),
      continuous: z
        .boolean()
        .optional()
        .describe(
          'Hold to jog: with by (one axis, its sign the direction) move to the travel edge until run.machine.jogCancel',
        ),
    })
    .refine((a) => (a.to === undefined) !== (a.by === undefined), 'give exactly one of to or by')
    .refine((a) => a.continuous !== true || a.by !== undefined, 'a continuous jog takes by'),
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
          ...(args.continuous === true ? { continuous: true } : {}),
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
      jobId: z.string().min(1).optional().describe('Id from run.job.start; default: the run'),
      toolChange: z
        .number()
        .int()
        .optional()
        .describe('Tool change number (job.toolChange.n); default: the current wait'),
      pause: z
        .number()
        .int()
        .optional()
        .describe('Program pause (M0) number (job.pause); default: the current wait'),
    })
    .refine(
      (a) => a.toolChange === undefined || a.pause === undefined,
      'name one wait to end: toolChange or pause',
    ),
  result: z
    .object({
      jobId: z.string(),
      toolChange: z.number().int().optional(),
      pause: z.number().int().optional(),
    })
    .describe('The wait that was ended'),
  async run(_doc, args, ctx) {
    const where = 'run.job.continue'
    const m = machineOf(ctx.services, where)
    if (m.isErr()) return m
    const job = m.unwrap().status().job
    const waiting = job?.phase === 'toolChange' || job?.phase === 'programPause'
    if (job === undefined || !waiting || (args.jobId !== undefined && job.jobId !== args.jobId))
      return fail(
        'run.state',
        args.jobId === undefined
          ? 'no run is waiting at a tool change or pause'
          : `job ${args.jobId} is not waiting at a tool change or pause`,
        {
          where,
          issues: [
            {
              path: args.jobId === undefined ? [] : ['jobId'],
              rule: 'notWaiting',
              message:
                'call job_wait { jobId } until it returns waiting, or run_status_get for the phase',
            },
          ],
          data: { state: m.unwrap().status().state, ...(job ? { phase: job.phase } : {}) },
        },
      )
    // Defaults: the wait the run is at (llm-api.md#a2-jobwait-at-operator-waits). The host
    // checks a named wait against the one it is at, so a retried continue naming it skips nothing.
    const expect =
      args.toolChange !== undefined
        ? { toolChange: args.toolChange }
        : args.pause !== undefined
          ? { pause: args.pause }
          : job.phase === 'toolChange'
            ? { toolChange: job.toolChange?.n ?? 0 }
            : { pause: job.pause ?? 0 }
    return (await m.unwrap().controlJob(job.jobId, 'continue', expect)).map(() => ({
      jobId: job.jobId,
      ...expect,
    }))
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

export const runPortsScan = defineCommand({
  kind: 'effect',
  name: 'run.ports.scan',
  summary:
    'List serial ports (USB first) for run.connection.open { target: serial }. Opens nothing.',
  title: () => 'Scan serial ports',
  machine: false,
  args: Empty,
  result: z.object({ ports: z.array(SerialPortInfoSchema) }),
  async run(_doc, _args, ctx) {
    const where = 'run.ports.scan'
    const m = ctx.services.machine
    if (m === undefined) return fail('machine.connection', 'no machine service', { where })
    return (await m.listPorts()).map((ports) => ({ ports })).mapErr((e) => e.withContext(where))
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
 * The settings check again, against the machine as it is now (DF87): the window re-asks after a
 * library or plan change, so a fixed machine clears the warning without reconnecting.
 * Doc: docs/modes/run-machine.md#settings-check
 */
export const runSettingsCheck = defineQuery({
  name: 'run.settings.check',
  summary:
    "A serial connection's settings check now: the controller's $$ against the plan's machine copy (planId) or a library machine (machineId); none without a serial connection.",
  args: z.object({
    planId: PlanIdSchema.optional(),
    machineId: ItemIdSchema.optional(),
  }),
  result: z.object({
    settingsCheck: SettingsCheckSchema.optional(),
    /**
     * v0.5 RV2: the open connection's `$$` by setting number, on any connection (the Run
     * inspector's controller settings table, docs/conventions/ui.md#run-settings-v05-rv2).
     */
    settings: z.record(z.string(), z.number()).optional(),
  }),
  run(doc, args, ctx) {
    const m = ctx.services.machine
    const settings = m?.controllerSettings
    if (settings === undefined) return Ok({})
    const all = { settings: { ...settings } }
    if (m?.target !== 'serial' || (args.planId === undefined && args.machineId === undefined))
      return Ok(all)
    const chosen = connectionMachine(doc, ctx.services, args, 'run.settings.check')
    if (chosen.isErr()) return Err(chosen.unwrapErr())
    const against = args.planId === undefined ? 'machine' : 'plan'
    const values = chosen.unwrap().machine.toDTO() as MachineValuesDTO
    return Ok({ ...all, settingsCheck: settingsCheck(values, settings, against) })
  },
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

export const runMachineProbeZ = defineCommand({
  kind: 'job',
  name: 'run.machine.probeZ',
  summary:
    'Touch plate: probe Z down (G38.2), set G54 Z so the plate top is Z = plateThickness, retract. Idle or at a tool change. A miss is ALARM:5.',
  title: () => 'Probe Z',
  machine: true,
  // job.pause is a feed hold, paused once the controller reports Hold:0 (DF82)
  pause: { kind: 'handled' },
  args: z.object({
    plateThickness: z.number().positive().max(100).describe('mm (machine probePlateThickness)'),
    maxTravel: z
      .number()
      .positive()
      .max(1000)
      .optional()
      .describe(`mm down at most, default ${PROBE_DEFAULTS.maxTravel}`),
    feed: z
      .number()
      .positive()
      .max(10_000)
      .optional()
      .describe(`mm/min, default ${PROBE_DEFAULTS.feed}`),
    retract: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(`mm lift after contact, default ${PROBE_DEFAULTS.retract}`),
  }),
  result: z.object({
    workZero: Vec3Schema.describe('New G54, MPos mm'),
    contact: Vec3Schema.describe('Contact, MPos mm'),
  }),
  async run(_doc, args, ctx) {
    const r = await actStoppable(
      ctx,
      {
        kind: 'probeZ',
        plateThickness: args.plateThickness,
        maxTravel: args.maxTravel ?? PROBE_DEFAULTS.maxTravel,
        feed: args.feed ?? PROBE_DEFAULTS.feed,
        retract: args.retract ?? PROBE_DEFAULTS.retract,
      },
      'run.machine.probeZ',
      true,
    )
    if (r.isErr()) return r
    return Ok(r.unwrap() as { workZero: Vec3; contact: Vec3 })
  },
})

const ProbedValueSchema = z.object({ value: z.number(), uncertainty: z.number() })
const ProbeRoutineResultSchema = z.object({
  cycle: z.enum(['edge', 'corner', 'centre']),
  top: ProbedValueSchema.optional(),
  x: ProbedValueSchema.optional(),
  y: ProbedValueSchema.optional(),
  centre: z
    .object({ x: ProbedValueSchema, y: ProbedValueSchema, diameter: ProbedValueSchema })
    .optional(),
  start: Vec3Schema,
})

/**
 * v0.5 RV4: an edge, corner or centre probing routine (docs/modes/run-probing.md#xy-probing-rv4):
 * results in machine coordinates with the probe's radius and the plate's offsets applied; writes
 * nothing (Set X/Y zero writes, RV5). A job like Probe Z (a feed hold pauses it; Stop resets). Not
 * an agent tool (Q229).
 */
export const runMachineProbe = defineCommand({
  kind: 'job',
  name: 'run.machine.probe',
  summary:
    'Probe an X/Y edge, a corner (Z, X, Y) or a hole/boss centre from here; results in MPos, nothing written.',
  title: () => 'Probe',
  machine: true,
  agentTool: false,
  pause: { kind: 'handled' },
  args: z.object({
    routine: ProbeRoutineSchema,
    probe: ProbeGeometrySchema,
    reach: z.number().positive().max(1000).optional(),
    zDistance: z.number().positive().max(1000).optional(),
    depth: z.number().positive().max(100).optional(),
    clearance: z.number().positive().max(100).optional(),
    fastFeed: z.number().positive().max(10_000).optional(),
    slowFeed: z.number().positive().max(10_000).optional(),
    moveFeed: z.number().positive().max(10_000).optional(),
    plateSize: z.number().positive().max(1000).optional(),
  }),
  result: ProbeRoutineResultSchema,
  async run(_doc, args, ctx) {
    const d = ROUTINE_DEFAULTS
    const r = await actStoppable(
      ctx,
      {
        kind: 'probeRoutine',
        routine: args.routine,
        probe: args.probe,
        reach: args.reach ?? d.reach,
        zDistance: args.zDistance ?? d.zDistance,
        depth: args.depth ?? d.depth,
        clearance: args.clearance ?? d.clearance,
        fastFeed: args.fastFeed ?? d.fastFeed,
        slowFeed: args.slowFeed ?? d.slowFeed,
        moveFeed: args.moveFeed ?? d.moveFeed,
        ...(args.plateSize === undefined ? {} : { plateSize: args.plateSize }),
      },
      'run.machine.probe',
      true,
    )
    if (r.isErr()) return r
    return Ok(r.unwrap() as z.output<typeof ProbeRoutineResultSchema>)
  },
})

/**
 * v0.5 RV5 (virtual machine only): the stock the virtual operator laid, in machine coordinates,
 * and whether it closes the probe input while touched (the touch-off's readout;
 * docs/modes/run-probing.md#implementation-rv5). Not an agent tool.
 */
export const runVirtualStock = defineCommand({
  kind: 'effect',
  name: 'run.virtual.stock',
  summary: 'Virtual machine only: lay a stock (MPos box) for probing and the touch readout.',
  title: () => 'Virtual stock',
  machine: false,
  agentTool: false,
  args: z.object({
    stock: VirtualStockSchema.optional(),
    touch: z.boolean(),
    toolDiameter: z.number().nonnegative().max(100).optional(),
  }),
  result: Done,
  async run(_doc, args, ctx) {
    const r = await act(
      ctx.services,
      {
        kind: 'virtualStock',
        ...(args.stock === undefined ? {} : { stock: args.stock }),
        touch: args.touch,
        ...(args.toolDiameter === undefined ? {} : { toolDiameter: args.toolDiameter }),
      },
      'run.virtual.stock',
    )
    return r.map(() => ({}))
  },
})

/** A length quantity of `mm`, 3 decimals (a marked machine position or the margin). */
function mmQuantity(mm: number): AppResult<Quantity> {
  return Quantity.parse(mm.toFixed(3), { kind: 'length', defaultUnit: 'mm' })
}

const optionalMm = (mm: number | undefined): AppResult<Option<Quantity>> =>
  mm === undefined ? Ok(None) : mmQuantity(mm).map((q): Option<Quantity> => Some(q))

/** v0.5 RV7: marks (mm) as the library machine's `workArea` (lengths). */
function workAreaModel(marks: WorkAreaMarks): AppResult<WorkArea> {
  const out: Record<string, WorkAreaSide> = {}
  for (const a of WORK_AREA_AXES) {
    const m = marks[a]
    if (m === undefined || (m.min === undefined && m.max === undefined)) continue
    const side = collectFields({ min: optionalMm(m.min), max: optionalMm(m.max) })
    if (side.isErr()) return Err(side.unwrapErr())
    out[a] = side.unwrap()
  }
  return Ok(out)
}

/**
 * v0.5 RV7: the work area of a library machine (docs/modes/run.md#work-area-rv7): the marks
 * (machine coordinates, mm; `null` clears them) and the margin, written to the library machine;
 * the open connection made for that machine follows at once. Moves nothing. Not an agent tool
 * (Q229).
 */
export const runWorkAreaSet = defineCommand({
  kind: 'effect',
  name: 'run.workArea.set',
  summary: "Set or clear a library machine's work area marks (MPos, mm) and margin.",
  title: (a) => (a.marks === null ? 'Clear work area' : 'Set work area'),
  machine: true,
  agentTool: false,
  args: z.object({
    machineId: ItemIdSchema,
    revision: z.number().int().min(1).describe('Revision you read; stale: command.conflict'),
    marks: WorkAreaSettingSchema.shape.marks.nullable().optional(),
    margin: z.number().min(0).max(100).optional(),
  }),
  result: z.object({ revision: z.number().int() }),
  async run(_doc, args, ctx) {
    const where = 'run.workArea.set'
    const lib = ctx.services.library
    if (lib === undefined) return fail('internal.unexpected', 'no library service', { where })
    const found = lib.lookup('machine', args.machineId)
    if (found.state !== 'found' || !(found.item.values instanceof Machine))
      return fail('input.malformed', `machine ${args.machineId} does not exist or does not load`, {
        where,
        issues: [{ path: ['machineId'], rule: 'unknownItem', message: 'no such library machine' }],
      })
    const machine = found.item.values
    const patch: { workArea?: Option<WorkArea>; workAreaMargin?: Option<Quantity> } = {}
    if (args.marks === null) patch.workArea = None
    else if (args.marks !== undefined) {
      const area = workAreaModel(args.marks)
      if (area.isErr()) return Err(area.unwrapErr().withContext(where))
      patch.workArea = Object.keys(area.unwrap()).length === 0 ? None : Some(area.unwrap())
    }
    if (args.margin !== undefined) {
      const q = mmQuantity(args.margin)
      if (q.isErr()) return Err(q.unwrapErr().withContext(where))
      patch.workAreaMargin = Some(q.unwrap())
    }
    const next = machine.with(patch)
    if (next.isErr()) return Err(next.unwrapErr().prefixIssues('values').withContext(where))
    const item = await lib.update(
      args.machineId,
      args.revision,
      next.unwrap(),
      new Date(ctx.clock.now()).toISOString(),
    )
    if (item.isErr()) return Err(item.unwrapErr().withContext(where))
    const m = ctx.services.machine
    if (m?.target !== undefined && m.libraryMachineId === args.machineId) {
      const area = machineWorkArea(next.unwrap())
      const r = await m.machine({ kind: 'workArea', ...(area === undefined ? {} : { area }) })
      if (r.isErr()) return Err(r.unwrapErr().withContext(where))
    }
    return Ok({ revision: item.unwrap().revision })
  },
})

/**
 * RV1: the spindle from Run (docs/modes/run-machine.md#spindle-while-jogging-rv1). On: Idle only
 * (in a jog a speed change through the spindle override), a G-code spindle, no laser mode, rpm in
 * the machine's minSpeed–maxSpeed. Off: always (a jog is cancelled first). Not an agent tool (Q229).
 */
export const runMachineSpindle = defineCommand({
  kind: 'effect',
  name: 'run.machine.spindle',
  summary:
    'Spindle on at rpm (Idle only; while jogging a speed change through the override) or off (cancels a jog first).',
  title: (a) => (a.on ? 'Start spindle' : 'Stop spindle'),
  machine: true,
  agentTool: false,
  args: z
    .object({
      on: z.boolean(),
      rpm: z.number().positive().max(1_000_000).optional().describe('rpm, with on'),
    })
    .refine((a) => !a.on || a.rpm !== undefined, {
      message: 'spindle on needs rpm',
      path: ['rpm'],
    }),
  result: z.object({ spindle: z.number().describe('rpm reported after it, 0 = off') }),
  async run(_doc, args, ctx) {
    const where = 'run.machine.spindle'
    if (!args.on) {
      const r = await act(ctx.services, { kind: 'spindle', on: false }, where)
      return r.map((v) => v as { spindle: number })
    }
    const m = machineOf(ctx.services, where)
    if (m.isErr()) return Err(m.unwrapErr())
    const service = m.unwrap()
    const values = service.connectedMachine
    const refused = (message: string, rule: string) =>
      fail('run.state', message, {
        where,
        data: { state: service.status().state },
        issues: [{ path: ['on'], rule, message }],
      })
    if (values?.spindle.control !== 'gcode')
      return refused(
        'the spindle speed is set by hand: switch the router on and off at the router',
        'manualSpindle',
      )
    if (service.status().laserMode === true)
      return refused('the controller is in laser mode ($32=1): no spindle control', 'laserMode')
    const speed = (dto: unknown) => {
      const q = dto === undefined ? undefined : Quantity.fromDTO(dto as QuantityDTO)
      return q !== undefined && q.isOk() ? q.unwrap().canonical : undefined
    }
    const min = speed(values.spindle.minSpeed) ?? 0
    const max = speed(values.spindle.maxSpeed) ?? Number.POSITIVE_INFINITY
    const rpm = args.rpm ?? 0
    if (rpm < min - 1e-9 || rpm > max + 1e-9) {
      const message = `between ${min} and ${max} rpm`
      return fail('input.malformed', `${rpm} rpm is outside the spindle's speed range`, {
        where,
        issues: [{ path: ['rpm'], rule: 'spindleRange', message }],
      })
    }
    const r = await act(
      ctx.services,
      { kind: 'spindle', on: true, rpm, dwellSeconds: DEFAULT_SPIN_UP_SECONDS },
      where,
    )
    return r.map((v) => v as { spindle: number })
  },
})

const OverridesResult = z.object({
  overrides: z
    .object({ feed: z.number(), rapid: z.number(), spindle: z.number() })
    .optional()
    .describe('% as reported'),
})

/** A step, or a target percent the host reaches in steps (DF85); the host checks the range. */
const OverrideArg = z.union([z.enum(OVERRIDE_STEPS), z.number().int()])

/**
 * The spindle override's floor (DF86 follow-up, docs/modes/run-machine.md#overrides-m6): a
 * target, or a −10/−1 step from the reported value, that takes the programmed S of the running
 * program below the machine's usable minimum speed is refused (`overrideRange`), for the UI and
 * agents alike. Without a programmed S (no run, spindle off) or a minimum speed nothing is checked.
 */
function spindleFloor(
  services: Services,
  arg: z.output<typeof OverrideArg> | undefined,
  where: string,
): AppResult<void> {
  const m = services.machine
  if (arg === undefined || m === undefined) return Ok(undefined)
  const minSpeed = m.spindleMinSpeed
  const status = m.status()
  const s = status.job?.programmed?.spindle
  const cap = overrideCap(overrideLimits('grbl').spindle, s, undefined, minSpeed)
  if (cap.floorBy !== 'machine' || minSpeed === undefined || s === undefined) return Ok(undefined)
  const current = status.overrides?.spindle
  const target =
    typeof arg === 'number'
      ? arg
      : current === undefined
        ? undefined
        : arg === '-10'
          ? current - 10
          : arg === '-1'
            ? current - 1
            : undefined
  if (target === undefined || target >= cap.min) return Ok(undefined)
  return fail('input.malformed', `spindle override ${target} % is below the floor`, {
    where,
    issues: [
      {
        path: ['spindle'],
        rule: 'overrideRange',
        message: `at least ${cap.min} %: S ${s} × ${target} % is below the spindle's minimum speed (minSpeed ${minSpeed} rpm)`,
      },
    ],
  })
}

/**
 * Per given override, in the order feed, spindle, rapid: one real-time byte for a step, the
 * steps to a target percent (DF85, docs/modes/run-machine.md#overrides-m6).
 */
export const runOverrideSet = defineCommand({
  kind: 'effect',
  name: 'run.override.set',
  summary:
    'Feed/spindle override: a target % (GRBL 10–200), reset (100 %), ±10 or ±1 %; rapids 100, 50 or 25 %.',
  title: () => 'Override',
  machine: true,
  urgent: true,
  args: z.object({
    feed: OverrideArg.optional(),
    spindle: OverrideArg.optional(),
    rapid: z.union([z.literal(100), z.literal(50), z.literal(25)]).optional(),
  }),
  result: OverridesResult,
  async run(_doc, args, ctx) {
    const where = 'run.override.set'
    const actions: MachineAction[] = []
    for (const which of ['feed', 'spindle'] as const) {
      const v = args[which]
      if (typeof v === 'number') actions.push({ kind: 'overrideTo', which, percent: v })
      else if (v !== undefined) actions.push({ kind: 'override', which, action: v })
    }
    if (args.rapid !== undefined)
      actions.push({
        kind: 'override',
        which: 'rapid',
        action: String(args.rapid) as RapidOverride,
      })
    if (actions.length === 0)
      return fail('input.malformed', 'give feed, spindle or rapid', {
        where,
        issues: [{ path: ['feed'], rule: 'required', message: 'give feed, spindle or rapid' }],
      })
    const floor = spindleFloor(ctx.services, args.spindle, where)
    if (floor.isErr()) return floor
    let last: unknown = {}
    for (const a of actions) {
      const r = await act(ctx.services, a, where)
      if (r.isErr()) return r
      last = r.unwrap()
    }
    return Ok(last as z.output<typeof OverridesResult>)
  },
})

export const RUN_COMMANDS: readonly AnyCommand[] = [
  runConnectionOpen,
  runConnectionClose,
  runPortsScan,
  runMachineHome,
  runMachineUnlock,
  runMachineJog,
  runMachineJogCancel,
  runWorkZeroSet,
  runMachineReset,
  runMachineProbeZ,
  runMachineProbe,
  runVirtualStock,
  runWorkAreaSet,
  runMachineSpindle,
  runOverrideSet,
  runAlignGoto,
  runAlignTick,
  runJobStart,
  runJobCheck,
  runJobContinue,
  runTimeScaleSet,
]
export const RUN_QUERIES: readonly QueryDef[] = [runStatusGet, runSettingsCheck]

/**
 * The run commands that read no document: manual machine control, which needs no project
 * (hardening DF80). The machine-scope dispatcher runs them for sessions without a bound project
 * (docs/architecture/llm-api.md#machine-scope-df80); `run.connection.open` there takes
 * `machineId` only. Plan runs (`run.job.start`, `run.job.check`) and `run.align.*` need a project;
 * a gCode file run (`file`, DF93) does not.
 */
export const MANUAL_RUN_COMMANDS: readonly AnyCommand[] = [
  runConnectionOpen,
  runConnectionClose,
  runPortsScan,
  runMachineHome,
  runMachineUnlock,
  runMachineJog,
  runMachineJogCancel,
  runWorkZeroSet,
  runMachineReset,
  runMachineProbeZ,
  runMachineProbe,
  runVirtualStock,
  runWorkAreaSet,
  runMachineSpindle,
  runOverrideSet,
  runJobContinue,
  runTimeScaleSet,
  // DF93: with `file` only (`planId` answers noProject before it gets here)
  runJobStart,
  runJobCheck,
]
