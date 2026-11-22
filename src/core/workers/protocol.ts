/**
 * Message protocol between a worker host and its workers, as Zod discriminated unions on
 * `type`; parsed on every receipt on both sides. Doc: docs/architecture/workers.md#message-protocol
 *
 * Abort, pause and resume are not messages: the host writes the run state into the run's shared
 * `control` word (steps.ts), because a synchronous task cannot read its message queue.
 */
import { z } from 'zod'
import { ResultWireSchema } from '../../shared/errors/schema'
import { LOG_LEVELS } from '../../shared/logging'
import { LANES } from '../commands/jobs'

export const PROTOCOL_VERSION = 1

const Id = z.string().min(1).max(200)

// ── host → worker ─────────────────────────────────────────────────────────────────────────

export const InitMessage = z.object({
  type: z.literal('init'),
  protocol: z.number().int(),
  workerId: Id,
  lane: z.enum(LANES),
  logLevel: z.enum(LOG_LEVELS),
  /** `manifold.wasm`, geometry lane only; the worker loads it before answering `ready`. */
  wasm: z.instanceof(ArrayBuffer).exactOptional(),
  /**
   * `cavalier_contours.wasm` (the 2D port), geometry and toolpath lanes; prewarmed at init
   * (docs/architecture/shapes.md#where-the-2d-layer-runs).
   */
  region2dWasm: z.instanceof(ArrayBuffer).exactOptional(),
})

export const RunMessage = z.object({
  type: z.literal('run'),
  /** Task run id. */
  id: Id,
  task: z.string().min(1).max(200),
  /** Checked by the worker with the task's own input schema. */
  input: z.unknown(),
  /** `Int32Array[0]`: 0 run, 1 pause, 2 abort (steps.ts). */
  control: z.instanceof(SharedArrayBuffer),
})

export const HostMessage = z.discriminatedUnion('type', [InitMessage, RunMessage])
export type HostMessage = z.output<typeof HostMessage>

// ── worker → host ─────────────────────────────────────────────────────────────────────────

export const ReadyMessage = z.object({
  type: z.literal('ready'),
  /** Must equal `PROTOCOL_VERSION` (a mismatch is a build bug). */
  protocol: z.number().int(),
  workerId: Id,
  initMs: z.number(),
  heapBytes: z.number().exactOptional(),
})

export const ProgressMessage = z.object({
  type: z.literal('progress'),
  id: Id,
  done: z.number(),
  total: z.number().exactOptional(),
  label: z.string().max(500).exactOptional(),
})

export const CheckpointMessage = z.object({
  type: z.literal('checkpoint'),
  id: Id,
  state: z.enum(['paused', 'running']),
  label: z.string().max(500).exactOptional(),
})

export const LogMessage = z.object({
  type: z.literal('log'),
  /** `LogRecord[]`; bounded and checked by the host's forward receiver. */
  batch: z.array(z.unknown()),
})

export const ResultMessage = z.object({
  type: z.literal('result'),
  id: Id,
  result: ResultWireSchema,
  stats: z.object({
    ms: z.number(),
    heapBytes: z.number().exactOptional(),
    liveObjects: z.number().exactOptional(),
  }),
})

export const WorkerMessage = z.discriminatedUnion('type', [
  ReadyMessage,
  ProgressMessage,
  CheckpointMessage,
  LogMessage,
  ResultMessage,
])
export type WorkerMessage = z.output<typeof WorkerMessage>
export type ResultStats = z.output<typeof ResultMessage>['stats']

/** Where a worker posts to and receives from: `parentPort`, a Web Worker's `self`, or a fake. */
export interface Endpoint {
  post(message: unknown, transfer?: readonly ArrayBuffer[]): void
  onMessage(listener: (message: unknown) => void): void
}
