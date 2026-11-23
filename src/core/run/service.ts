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
  TimeScaleSchema,
  ToolChangeSchema,
  type ConnectedInfo,
  type JobControlAction,
  type ConnectTarget,
  type MachineAction,
  type TargetKind,
} from './host/protocol'

export const CONNECTION_STATES = ['closed', 'connecting', 'open'] as const

/** Main's mirror (docs/modes/run-v0.1.md#status). */
export const RunStatusSchema = HostStatusSchema.omit({ job: true, timeScale: true }).extend({
  connection: z.object({
    state: z.enum(CONNECTION_STATES),
    target: z.enum(TARGET_KINDS).exactOptional(),
    /** Serial connections: the port (docs/modes/run-machine.md#connect). */
    port: PortSchema.exactOptional(),
    timeScale: TimeScaleSchema,
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
    })
    .exactOptional(),
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
    toolChange?: { n: number; name: string }
    message?: string
  }) => void
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
  ): AsyncAppResult<RunningJob>
  /** `continue` names the wait it ends (`toolChange` n or `pause` n). */
  controlJob(
    jobId: string,
    action: JobControlAction,
    expect?: { readonly toolChange?: number; readonly pause?: number },
  ): AsyncAppResult<void>
  setTimeScale(scale: TimeScale): AsyncAppResult<void>
}
