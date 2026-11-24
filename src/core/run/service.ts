/**
 * The machine port of the command layer (`ctx.services.machine`) and the run status that main
 * mirrors for queries, the UI and agents. Implemented by `MachineClient` (host/client.ts).
 * Doc: docs/modes/run-v0.1.md#commands-and-queries, #status
 */
import { z } from 'zod'
import type { AppResult, AsyncAppResult } from '../../shared/result'
import type { TimeScale } from './clock'
import type { RunSummary, SenderProgram } from './grbl/sender'
import type { SerialPortInfo } from './serial'
import {
  HostStatusSchema,
  PortSchema,
  TARGET_KINDS,
  RUN_PHASES,
  HOLD_SOURCES,
  TimeScaleSchema,
  ToolChangeSchema,
  type ConnectedInfo,
  type JobControlAction,
  type ConnectTarget,
  type MachineAction,
  type TargetKind,
} from './host/protocol'

import { AlignmentStepSchema, type AlignmentStep } from './alignment'

export const CONNECTION_STATES = ['closed', 'connecting', 'open'] as const

/**
 * The plan and setup a run job machines (hardening M7,
 * docs/modes/run-machine.md#run-status-and-the-zero-to-set-m7).
 */
export const RunPlanSchema = z.object({
  planId: z.string(),
  planName: z.string(),
  setupId: z.string(),
  setupName: z.string(),
  /** 1-based number of the setup in machining order, and the plan's setup count. */
  setup: z.number().int(),
  setups: z.number().int(),
})
export type RunPlan = z.output<typeof RunPlanSchema>

/** How the last run job ended (hardening M5, docs/modes/run-machine.md#section-resume-m5). */
export const LastRunSchema = z.object({
  jobId: z.string(),
  planId: z.string(),
  setupId: z.string(),
  outcome: z.enum(['done', 'stopped', 'failed']),
  /** The earliest operation GRBL may still have been executing when the run ended. */
  planOperationId: z.string().exactOptional(),
  /**
   * DF85: `planHash` of the plan and setup as the run exported them, and the operations the run
   * had in machining order; a resume compares them with the plan as it is now
   * (docs/modes/run-machine.md#section-resume-m5).
   */
  planHash: z.string().exactOptional(),
  operations: z.array(z.string()).readonly().exactOptional(),
})
export type LastRun = z.output<typeof LastRunSchema>

/** Main's mirror (docs/modes/run-v0.1.md#status). */
export const RunStatusSchema = HostStatusSchema.omit({ job: true, timeScale: true }).extend({
  connection: z.object({
    state: z.enum(CONNECTION_STATES),
    target: z.enum(TARGET_KINDS).exactOptional(),
    /** Serial connections: the port (docs/modes/run-machine.md#connect). */
    port: PortSchema.exactOptional(),
    timeScale: TimeScaleSchema,
    /**
     * Closed: the last open connection was lost rather than closed by DFYOM (no reset reached the
     * controller); cleared by the next connect (docs/modes/run-machine.md#lost-connection-m2).
     */
    lost: z
      .object({ target: z.enum(TARGET_KINDS), port: PortSchema.exactOptional() })
      .exactOptional(),
  }),
  job: z
    .object({
      jobId: z.string(),
      phase: z.enum(RUN_PHASES),
      line: z.number().int(),
      toolChange: ToolChangeSchema.exactOptional(),
      /** In `programPause`: the pause's number, for `run.job.continue { pause }`. */
      pause: z.number().int().exactOptional(),
      /** ISO time, main's clock. */
      startedAt: z.string(),
      elapsedSeconds: z.number(),
      /** The run's plan and setup (M7); absent for a job started without them. */
      plan: RunPlanSchema.exactOptional(),
      /** The operation of the line being acknowledged (M7). */
      planOperationId: z.string().exactOptional(),
      /**
       * DF85: the programmed feed (mm/min) and spindle speed (rpm, 0 = off) of the last
       * acknowledged line, which the overrides scale (docs/modes/run-machine.md#overrides-m6).
       */
      programmed: z.object({ feed: z.number(), spindle: z.number() }).exactOptional(),
      /** DF84: lines written to the controller so far (docs/modes/run.md#gcode-panel-df84). */
      sent: z.number().int().exactOptional(),
      /**
       * DF84: the 1-based line the machine is estimated to execute (from `Bf`, the acknowledged
       * lines' planner blocks and the position); absent until estimated.
       */
      executing: z.number().int().exactOptional(),
    })
    .exactOptional(),
  /** The run that ended last; kept until the next run starts, across connections (M5). */
  lastRun: LastRunSchema.exactOptional(),
  /** DF78: the alignment step of the open connection (docs/modes/alignment.md#state). */
  alignment: AlignmentStepSchema.exactOptional(),
})
export type RunStatus = z.output<typeof RunStatusSchema>

/** Status with no connection. */
export function closedStatus(timeScale: TimeScale = 1): RunStatus {
  return {
    connection: { state: 'closed', timeScale },
    state: 'Disconnected',
    homed: false,
    mpos: [0, 0, 0],
    wpos: [0, 0, 0],
    workZero: [0, 0, 0],
    feed: 0,
    spindle: 0,
  }
}

export interface JobListener {
  readonly progress: (p: { done: number; total: number; label: string }) => void
  readonly phase: (p: {
    phase: (typeof RUN_PHASES)[number]
    /** In `held`: who held the run (`machine`: the hold button or the safety door, DF82). */
    heldBy?: (typeof HOLD_SOURCES)[number]
    toolChange?: { n: number; name: string }
    message?: string
  }) => void
}

/**
 * The program a run job streamed (DF84), as main keeps it until the next run starts: the lines,
 * the section starts (progress labels) and each plan operation's first line. Renderer only
 * (`window.dfyom.run.program`), docs/modes/run.md#gcode-panel-df84.
 */
export interface RunProgram {
  readonly jobId: string
  readonly lines: readonly string[]
  readonly sections: readonly { readonly fromLine: number; readonly label: string }[]
  readonly operations: readonly { readonly planOperationId: string; readonly fromLine: number }[]
}

/** What `run.job.start` tells the machine port about its run (M5, M7). */
export interface JobAbout {
  readonly plan: RunPlan
  /** The first line (1-based) of each plan operation in the program streamed. */
  readonly operations: readonly { readonly planOperationId: string; readonly fromLine: number }[]
  /** DF85: `runPlanHash` of the plan and setup exported, and the setup's operations in order. */
  readonly planHash?: string
  readonly order?: readonly string[]
}

export interface RunningJob {
  /** Resolves once with the run's outcome (`jobEnd`, or `machine.connection` if the host dies). */
  readonly ended: Promise<AppResult<RunSummary>>
}

export interface MachineService {
  /** Target of the open connection as the host reported it; undefined while connecting or closed. */
  readonly target: TargetKind | undefined
  /** Identity of the machine copy the virtual machine emulates (decision 6). */
  readonly machineKey: string | undefined
  /** The controller's `$$` of the open connection, by setting number; undefined when closed. */
  readonly controllerSettings: Readonly<Record<string, number>> | undefined
  status(): RunStatus
  onStatus(listener: (s: RunStatus) => void): () => void
  /** `target.machineKey` names the machine copy emulated or checked against (decision 6). */
  connect(target: ConnectTarget): AsyncAppResult<ConnectedInfo>
  /** The serial ports the machine host sees (spawns the host if none runs). */
  listPorts(): AsyncAppResult<SerialPortInfo[]>
  disconnect(): AsyncAppResult<void>
  /** `setWorkZero` answers the new G54 (`Vec3`), the others nothing. */
  machine(action: MachineAction): AsyncAppResult<unknown>
  /**
   * Holds the connection for a job from its checks to its stream: machine actions other than
   * reset and jog cancel answer `run.busy` meanwhile. `startJob` ends it; `release` on failure.
   */
  reserve(jobId: string): AppResult<void>
  release(jobId: string): void
  /**
   * Answers once streaming started. The host re-checks `expect` (the G54 the program was
   * checked with, the machine copy, the target) on a fresh report and refuses on any change.
   */
  startJob(
    jobId: string,
    program: SenderProgram,
    listener: JobListener,
    expect: { readonly workZero: readonly [number, number, number]; readonly machineKey: string },
    about?: JobAbout,
  ): AsyncAppResult<RunningJob>
  /** `continue` names the wait it ends (`toolChange` n or `pause` n). */
  controlJob(
    jobId: string,
    action: JobControlAction,
    expect?: { readonly toolChange?: number; readonly pause?: number },
  ): AsyncAppResult<void>
  setTimeScale(scale: TimeScale): AsyncAppResult<void>
  /**
   * DF78: the alignment step of the open connection (docs/modes/alignment.md#state). Every status
   * report reconciles it (`reconcileStep`: a G54 X/Y change clears the ticks; a lost position or
   * a closed connection drops it); setting it notifies the status listeners.
   */
  alignmentStep(): AlignmentStep | undefined
  setAlignmentStep(step: AlignmentStep | undefined): void
}
