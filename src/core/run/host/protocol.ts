/**
 * Message protocol between main (`MachineClient`) and the machine host (utility process in the
 * app, `worker_threads` headless, in-process in tests), as Zod discriminated unions on `type`;
 * parsed on every receipt on both sides. Doc: docs/modes/run-v0.1.md#machine-host-and-protocol
 */
import { z } from 'zod'
import { ResultWireSchema } from '../../../shared/errors/schema'
import { LOG_LEVELS } from '../../../shared/logging'
import { MAX_TIME_SCALE } from '../clock'

export const PROTOCOL_VERSION = 1

const Id = z.string().min(1).max(200)
const Num = z.number().refine(Number.isFinite, 'must be finite')
export const Vec3Schema = z.tuple([Num, Num, Num]).readonly()
export const TimeScaleSchema = z.union([z.number().min(1).max(MAX_TIME_SCALE), z.literal('max')])

/** The program a job streams (docs/modes/run-v0.1.md#sender). */
export const SenderProgramSchema = z.object({
  lines: z.array(z.string().max(1000)).max(2_000_000),
  sections: z.array(z.object({ fromLine: z.number().int().min(1), label: z.string().max(500) })),
})

export const RUN_PHASES = [
  'streaming',
  'held',
  'programPause',
  'toolChange',
  'stopping',
  'done',
  'failed',
  'stopped',
] as const

export const ToolChangeSchema = z.object({ n: z.number().int(), name: z.string().max(500) })

export const RunSummarySchema = z.object({
  lines: z.number().int(),
  seconds: Num,
  elapsedSeconds: Num,
  toolChanges: z.number().int(),
  pauses: z.number().int(),
})

export const ControllerInfoSchema = z.object({
  /** What the host connected to (reported by the host, never assumed by main). */
  target: z.literal('virtual'),
  version: z.string(),
  settings: z.record(z.string(), Num),
  workZero: Vec3Schema,
  modes: z.array(z.string()).readonly(),
  homed: z.boolean(),
})
export type ConnectedInfo = z.output<typeof ControllerInfoSchema>

/** What the host knows about the machine; main adds the connection and the job's start time. */
export const HostStatusSchema = z.object({
  /** GRBL's state as reported, e.g. `Hold:0`. */
  state: z.string().max(50),
  homed: z.boolean(),
  mpos: Vec3Schema,
  wpos: Vec3Schema,
  /** G54 in machine coordinates (mm). */
  workZero: Vec3Schema,
  /** mm/min. */
  feed: Num,
  spindle: Num,
  buffer: z.object({ blocks: z.number(), rx: z.number() }).exactOptional(),
  alarm: z.object({ code: z.number().int(), text: z.string() }).exactOptional(),
  lastMessage: z.string().max(500).exactOptional(),
  timeScale: TimeScaleSchema,
  job: z
    .object({
      jobId: Id,
      phase: z.enum(RUN_PHASES),
      /** 1-based line being executed (last acknowledged + 1). */
      line: z.number().int(),
      toolChange: ToolChangeSchema.exactOptional(),
      /** In `programPause`: which pause (1-based) `run.job.continue` ends. */
      pause: z.number().int().exactOptional(),
      elapsedSeconds: Num,
    })
    .exactOptional(),
})
export type HostStatus = z.output<typeof HostStatusSchema>

// ── main → host ───────────────────────────────────────────────────────────────────────────

export const VirtualTargetSchema = z.object({
  kind: z.literal('virtual'),
  /** GRBL settings by number (`machineSettings(machine)`). */
  settings: z.record(z.string().regex(/^\d+$/), Num),
  /** `$22`: start in Alarm and require `$H`. */
  homing: z.boolean(),
  timeScale: TimeScaleSchema,
  /** Identity of the machine copy emulated (decision 6); a job must name the same. */
  machineKey: z.string().max(200),
  /** Home at `max` speed, then set G54 to this MPos (docs/modes/run-v0.1.md decision 7). */
  prepare: z.object({ workZero: Vec3Schema }).exactOptional(),
})
export type VirtualTarget = z.output<typeof VirtualTargetSchema>

export const AXES = ['x', 'y', 'z'] as const

export const MachineActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('home') }),
  z.object({ kind: z.literal('unlock') }),
  z.object({
    kind: z.literal('jog'),
    /** Machine coordinates (mm) or a relative move (mm); exactly one. */
    to: Vec3Schema.exactOptional(),
    by: Vec3Schema.exactOptional(),
    /** mm/min. */
    feed: z.number().positive().max(1e6),
  }),
  z.object({ kind: z.literal('jogCancel') }),
  z.object({
    kind: z.literal('setWorkZero'),
    axes: z.array(z.enum(AXES)).min(1).max(3).readonly(),
    /** WPos the current position gets (mm); default 0 on each axis. */
    values: Vec3Schema.exactOptional(),
  }),
  z.object({ kind: z.literal('reset') }),
])
export type MachineAction = z.output<typeof MachineActionSchema>

export const JOB_CONTROLS = ['hold', 'resume', 'continue', 'stop'] as const
export type JobControlAction = (typeof JOB_CONTROLS)[number]

export const InitMessage = z.object({
  type: z.literal('init'),
  protocol: z.number().int(),
  logLevel: z.enum(LOG_LEVELS),
})

const request = <K extends string, T extends z.ZodRawShape>(type: K, shape: T) =>
  z.object({ type: z.literal(type), requestId: Id, ...shape })

export const MainMessage = z.discriminatedUnion('type', [
  InitMessage,
  request('connect', { target: VirtualTargetSchema }),
  request('disconnect', {}),
  request('machine', { action: MachineActionSchema }),
  request('jobStart', {
    jobId: Id,
    program: SenderProgramSchema,
    /** What main checked the program against; the host re-checks it before streaming. */
    expect: z.object({
      workZero: Vec3Schema,
      machineKey: z.string().max(200),
      target: z.literal('virtual'),
    }),
  }),
  request('jobControl', {
    jobId: Id,
    action: z.enum(JOB_CONTROLS),
    /** `continue`: the wait it ends (a retried continue never skips the next one). */
    expect: z
      .object({
        toolChange: z.number().int().exactOptional(),
        pause: z.number().int().exactOptional(),
      })
      .exactOptional(),
  }),
  request('timeScale', { scale: TimeScaleSchema }),
])
export type MainMessage = z.output<typeof MainMessage>
export type MainRequest = Exclude<MainMessage, { type: 'init' }>

// ── host → main ───────────────────────────────────────────────────────────────────────────

export const EVENT_KINDS = ['alarm', 'error', 'message', 'reset', 'connectionLost'] as const

export const HostMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), protocol: z.number().int() }),
  z.object({ type: z.literal('reply'), requestId: Id, result: ResultWireSchema }),
  z.object({ type: z.literal('status'), status: HostStatusSchema }),
  z.object({
    type: z.literal('progress'),
    jobId: Id,
    done: z.number().int(),
    total: z.number().int(),
    label: z.string().max(500),
  }),
  z.object({
    type: z.literal('phase'),
    jobId: Id,
    phase: z.enum(RUN_PHASES),
    toolChange: ToolChangeSchema.exactOptional(),
    message: z.string().max(500).exactOptional(),
  }),
  z.object({ type: z.literal('jobEnd'), jobId: Id, result: ResultWireSchema }),
  z.object({
    type: z.literal('event'),
    kind: z.enum(EVENT_KINDS),
    data: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal('log'), batch: z.array(z.unknown()) }),
])
export type HostMessage = z.output<typeof HostMessage>
