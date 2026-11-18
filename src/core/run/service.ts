/**
 * The machine port of the command layer (`ctx.services.machine`) and the run status that main
 * mirrors for queries, the UI and agents. Implemented by `MachineClient` (host/client.ts).
 * Doc: docs/modes/run-v0.1.md#commands-and-queries, #status
 */
import { z } from 'zod'
import type { AppResult, AsyncAppResult } from '../../shared/result'
import type { TimeScale } from './clock'
import type { RunSummary, SenderProgram } from './grbl/sender'
import {
  HostStatusSchema,
  RUN_PHASES,
  TimeScaleSchema,
  ToolChangeSchema,
  type ConnectedInfo,
  type JobControlAction,
  type MachineAction,
  type VirtualTarget,
} from './host/protocol'

export const CONNECTION_STATES = ['closed', 'connecting', 'open'] as const

/** Main's mirror (docs/modes/run-v0.1.md#status). */
export const RunStatusSchema = HostStatusSchema.omit({ job: true, timeScale: true }).extend({
  connection: z.object({
    state: z.enum(CONNECTION_STATES),
    target: z.literal('virtual').exactOptional(),
    timeScale: TimeScaleSchema,
  }),
  job: z
    .object({
      jobId: z.string(),
      phase: z.enum(RUN_PHASES),
      line: z.number().int(),
      toolChange: ToolChangeSchema.exactOptional(),
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
  /** Target of the connection while connecting or open; undefined when closed. */
  readonly target: 'virtual' | undefined
  /** Identity of the machine copy the virtual machine emulates (decision 6). */
  readonly machineKey: string | undefined
  status(): RunStatus
  onStatus(listener: (s: RunStatus) => void): () => void
  connect(target: VirtualTarget, machineKey: string): AsyncAppResult<ConnectedInfo>
  disconnect(): AsyncAppResult<void>
  /** `setWorkZero` and `home` answer the new G54 (`Vec3`), the others nothing. */
  machine(action: MachineAction): AsyncAppResult<unknown>
  /** Answers once streaming started (pre-flight and state checks passed). */
  startJob(jobId: string, program: SenderProgram, listener: JobListener): AsyncAppResult<RunningJob>
  controlJob(jobId: string, action: JobControlAction): AsyncAppResult<void>
  setTimeScale(scale: TimeScale): AsyncAppResult<void>
}
