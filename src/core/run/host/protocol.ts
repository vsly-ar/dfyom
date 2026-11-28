/**
 * Message protocol between main (`MachineClient`) and the machine host (utility process in the
 * app, `worker_threads` headless, in-process in tests), as Zod discriminated unions on `type`;
 * parsed on every receipt on both sides. Doc: docs/modes/run-v0.1.md#machine-host-and-protocol
 */
import { z } from 'zod'
import { ResultWireSchema } from '../../../shared/errors/schema'
import { LOG_LEVELS } from '../../../shared/logging'
import { PROBE_KINDS } from '../../library/machine.dto'
import { MAX_TIME_SCALE } from '../clock'
import { SerialPortInfoSchema } from '../serial'

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

/** Who held the machine (DF82, docs/modes/run.md#external-holds-df82): DFYOM's `!`, or not. */
export const HOLD_SOURCES = ['app', 'machine'] as const

export const ToolChangeSchema = z.object({
  n: z.number().int(),
  name: z.string().max(500),
  /** DF69: the Z reference surface and level when not the top face; `spot` where to touch off. */
  surface: z.string().max(500).exactOptional(),
  spot: z.string().max(100).exactOptional(),
  /** DF69: the surface's level (mm, setup frame, < 0) and the spot in work coordinates (mm). */
  level: Num.exactOptional(),
  at: z.tuple([Num, Num]).readonly().exactOptional(),
  /** DF132 H3: the clamp that decides the stickout (docs/modes/tool-holder.md#run-mode). */
  stickoutReason: z.string().max(500).exactOptional(),
})

export const RunSummarySchema = z.object({
  lines: z.number().int(),
  seconds: Num,
  elapsedSeconds: Num,
  toolChanges: z.number().int(),
  pauses: z.number().int(),
})

/** The kinds of connection (docs/modes/run-machine.md#connect). */
export const TARGET_KINDS = ['virtual', 'serial'] as const
export type TargetKind = (typeof TARGET_KINDS)[number]

/** A serial port as connected. */
export const PortSchema = z.object({
  path: z.string().min(1).max(500),
  baud: z.number().int().min(300).max(4_000_000),
})

export const ControllerInfoSchema = z.object({
  /** What the host connected to (reported by the host, never assumed by main). */
  target: z.enum(TARGET_KINDS),
  /** Serial connections: the port. */
  port: PortSchema.exactOptional(),
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
  /**
   * While the state is `Hold`: `app` when DFYOM sent the feed hold, `machine` for a hold it did
   * not send (the controller's hold button or pin, DF82). Absent at an `M0` pause.
   */
  holdBy: z.enum(HOLD_SOURCES).exactOptional(),
  homed: z.boolean(),
  mpos: Vec3Schema,
  wpos: Vec3Schema,
  /** G54 in machine coordinates (mm). */
  workZero: Vec3Schema,
  /** mm/min. */
  feed: Num,
  spindle: Num,
  /**
   * RV1: the spindle's direction from the last `A:` (kept between reports, like `Ov`); absent =
   * off. Doc: docs/modes/run-machine.md#spindle-while-jogging-rv1
   */
  spindleDirection: z.enum(['cw', 'ccw']).exactOptional(),
  /**
   * RV1: the speed (rpm) the last `run.machine.spindle` turned the spindle on at, until `M5`, a
   * reset, an alarm or a run start.
   */
  manualSpindle: z.object({ rpm: Num }).exactOptional(),
  buffer: z.object({ blocks: z.number(), rx: z.number() }).exactOptional(),
  /** Feed, rapid, spindle overrides in % from the last `Ov` (docs/modes/run-machine.md#overrides-m6). */
  overrides: z.object({ feed: Num, rapid: Num, spindle: Num }).exactOptional(),
  /**
   * The last alarm until `$H` or `$X` clears it. `reset`: the controller was reset since, so a
   * critical alarm (1, 2) no longer blocks; GRBL waits locked for `$H` or `$X` (DF134,
   * docs/modes/run-machine.md#after-a-hard-limit-df134).
   */
  alarm: z
    .object({ code: z.number().int(), text: z.string(), reset: z.literal(true).exactOptional() })
    .exactOptional(),
  /**
   * DF134: the controller's input pins active in the last report (`Pn:`, e.g. `X` a limit switch
   * still pressed, `D` the safety door open); absent when none.
   */
  pins: z.string().max(16).exactOptional(),
  /** `$32=1` (DF85): the spindle output drives a laser; no spindle speed override. */
  laserMode: z.literal(true).exactOptional(),
  lastMessage: z.string().max(500).exactOptional(),
  /** What the controller enforces, from its `$$` (docs/modes/run.md#machine-coordinates-and-the-homing-corner-df33). */
  envelope: z
    .object({
      travel: Vec3Schema,
      homingMask: z.number().int().min(0).max(7),
      pullOff: Num,
      softLimits: z.boolean(),
      /**
       * v0.5 RV7: DFYOM's inner bound (MPos, the margin included) from the marked work area,
       * while homed; absent: the travel only (docs/modes/run.md#work-area-rv7).
       */
      workArea: z.object({ min: Vec3Schema, max: Vec3Schema }).exactOptional(),
    })
    .exactOptional(),
  timeScale: TimeScaleSchema,
  /**
   * DF69: the level (mm, setup frame, < 0) of the surface the work zero Z was last set on during
   * a run (Set Z zero, Probe Z at a tool change); absent = the stock top
   * (docs/modes/z-reference.md#dfyom-run).
   */
  zeroLevel: Num.exactOptional(),
  job: z
    .object({
      jobId: Id,
      phase: z.enum(RUN_PHASES),
      /** 1-based line being executed (last acknowledged + 1). */
      line: z.number().int(),
      /** DF84: lines written to the controller (docs/modes/run.md#gcode-panel-df84). */
      sent: z.number().int().exactOptional(),
      /** DF84: lines acknowledged when the last status report (its `Bf`, its position) arrived. */
      ackedAtReport: z.number().int().exactOptional(),
      /** DF129: GRBL's `Ln:` (the `N` number executing) in the last report, when it sends one. */
      reportedLine: z.number().int().exactOptional(),
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
  /** MPos at power-up (the virtual machine's physical position; grbl.md#homing-and-machine-coordinates). */
  position: Vec3Schema.exactOptional(),
  /**
   * DF129: G54 at power-up, as GRBL's EEPROM kept it: the virtual machine reconnected after a
   * simulated lost connection (docs/modes/run-recovery.md#implementation-rc4).
   */
  workZero: Vec3Schema.exactOptional(),
  /** Home at `max` speed, then set G54 to this MPos (docs/modes/run-v0.1.md decision 7). */
  prepare: z.object({ workZero: Vec3Schema }).exactOptional(),
  /**
   * v0.5 RV8 test seam: the emulator's homing scatter (mm, full width per axis) and its seed
   * (docs/architecture/grbl.md#homing-scatter-and-lost-steps-rv8).
   */
  homingScatter: z
    .object({
      x: z.number().min(0).max(5).exactOptional(),
      y: z.number().min(0).max(5).exactOptional(),
      z: z.number().min(0).max(5).exactOptional(),
      seed: z.number().int().exactOptional(),
    })
    .exactOptional(),
})
export type VirtualTarget = z.output<typeof VirtualTargetSchema>

/** A real controller on a serial port (docs/modes/run-machine.md#connect). */
export const SerialTargetSchema = z.object({
  kind: z.literal('serial'),
  path: PortSchema.shape.path,
  baud: PortSchema.shape.baud,
  /** Identity of the machine copy the controller is checked against (decision 6). */
  machineKey: z.string().max(200),
})
export type SerialTarget = z.output<typeof SerialTargetSchema>

export const ConnectTargetSchema = z.discriminatedUnion('kind', [
  VirtualTargetSchema,
  SerialTargetSchema,
])
export type ConnectTarget = z.output<typeof ConnectTargetSchema>

export const AXES = ['x', 'y', 'z'] as const

/** Feed and spindle override steps; rapids take `100`/`50`/`25` (docs/modes/run-machine.md#overrides-m6). */
export const OVERRIDE_STEPS = ['reset', '+10', '-10', '+1', '-1'] as const
export const RAPID_OVERRIDES = ['100', '50', '25'] as const
export type OverrideStep = (typeof OVERRIDE_STEPS)[number]
export type RapidOverride = (typeof RAPID_OVERRIDES)[number]

/** Probe defaults (docs/modes/run-machine.md#probing-and-re-zero-m4), mm and mm/min. */
export const PROBE_DEFAULTS = { maxTravel: 25, feed: 50, retract: 2 } as const

/** DF134: the virtual machine's inputs that can be simulated (limit switches, the safety door). */
export const SIMULATED_INPUTS = ['x', 'y', 'z', 'door'] as const
export type SimulatedInput = (typeof SIMULATED_INPUTS)[number]

const Mm = z.number().min(0).max(1000)
const PositiveMm = z.number().positive().max(1000)
const Feed = z.number().positive().max(10_000)
const Side = z.union([z.literal(-1), z.literal(1)])

/** v0.5 RV4: a probing routine (docs/modes/run-probing.md#xy-probing-rv4). */
export const ProbeRoutineSchema = z.discriminatedUnion('cycle', [
  z.object({ cycle: z.literal('edge'), axis: z.enum(['x', 'y']), side: Side }),
  z.object({ cycle: z.literal('corner'), corner: z.tuple([Side, Side]).readonly() }),
  z.object({
    cycle: z.literal('centre'),
    feature: z.enum(['hole', 'boss']),
    diameter: PositiveMm,
  }),
])

/** v0.5 RV4: what probes (docs/modes/run-probing.md#probe-settings-rv4). */
export const ProbeGeometrySchema = z.object({
  kind: z.enum(PROBE_KINDS),
  tipDiameter: z.number().min(0).max(100),
  plateThickness: PositiveMm.exactOptional(),
  wallOffset: z.tuple([Mm, Mm]).readonly().exactOptional(),
})

/** v0.5 RV5: the virtual machine's stock (MPos box, rotated by `angle`° about its min corner). */
export const VirtualStockSchema = z.object({
  min: Vec3Schema,
  max: Vec3Schema,
  angle: z.number().min(-45).max(45).exactOptional(),
})

/** v0.5 RV7: one axis's work area marks (MPos, mm). */
const AxisMarksSchema = z.object({ min: Num.exactOptional(), max: Num.exactOptional() })

/** v0.5 RV7: the work area marks and margin (docs/modes/run.md#work-area-rv7). */
export const WorkAreaSettingSchema = z.object({
  marks: z.object({
    x: AxisMarksSchema.exactOptional(),
    y: AxisMarksSchema.exactOptional(),
    z: AxisMarksSchema.exactOptional(),
  }),
  margin: z.number().min(0).max(1000),
})

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
    /** Hold to jog: to the travel edge in the direction of `by` (one axis), until a jog cancel. */
    continuous: z.boolean().exactOptional(),
  }),
  z.object({ kind: z.literal('jogCancel') }),
  z.object({
    kind: z.literal('setWorkZero'),
    axes: z.array(z.enum(AXES)).min(1).max(3).readonly(),
    /** WPos the current position gets (mm); default 0 on each axis. */
    values: Vec3Schema.exactOptional(),
  }),
  z.object({ kind: z.literal('reset') }),
  /**
   * DF129, Q173: the virtual machine's cable is pulled (virtual only): the connection is lost as a
   * real one is, for practising recovery (docs/modes/run-recovery.md#implementation-rc4).
   */
  z.object({ kind: z.literal('simulateLostConnection') }),
  /**
   * DF134: one of the virtual machine's inputs pressed or released (virtual only): a limit switch
   * (`x`/`y`/`z`, a hard limit with `$21=1`) or the safety door, for practising the alarm flow
   * (docs/modes/run-machine.md#after-a-hard-limit-df134).
   */
  z.object({
    kind: z.literal('simulateInput'),
    input: z.enum(SIMULATED_INPUTS),
    pressed: z.boolean(),
  }),
  /**
   * DF129 RC5 (Q171): the machine lost power while the controller stayed on USB power: the
   * connection forgets that it is homed (GRBL cannot know); not during a job.
   */
  z.object({ kind: z.literal('forgetHoming') }),
  /**
   * Feed hold (`!`) of a manual cycle (Probe Z, hardening DF82); answers once the controller
   * reports `Hold:0`. A run holds through `job.pause` (jobControl). Not during homing.
   */
  z.object({ kind: z.literal('feedHold') }),
  /** Cycle start (`~`) after `feedHold`. */
  z.object({ kind: z.literal('cycleStart') }),
  /** Z touch plate (M4): G38.2 down, G54 Z at the contact minus the plate, retract. */
  z.object({
    kind: z.literal('probeZ'),
    plateThickness: z.number().positive().max(100),
    maxTravel: z.number().positive().max(1000),
    feed: z.number().positive().max(10_000),
    retract: z.number().min(0).max(100),
  }),
  /**
   * v0.5 RV4: an edge, corner or centre probing routine from here (docs/modes/run-probing.md);
   * writes nothing. `plateSize`: the corner plate's size (the virtual machine lays it).
   */
  z.object({
    kind: z.literal('probeRoutine'),
    routine: ProbeRoutineSchema,
    probe: ProbeGeometrySchema,
    reach: PositiveMm,
    zDistance: PositiveMm,
    depth: PositiveMm,
    clearance: PositiveMm,
    fastFeed: Feed,
    slowFeed: Feed,
    moveFeed: Feed,
    plateSize: PositiveMm.exactOptional(),
  }),
  /**
   * v0.5 RV8: one probe of a fixed target from its start `at` (MPos), from the machine top after a
   * homing (docs/modes/run-machine.md#homing-repeatability-rv8); writes nothing. Homed, Idle, no
   * run. The virtual machine lays the target under `at` (a Z plate, else a corner plate).
   */
  z.object({
    kind: z.literal('targetProbe'),
    at: Vec3Schema,
    probe: ProbeGeometrySchema,
    corner: z.tuple([Side, Side]).readonly(),
    zDistance: PositiveMm,
    reach: PositiveMm,
    depth: PositiveMm,
    clearance: PositiveMm,
    fastFeed: Feed,
    slowFeed: Feed,
    moveFeed: Feed,
    travelFeed: Feed,
    plateSize: PositiveMm.exactOptional(),
  }),
  /**
   * v0.5 RV5 (virtual only): the stock the virtual operator laid (`stock` absent: the one laid before); with
   * `touch` it closes the probe input whenever the tool touches it (the touch-off's readout).
   */
  z.object({
    kind: z.literal('virtualStock'),
    stock: VirtualStockSchema.exactOptional(),
    touch: z.boolean(),
    /** mm: the bit's Ø for the touch readout (a cylinder); absent: a point. */
    toolDiameter: z.number().nonnegative().exactOptional(),
  }),
  /**
   * RV1: the spindle from Run (docs/modes/run-machine.md#spindle-while-jogging-rv1): on at `rpm`
   * (Idle only; in a jog a speed change through the spindle override), or off (a jog is
   * cancelled first: `M5` is never sent in Jog). `dwellSeconds`: the spin-up dwell from off.
   */
  z.object({
    kind: z.literal('spindle'),
    on: z.boolean(),
    rpm: z.number().positive().max(1e6).exactOptional(),
    dwellSeconds: z.number().min(0).max(60).exactOptional(),
  }),
  /**
   * v0.5 RV7: the connection's work area (absent: none); jogs, probing and the status's
   * `envelope.workArea` follow it while homed. Moves nothing.
   */
  z.object({ kind: z.literal('workArea'), area: WorkAreaSettingSchema.exactOptional() }),
  /** Overrides (M6): one real-time byte. `rapid` takes a percentage, the others a step. */
  z.object({
    kind: z.literal('override'),
    which: z.enum(['feed', 'spindle', 'rapid']),
    action: z.enum([...OVERRIDE_STEPS, ...RAPID_OVERRIDES]),
  }),
  /** DF85: feed or spindle to a target percent; the host sends the steps and reads `Ov` back. */
  z.object({
    kind: z.literal('overrideTo'),
    which: z.enum(['feed', 'spindle']),
    percent: z.number().int(),
  }),
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
  request('connect', { target: ConnectTargetSchema }),
  /** The serial ports the OS reports (docs/modes/run-machine.md#ports-and-the-port-picker). */
  request('listPorts', {}),
  request('disconnect', {}),
  request('machine', { action: MachineActionSchema }),
  request('jobStart', {
    jobId: Id,
    program: SenderProgramSchema,
    /** What main checked the program against; the host re-checks it before streaming. */
    expect: z.object({
      workZero: Vec3Schema,
      machineKey: z.string().max(200),
      target: z.enum(TARGET_KINDS),
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
    /** In `held`: who held the run (`machine`: the hold button or the safety door, DF82). */
    heldBy: z.enum(HOLD_SOURCES).exactOptional(),
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

export const PortListSchema = z.array(SerialPortInfoSchema)
