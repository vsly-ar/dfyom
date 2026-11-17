/**
 * The worker side, environment-neutral: answers `init` with `ready`, runs one task at a time,
 * reports progress, checkpoints and logs, and posts exactly one `result` per `run`.
 * Doc: docs/architecture/workers.md#message-protocol, #logging-from-workers
 *
 * Hosts adapt their channel to an `Endpoint` (`worker_threads` `parentPort`: src/main/workers/;
 * a renderer Web Worker later) and call `runWorkerLoop` once.
 */
import {
  createEntryLogger,
  createLogForwarder,
  noopLogger,
  type Logger,
  type LogForwarder,
} from '../../shared/logging'
import { parseWith } from '../../shared/parse'
import {
  Err,
  fail,
  Ok,
  toWire,
  tryAsync,
  tryCatch,
  type AppResult,
  type AsyncAppResult,
} from '../../shared/result'
import type { AnyWorkerTask, Lane, TaskControl, TransferView } from '../commands/jobs'
import { loadManifold } from '../geometry/manifold'
import type { SolidKernel } from '../geometry/solid-port'
import {
  HostMessage,
  PROTOCOL_VERSION,
  type Endpoint,
  type ResultStats,
  type WorkerMessage,
} from './protocol'
import { sharedSteps, type StepProgress } from './steps'

export interface WorkerLoopOptions {
  readonly tasks: readonly AnyWorkerTask[]
  /** Loads the solid kernel (default: `loadManifold` with the bytes from `init`). */
  readonly loadSolids?: (wasm: ArrayBuffer | undefined) => AsyncAppResult<SolidKernel>
  /** Monotonic milliseconds (default `performance.now`). */
  readonly now?: () => number
  /** Min interval between progress messages of a run (default 50 ms; the final tick always goes). */
  readonly progressIntervalMs?: number
}

const WHERE = 'workerLoop'

/** Starts serving `endpoint`; returns the logger for the host's uncaught-error handlers. */
export function runWorkerLoop(endpoint: Endpoint, opts: WorkerLoopOptions): { log(): Logger } {
  const tasks = new Map(opts.tasks.map((t) => [t.name, t]))
  const now = opts.now ?? (() => performance.now())
  const interval = opts.progressIntervalMs ?? 50
  const loadSolids =
    opts.loadSolids ??
    ((wasm: ArrayBuffer | undefined) =>
      loadManifold(wasm === undefined ? {} : { wasmBinary: wasm }))
  const post = (m: WorkerMessage, transfer?: readonly ArrayBuffer[]) => endpoint.post(m, transfer)

  let log: Logger = noopLogger
  let forwarder: LogForwarder | undefined
  let lane: Lane | undefined
  let wasm: ArrayBuffer | undefined
  let kernel: AsyncAppResult<SolidKernel> | undefined
  let loaded: SolidKernel | undefined
  const solids = (): AsyncAppResult<SolidKernel> => {
    if (lane !== 'geometry')
      return Promise.resolve(
        fail('internal.unexpected', `no solid kernel in the ${lane ?? 'uninitialized'} lane`, {
          where: WHERE,
        }),
      )
    kernel ??= loadSolids(wasm).then((k) => {
      if (k.isOk()) loaded = k.unwrap()
      return k
    })
    return kernel
  }
  // one task at a time (the host never sends `run` before `result`; this keeps it so anyway)
  let queue: Promise<void> = Promise.resolve()

  async function init(m: Extract<HostMessage, { type: 'init' }>): Promise<void> {
    const started = now()
    lane = m.lane
    wasm = m.wasm
    forwarder = createLogForwarder({ send: (batch) => post({ type: 'log', batch: [...batch] }) })
    const fw = forwarder
    log = createEntryLogger({
      level: m.logLevel,
      bindings: { proc: 'worker', worker: m.workerId, lane: m.lane },
      write: (r) => fw.push(r),
    })
    let heapBytes: number | undefined
    if (m.lane === 'geometry' && m.wasm !== undefined) {
      // prewarm: hide the cold WASM init before the first evaluation
      const k = await solids()
      if (k.isErr()) log.error({ err: k.unwrapErr().toJSON() }, 'solid kernel failed to load')
      else heapBytes = k.unwrap().heapBytes().unwrapOr(-1)
    }
    const initMs = now() - started
    log.debug({ initMs }, 'worker ready')
    post({
      type: 'ready',
      protocol: PROTOCOL_VERSION,
      workerId: m.workerId,
      initMs,
      ...(heapBytes === undefined || heapBytes < 0 ? {} : { heapBytes }),
    })
    fw.flush()
  }

  async function run(m: Extract<HostMessage, { type: 'run' }>): Promise<void> {
    const started = now()
    const task = tasks.get(m.task)
    const taskLog = log.child({ task: m.task, run: m.id })
    let lastProgress = Number.NEGATIVE_INFINITY
    const progress = (p: StepProgress) => {
      const t = now()
      const final = p.total !== undefined && p.done >= p.total
      if (!final && t - lastProgress < interval) return
      lastProgress = t
      post({
        type: 'progress',
        id: m.id,
        done: p.done,
        ...(p.total === undefined ? {} : { total: p.total }),
        ...(p.label === undefined ? {} : { label: p.label.slice(0, 500) }),
      })
    }
    const control: TaskControl = {
      steps: sharedSteps(new Int32Array(m.control), {
        progress,
        parked: (state, label) =>
          post({
            type: 'checkpoint',
            id: m.id,
            state,
            ...(label === undefined ? {} : { label: label.slice(0, 500) }),
          }),
      }),
      log: taskLog,
      solids,
    }
    let result: AppResult<unknown>
    if (task === undefined)
      result = fail('internal.unexpected', `unknown worker task ${m.task}`, { where: WHERE })
    else {
      const input = parseWith(task.input, m.input, `${WHERE} ${task.name}`)
      if (input.isErr()) result = input
      else {
        const ran = await tryAsync(
          async () => task.run(input.unwrap(), control),
          'internal.unexpected',
          `${task.name} threw`,
        )
        result = ran.isOk() ? ran.unwrap() : Err(ran.unwrapErr())
        if (ran.isErr()) taskLog.error({ err: ran.unwrapErr().toJSON() }, 'task threw')
      }
    }
    let transfer: ArrayBuffer[] = []
    if (result.isOk() && task?.transfer !== undefined) {
      const views = task.transfer(result.unwrap())
      const owned = ownedBuffers(views)
      if (owned.isErr()) result = Err(owned.unwrapErr())
      else transfer = owned.unwrap()
    }
    const stats: ResultStats = { ms: now() - started }
    if (loaded !== undefined) {
      const heap = loaded.heapBytes()
      if (heap.isSome()) stats.heapBytes = heap.unwrap()
      stats.liveObjects = loaded.liveObjects()
    }
    const sent = tryCatch(
      () => post({ type: 'result', id: m.id, result: toWire(result), stats }, transfer),
      'internal.unexpected',
      `${m.task}: result could not be posted`,
    )
    if (sent.isErr()) {
      taskLog.error({ err: sent.unwrapErr().toJSON() }, 'result not cloneable')
      post({ type: 'result', id: m.id, result: toWire(Err(sent.unwrapErr())), stats })
    }
    forwarder?.flush()
  }

  endpoint.onMessage((raw) => {
    const parsed = parseWith(HostMessage, raw, WHERE)
    if (parsed.isErr()) {
      const id = runId(raw)
      if (id !== undefined)
        post({
          type: 'result',
          id,
          result: toWire(Err(parsed.unwrapErr())),
          stats: { ms: 0 },
        })
      else log.warn({ err: parsed.unwrapErr().toJSON() }, 'malformed message dropped')
      forwarder?.flush()
      return
    }
    const m = parsed.unwrap()
    queue = queue.then(() => (m.type === 'init' ? init(m) : run(m)))
  })
  return { log: () => log }
}

/** The `id` of a malformed `run` message, if readable. */
function runId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const id = (raw as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : undefined
}

/** Each view must own its whole (non-shared) buffer, so a transfer never detaches a neighbour. */
function ownedBuffers(views: readonly TransferView[]): AppResult<ArrayBuffer[]> {
  const out = new Set<ArrayBuffer>()
  for (const v of views) {
    const b = v.buffer
    if (!(b instanceof ArrayBuffer) || v.byteOffset !== 0 || v.byteLength !== b.byteLength)
      return fail('internal.unexpected', 'a transferred array does not own its whole buffer', {
        where: WHERE,
        data: { byteOffset: v.byteOffset, byteLength: v.byteLength },
      })
    out.add(b)
  }
  return Ok([...out])
}
