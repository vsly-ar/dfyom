/**
 * The host side of the workers: one pool per process with two lanes (`geometry`, `toolpath`),
 * one worker each, a FIFO queue per lane, timeouts, abort grace, crash-loop backoff and
 * recycling. Implements `WorkerPort`. Environment-neutral: workers come from a `WorkerFactory`
 * (`worker_threads` in src/main/workers/node.ts; fakes in tests).
 * Doc: docs/architecture/workers.md#lanes-and-pool, #worker-death-timeouts-and-restart
 */
import type { LogLevel, Logger } from '../../shared/logging'
import { noopLogger } from '../../shared/logging'
import { parseWith } from '../../shared/parse'
import {
  Err,
  fail,
  fromWire,
  tryCatch,
  type AppResult,
  type AsyncAppResult,
  type ResultWire,
} from '../../shared/result'
import { systemTimers, type Timers } from '../commands/context'
import {
  LANES,
  type Lane,
  type WorkerControl,
  type WorkerPort,
  type WorkerTask,
} from '../commands/jobs'
import { PROTOCOL_VERSION, WorkerMessage, type HostMessage, type ResultStats } from './protocol'
import { CONTROL_BYTES, RUN_STATE, setRunState } from './steps'

/** Events of one worker; the factory maps `error`/`messageerror` to `error`. */
export interface WorkerEvents {
  message(raw: unknown): void
  error(err: unknown): void
  exit(code: number): void
}

/** One spawned worker, as the pool sees it. */
export interface WorkerHandle {
  post(message: HostMessage, transfer?: readonly ArrayBuffer[]): void
  terminate(): void
  /** Idle workers must not keep the process alive (`unref()`); busy ones do. */
  setIdle(idle: boolean): void
}

export type WorkerFactory = (
  spec: { readonly lane: Lane; readonly workerId: string },
  events: WorkerEvents,
) => WorkerHandle

export interface PoolOptions {
  readonly factory: WorkerFactory
  readonly log?: Logger
  /** Level the workers log at (`init`). Default `info`. */
  readonly logLevel?: LogLevel
  /** `manifold.wasm` for the geometry lane, read once by the host and kept for restarts. */
  readonly wasm?: () => ArrayBuffer | undefined
  /** `cavalier_contours.wasm` for both lanes (the 2D port), read once by the host. */
  readonly region2dWasm?: () => ArrayBuffer | undefined
  readonly timers?: Timers
  /** Monotonic milliseconds (default `performance.now`). */
  readonly now?: () => number
  /** Log batches from a worker (the host passes them to `createForwardReceiver`). */
  readonly onLog?: (
    batch: unknown,
    origin: { readonly worker: string; readonly lane: Lane },
  ) => void
  /** After an abort or timeout, wait this long for the worker's `result`, then terminate. */
  readonly abortGraceMs?: number
  /** A worker that does not answer `init` within this is a crash. */
  readonly spawnTimeoutMs?: number
  readonly crashLoop?: {
    readonly crashes: number
    readonly windowMs: number
    readonly backoffMs: number
  }
  /** WASM heap above this after a task → recycle when idle. */
  readonly maxHeapBytes?: number
}

export const POOL_DEFAULTS = {
  abortGraceMs: 1_000,
  spawnTimeoutMs: 10_000,
  crashLoop: { crashes: 3, windowMs: 60_000, backoffMs: 30_000 },
  maxHeapBytes: 512 * 2 ** 20,
} as const

/** What the host measured for the last task of a lane. */
export interface LaneStats {
  readonly workerId: string
  readonly task: string
  readonly stats: ResultStats
  /** Host time to parse the output with the task's schema (ms). */
  readonly outputCheckMs: number
}

export interface WorkerPool extends WorkerPort {
  /** Spawn the lane's worker now (geometry: hides the cold WASM init). */
  prewarm(lane: Lane): void
  /** Terminate every worker; queued and running tasks end in `op.aborted`. */
  terminate(): void
  /** The last task's stats per lane (debug, perf). */
  lastStats(lane: Lane): LaneStats | undefined
}

interface Slot {
  readonly id: string
  readonly handle: WorkerHandle
  state: 'starting' | 'ready' | 'dead'
  /** Terminated by the pool: its exit is not a crash. */
  killed: boolean
  /** Recycle once the lane is idle (heap above the limit). */
  recycle: boolean
  spawnTimer: unknown
}

interface Pending {
  readonly task: WorkerTask<unknown, unknown>
  readonly input: unknown
  readonly ctl: WorkerControl
  settled: boolean
  resolve(r: AppResult<unknown>): void
  readonly cleanup: (() => void)[]
}

interface Active {
  readonly pending: Pending
  readonly slot: Slot
  readonly id: string
  readonly control: Int32Array
  /** Timeout timer (stopped while paused). */
  timer: unknown
  remainingMs: number
  timerStartedAt: number
  graceTimer: unknown
}

interface LaneState {
  readonly name: Lane
  slot: Slot | undefined
  readonly queue: Pending[]
  active: Active | undefined
  crashes: number[]
  blockedUntil: number
  /** Protocol mismatch: never spawn again. */
  broken: boolean
}

export function createWorkerPool(opts: PoolOptions): WorkerPool {
  const log = (opts.log ?? noopLogger).child({ scope: 'workers' })
  const timers = opts.timers ?? systemTimers
  const now = opts.now ?? (() => performance.now())
  const graceMs = opts.abortGraceMs ?? POOL_DEFAULTS.abortGraceMs
  const spawnTimeoutMs = opts.spawnTimeoutMs ?? POOL_DEFAULTS.spawnTimeoutMs
  const crashLoop = opts.crashLoop ?? POOL_DEFAULTS.crashLoop
  const maxHeap = opts.maxHeapBytes ?? POOL_DEFAULTS.maxHeapBytes
  const lanes = new Map<Lane, LaneState>(
    LANES.map((name) => [
      name,
      {
        name,
        slot: undefined,
        queue: [],
        active: undefined,
        crashes: [],
        blockedUntil: 0,
        broken: false,
      },
    ]),
  )
  const stats = new Map<Lane, LaneStats>()
  let workerCount = 0
  let runCount = 0
  let closed = false

  const unexpected = (message: string, data: Record<string, unknown>) =>
    fail('internal.unexpected', message, { where: 'workerPool', data })

  function settle(p: Pending, r: AppResult<unknown>): void {
    if (p.settled) return
    p.settled = true
    for (const c of p.cleanup) c()
    p.resolve(r)
  }

  function laneOf(name: Lane): LaneState {
    return lanes.get(name)!
  }

  // ── spawning ─────────────────────────────────────────────────────────────────────────────

  function spawn(lane: LaneState): Slot | undefined {
    const workerId = `${lane.name}-${++workerCount}`
    // events may only arrive once the slot exists
    const ref: { slot?: Slot } = {}
    const events: WorkerEvents = {
      message: (raw) => ref.slot !== undefined && onMessage(lane, ref.slot, raw),
      error: (err) =>
        ref.slot !== undefined &&
        onDeath(lane, ref.slot, {
          reason: 'error',
          error: err instanceof Error ? err.message : String(err),
        }),
      exit: (code) =>
        ref.slot !== undefined && onDeath(lane, ref.slot, { reason: 'exit', exitCode: code }),
    }
    const created = tryCatch(
      () => opts.factory({ lane: lane.name, workerId }, events),
      'internal.unexpected',
      'worker spawn failed',
    )
    if (created.isErr()) {
      log.error({ err: created.unwrapErr().toJSON(), lane: lane.name }, 'worker spawn failed')
      recordCrash(lane)
      return undefined
    }
    const s: Slot = {
      id: workerId,
      handle: created.unwrap(),
      state: 'starting',
      killed: false,
      recycle: false,
      spawnTimer: undefined,
    }
    ref.slot = s
    lane.slot = s
    s.spawnTimer = timers.set(() => {
      if (s.state !== 'starting') return
      log.error({ worker: s.id, lane: lane.name, spawnTimeoutMs }, 'worker did not get ready')
      kill(lane, s)
      onDeath(lane, s, { reason: 'spawnTimeout' }, true)
    }, spawnTimeoutMs)
    const wasm = lane.name === 'geometry' ? opts.wasm?.() : undefined
    const region2dWasm = opts.region2dWasm?.()
    const init: HostMessage = {
      type: 'init',
      protocol: PROTOCOL_VERSION,
      workerId,
      lane: lane.name,
      logLevel: opts.logLevel ?? 'info',
      ...(wasm === undefined ? {} : { wasm }),
      ...(region2dWasm === undefined ? {} : { region2dWasm }),
    }
    const posted = tryCatch(() => s.handle.post(init), 'internal.unexpected', 'init not posted')
    if (posted.isErr()) {
      kill(lane, s)
      onDeath(lane, s, { reason: 'init', error: posted.unwrapErr().message }, true)
      return undefined
    }
    log.debug({ worker: workerId, lane: lane.name }, 'worker spawned')
    return s
  }

  /** Terminate a worker on purpose (its exit is not a crash). */
  function kill(lane: LaneState, slot: Slot): void {
    if (slot.state === 'dead') return
    slot.killed = true
    slot.state = 'dead'
    timers.clear(slot.spawnTimer)
    if (lane.slot === slot) lane.slot = undefined
    tryCatch(() => slot.handle.terminate(), 'internal.unexpected', 'terminate failed')
  }

  function recordCrash(lane: LaneState): void {
    const t = now()
    lane.crashes = [...lane.crashes.filter((c) => t - c < crashLoop.windowMs), t]
    if (lane.crashes.length >= crashLoop.crashes) {
      lane.blockedUntil = t + crashLoop.backoffMs
      lane.crashes = []
      log.error(
        { lane: lane.name, backoffMs: crashLoop.backoffMs },
        'worker crash loop: lane stops spawning',
      )
      failQueue(lane, 'worker lane unavailable')
    }
  }

  function failQueue(lane: LaneState, message: string): void {
    for (const p of lane.queue.splice(0))
      settle(p, unexpected(message, { lane: lane.name, task: p.task.name }))
  }

  // ── worker events ────────────────────────────────────────────────────────────────────────

  function onMessage(lane: LaneState, slot: Slot, raw: unknown): void {
    if (slot.state === 'dead') return
    const parsed = parseWith(WorkerMessage, raw, 'workerPool')
    if (parsed.isErr()) {
      log.error({ worker: slot.id, err: parsed.unwrapErr().toJSON() }, 'malformed worker message')
      kill(lane, slot)
      onDeath(lane, slot, { reason: 'malformedMessage' }, true)
      return
    }
    const m = parsed.unwrap()
    switch (m.type) {
      case 'ready': {
        timers.clear(slot.spawnTimer)
        if (m.protocol !== PROTOCOL_VERSION) {
          log.error(
            { worker: slot.id, protocol: m.protocol, expected: PROTOCOL_VERSION },
            'worker protocol mismatch',
          )
          lane.broken = true
          kill(lane, slot)
          onDeath(lane, slot, { reason: 'protocol', protocol: m.protocol }, false)
          return
        }
        slot.state = 'ready'
        log.debug({ worker: slot.id, initMs: m.initMs, heapBytes: m.heapBytes }, 'worker ready')
        pump(lane)
        return
      }
      case 'log':
        opts.onLog?.(m.batch, { worker: slot.id, lane: lane.name })
        return
      case 'progress': {
        const a = lane.active
        if (a === undefined || a.id !== m.id || a.pending.settled) return
        a.pending.ctl.progress({
          done: m.done,
          ...(m.total === undefined ? {} : { total: m.total }),
          ...(m.label === undefined ? {} : { label: m.label }),
        })
        return
      }
      case 'checkpoint':
        log.debug(
          { worker: slot.id, run: m.id, state: m.state, label: m.label },
          'worker checkpoint',
        )
        return
      case 'result':
        onResult(lane, slot, m.id, m.result, m.stats)
        return
    }
  }

  function onResult(
    lane: LaneState,
    slot: Slot,
    id: string,
    wire: ResultWire<unknown>,
    s: ResultStats,
  ): void {
    const a = lane.active
    if (a === undefined || a.id !== id || a.slot !== slot) {
      log.debug({ worker: slot.id, run: id }, 'stale worker result dropped')
      return
    }
    timers.clear(a.timer)
    timers.clear(a.graceTimer)
    lane.active = undefined
    const task = a.pending.task
    let result = fromWire<unknown>(wire)
    const t0 = now()
    if (result.isOk()) {
      const out = parseWith(task.output, result.unwrap(), `worker ${task.name}`)
      result = out.isOk()
        ? out
        : unexpected(`${task.name}: malformed output from the worker`, {
            workerId: slot.id,
            lane: lane.name,
            task: task.name,
            issues: out.unwrapErr().issues.slice(0, 5),
          })
    }
    const outputCheckMs = now() - t0
    stats.set(lane.name, { workerId: slot.id, task: task.name, stats: s, outputCheckMs })
    log.debug(
      {
        worker: slot.id,
        task: task.name,
        ms: s.ms,
        heapBytes: s.heapBytes,
        liveObjects: s.liveObjects,
        outputCheckMs,
      },
      'task finished',
    )
    settle(a.pending, result)
    // recycling (docs/architecture/workers.md#wasm-lifetime)
    if (s.liveObjects !== undefined && s.liveObjects > 0) {
      log.error({ worker: slot.id, liveObjects: s.liveObjects }, 'solid objects leaked: recycling')
      kill(lane, slot)
    } else if (
      lane.name === 'geometry' &&
      result.isErr() &&
      result.unwrapErr().code === 'internal.unexpected'
    ) {
      log.warn({ worker: slot.id }, 'geometry task failed unexpectedly: recycling')
      kill(lane, slot)
    } else if (s.heapBytes !== undefined && s.heapBytes > maxHeap) {
      log.info({ worker: slot.id, heapBytes: s.heapBytes }, 'heap above limit: recycle when idle')
      slot.recycle = true
    }
    pump(lane)
  }

  function onDeath(
    lane: LaneState,
    slot: Slot,
    info: Record<string, unknown>,
    crash = !slot.killed,
  ): void {
    const wasLive = slot.state !== 'dead' || slot.killed
    // an `error`/`messageerror` worker may still be alive (ref'd, holding its heap): terminate
    // it; terminating an exited worker is harmless
    if (!slot.killed) kill(lane, slot)
    const a = lane.active
    if (a !== undefined && a.slot === slot) {
      timers.clear(a.timer)
      timers.clear(a.graceTimer)
      lane.active = undefined
      settle(
        a.pending,
        unexpected(`worker ${slot.id} died while running ${a.pending.task.name}`, {
          workerId: slot.id,
          lane: lane.name,
          task: a.pending.task.name,
          ...info,
        }),
      )
    }
    if (crash && wasLive) {
      log.warn({ worker: slot.id, lane: lane.name, ...info }, 'worker died')
      recordCrash(lane)
    }
    if (lane.broken) failQueue(lane, 'worker protocol mismatch (a build bug)')
    pump(lane)
  }

  // ── running ──────────────────────────────────────────────────────────────────────────────

  function pump(lane: LaneState): void {
    if (closed || lane.active !== undefined) return
    if (lane.queue.length === 0) {
      const slot = lane.slot
      if (slot === undefined) return
      if (slot.recycle) {
        log.info({ worker: slot.id }, 'recycling idle worker')
        kill(lane, slot)
      } else slot.handle.setIdle(true)
      return
    }
    if (lane.broken) return failQueue(lane, 'worker protocol mismatch (a build bug)')
    if (now() < lane.blockedUntil) return failQueue(lane, 'worker lane unavailable')
    const slot = lane.slot ?? spawn(lane)
    if (slot === undefined) return pump(lane) // spawn failed (counted as a crash)
    if (slot.state !== 'ready') return // `ready` pumps again
    const pending = lane.queue.shift()!
    start(lane, slot, pending)
  }

  function start(lane: LaneState, slot: Slot, p: Pending): void {
    const control = new Int32Array(new SharedArrayBuffer(CONTROL_BYTES))
    const a: Active = {
      pending: p,
      slot,
      id: `${slot.id}:${++runCount}`,
      control,
      timer: undefined,
      remainingMs: p.task.timeoutMs,
      timerStartedAt: 0,
      graceTimer: undefined,
    }
    lane.active = a
    slot.handle.setIdle(false)
    const pause = p.ctl.pause
    if (pause !== undefined) {
      if (pause.paused) setRunState(control, RUN_STATE.pause)
      p.cleanup.push(
        pause.onChange((paused) => {
          if (lane.active !== a || p.settled) return
          if (paused) {
            setRunState(control, RUN_STATE.pause)
            stopTimer(a)
          } else {
            setRunState(control, RUN_STATE.run)
            startTimer(lane, a)
          }
        }),
      )
    }
    if (pause?.paused !== true) startTimer(lane, a)
    const posted = tryCatch(
      () =>
        slot.handle.post({
          type: 'run',
          id: a.id,
          task: p.task.name,
          input: p.input,
          control: control.buffer as SharedArrayBuffer,
        }),
      'internal.unexpected',
      `${p.task.name}: input could not be posted`,
    )
    if (posted.isErr()) {
      timers.clear(a.timer)
      lane.active = undefined
      settle(p, Err(posted.unwrapErr().withContext('workerPool', { task: p.task.name })))
      pump(lane)
    }
  }

  function startTimer(lane: LaneState, a: Active): void {
    a.timerStartedAt = now()
    a.timer = timers.set(() => {
      if (lane.active !== a || a.pending.settled) return
      log.warn(
        { worker: a.slot.id, task: a.pending.task.name, timeoutMs: a.pending.task.timeoutMs },
        'worker task timed out',
      )
      stopRun(
        lane,
        a,
        fail(
          'op.timeout',
          `${a.pending.task.name} took longer than ${a.pending.task.timeoutMs} ms`,
          {
            where: 'workerPool',
            data: { workerId: a.slot.id, lane: lane.name, task: a.pending.task.name },
          },
        ),
      )
    }, a.remainingMs)
  }

  function stopTimer(a: Active): void {
    timers.clear(a.timer)
    a.timer = undefined
    a.remainingMs = Math.max(0, a.remainingMs - (now() - a.timerStartedAt))
  }

  /** Abort or timeout: resolve now, free the lane when the worker answers or the grace ends. */
  function stopRun(lane: LaneState, a: Active, r: AppResult<unknown>): void {
    setRunState(a.control, RUN_STATE.abort)
    timers.clear(a.timer)
    settle(a.pending, r)
    a.graceTimer = timers.set(() => {
      if (lane.active !== a) return
      log.warn(
        { worker: a.slot.id, task: a.pending.task.name, graceMs },
        'no result after abort: terminating',
      )
      lane.active = undefined
      kill(lane, a.slot)
      pump(lane)
    }, graceMs)
  }

  // ── port ─────────────────────────────────────────────────────────────────────────────────

  return {
    run<I, O>(task: WorkerTask<I, O>, input: I, ctl: WorkerControl): AsyncAppResult<O> {
      const where = `worker ${task.name}`
      const lane = laneOf(task.lane)
      if (closed) return Promise.resolve(fail('op.aborted', 'the worker pool is closed', { where }))
      if (ctl.signal.aborted) return Promise.resolve(fail('op.aborted', 'aborted', { where }))
      return new Promise<AppResult<O>>((resolve) => {
        const p: Pending = {
          task: task as WorkerTask<unknown, unknown>,
          input,
          ctl,
          settled: false,
          resolve: resolve as (r: AppResult<unknown>) => void,
          cleanup: [],
        }
        const onAbort = () => {
          const queued = lane.queue.indexOf(p)
          if (queued >= 0) {
            lane.queue.splice(queued, 1)
            settle(p, fail('op.aborted', `${task.name} was aborted`, { where }))
            return
          }
          const a = lane.active
          if (a !== undefined && a.pending === p)
            stopRun(lane, a, fail('op.aborted', `${task.name} was aborted`, { where }))
        }
        ctl.signal.addEventListener('abort', onAbort, { once: true })
        p.cleanup.push(() => ctl.signal.removeEventListener('abort', onAbort))
        lane.queue.push(p)
        pump(lane)
      })
    },
    prewarm(name) {
      const lane = laneOf(name)
      if (closed || lane.slot !== undefined || lane.broken || now() < lane.blockedUntil) return
      spawn(lane)
    },
    terminate() {
      closed = true
      for (const lane of lanes.values()) {
        for (const p of lane.queue.splice(0))
          settle(p, fail('op.aborted', 'the worker pool was closed', { where: 'workerPool' }))
        const a = lane.active
        lane.active = undefined
        if (a !== undefined) {
          timers.clear(a.timer)
          timers.clear(a.graceTimer)
          settle(
            a.pending,
            fail('op.aborted', 'the worker pool was closed', { where: 'workerPool' }),
          )
        }
        if (lane.slot !== undefined) kill(lane, lane.slot)
      }
    },
    lastStats: (lane) => stats.get(lane),
  }
}
