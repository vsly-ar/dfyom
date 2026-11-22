/**
 * Long-running commands: job handles, progress, pause/resume/abort, the job queries and the
 * worker port. Docs: docs/architecture/commands.md#long-running-commands-jobs,
 * docs/architecture/workers.md#contract-changes
 */
import { z } from 'zod'
import { AppError } from '../../shared/errors/app-error'
import { ResultWireSchema } from '../../shared/errors/schema'
import { noopLogger, type Logger } from '../../shared/logging'
import { parseWith } from '../../shared/parse'
import {
  Err,
  fail,
  fromWire,
  Ok,
  toWire,
  tryAsync,
  tryCatch,
  type AppResult,
  type AsyncAppResult,
} from '../../shared/result'
import type { Region2dPort } from '../geometry/2d/port'
import type { SolidKernel } from '../geometry/solid-port'
import type { ProjectDoc } from '../project/document'
import { aborted, signalSteps, type Steps } from '../workers/steps'
import type {
  CommandContext,
  JobContext,
  JobDirectory,
  JobProgress,
  PauseState,
  QueryContext,
  Source,
} from './context'
import { defineQuery, type BuiltinCommand, type JobCommand } from './define'

/** Worker lanes, one worker each (docs/architecture/workers.md#lanes-and-pool). */
export const LANES = ['geometry', 'toolpath'] as const
export type Lane = (typeof LANES)[number]

/** Host side, passed by the job handler (a `JobContext` fits). */
export interface WorkerControl {
  readonly signal: AbortSignal
  readonly progress: (p: JobProgress) => void
  /** Absent for automatic evaluations: they never pause. */
  readonly pause?: PauseState
}

/** Inside the worker (or inline in the fake). */
export interface TaskControl {
  /** Abort and pause between steps, progress per step. */
  readonly steps: Steps
  readonly log: Logger
  /** The solid kernel, loaded once per worker (geometry lane only). */
  readonly solids: () => AsyncAppResult<SolidKernel>
  /**
   * The 2D port (offsets, booleans of line/arc loops), loaded synchronously once per worker on
   * first use (geometry and toolpath lanes). Doc: docs/architecture/shapes.md#where-the-2d-layer-runs
   */
  readonly region2d: () => AppResult<Region2dPort>
  /** Read-only access to local files (e.g. a project asset to parse); injected by the host. */
  readonly files: FileSource
}

/** A local file opened for reading: its size and its bytes as a stream of chunks. */
export interface OpenedFile {
  readonly size: number
  /** Chunks in order; iteration throws on an I/O error (the task maps it). */
  readonly chunks: AsyncIterable<Uint8Array>
}

/**
 * Streamed, read-only file access for worker tasks, so core code parses files without Node
 * imports. Doc: docs/architecture/workers.md#file-access
 */
export interface FileSource {
  /** `input.malformed` (rule `unreadableFile`) if the path is not a readable regular file. */
  open(path: string): AsyncAppResult<OpenedFile>
}

/** No file access (the default of hosts that inject none). */
export const noFiles: FileSource = {
  open: (path) =>
    Promise.resolve(
      fail('internal.unexpected', 'no file access in this worker host', {
        where: 'files.open',
        data: { path },
      }),
    ),
}

/** Files served from memory, keyed by path (tests). */
export function memoryFiles(
  files: ReadonlyMap<string, Uint8Array>,
  chunkBytes = 64 * 1024,
): FileSource {
  return {
    open(path) {
      const bytes = files.get(path)
      if (bytes === undefined)
        return Promise.resolve(
          fail('input.malformed', `cannot read ${path}`, {
            where: 'files.open',
            issues: [{ path: ['path'], rule: 'unreadableFile', message: 'no such file' }],
          }),
        )
      async function* chunks(): AsyncIterable<Uint8Array> {
        for (let i = 0; i < bytes!.length; i += chunkBytes) yield bytes!.subarray(i, i + chunkBytes)
      }
      return Promise.resolve(Ok({ size: bytes.length, chunks: chunks() }))
    },
  }
}

/**
 * A unit of heavy work that a worker can run. Only `name` crosses the thread: the worker looks
 * the task up in its registry (`WORKER_TASKS`, src/core/workers/tasks.ts).
 */
export interface WorkerTask<I, O> {
  /** e.g. `geometry.evaluate`, `toolpath.generate`. */
  readonly name: string
  readonly lane: Lane
  /** Checked in the worker. */
  readonly input: z.ZodType<I>
  /** Checked in the host. */
  readonly output: z.ZodType<O>
  /** Wall-clock limit, excluding paused time → `op.timeout`. */
  readonly timeoutMs: number
  /** Typed arrays of an output to transfer instead of clone (each must own its whole buffer). */
  readonly transfer?: (output: O) => readonly TransferView[]
  run(input: I, ctl: TaskControl): AppResult<O> | AsyncAppResult<O>
}

/** A typed array whose buffer is transferred (worker → host). */
export interface TransferView {
  readonly buffer: ArrayBufferLike
  readonly byteOffset: number
  readonly byteLength: number
}

/** Any task, for registries (`run` only ever gets input its own schema parsed). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWorkerTask = WorkerTask<any, any>

/**
 * Where job handlers send heavy work: the worker pool (src/core/workers/pool.ts) in the app and
 * CLI, the in-process fake in tests. Resolves `op.aborted` as soon as `signal` aborts.
 */
export interface WorkerPort {
  run<I, O>(task: WorkerTask<I, O>, input: I, ctl: WorkerControl): AsyncAppResult<O>
}

export interface InProcessOptions {
  /**
   * Send input and output through `structuredClone` and the task's schemas, as the real
   * boundary does (default true), so cloning and schema bugs show up without threads.
   */
  readonly clone?: boolean
  /** Loads the solid kernel for geometry tasks, once (default: fails – no WASM in the fake). */
  readonly solids?: () => AsyncAppResult<SolidKernel>
  /** Loads the 2D port for tasks, once (default: fails – no WASM in the fake). */
  readonly region2d?: () => AppResult<Region2dPort>
  /** File access of tasks (default: none). */
  readonly files?: FileSource
  readonly log?: Logger
}

/**
 * The worker port without threads: runs `task.run` inline with `Steps` backed by the
 * `AbortSignal` (pause is a no-op inside a task). Doc: docs/architecture/workers.md#testing
 */
export function createInProcessWorkers(opts: InProcessOptions = {}): WorkerPort {
  const clone = opts.clone ?? true
  let kernel: AsyncAppResult<SolidKernel> | undefined
  const solids = (): AsyncAppResult<SolidKernel> =>
    (kernel ??=
      opts.solids?.() ??
      Promise.resolve(fail('internal.unexpected', 'no solid kernel in the in-process fake')))
  let port: AppResult<Region2dPort> | undefined
  const region2d = (): AppResult<Region2dPort> =>
    (port ??= opts.region2d?.() ?? fail('internal.unexpected', 'no 2D port in the in-process fake'))
  return {
    async run<I, O>(task: WorkerTask<I, O>, input: I, ctl: WorkerControl): AsyncAppResult<O> {
      const where = `worker ${task.name}`
      if (ctl.signal.aborted) return aborted(where)
      let arg: I = input
      if (clone) {
        const cloned = tryCatch(() => structuredClone(input), 'internal.unexpected', 'uncloneable')
        if (cloned.isErr()) return Err(cloned.unwrapErr().withContext(where))
        const parsed = parseWith(task.input, cloned.unwrap(), where)
        if (parsed.isErr()) return Err(parsed.unwrapErr())
        arg = parsed.unwrap()
      }
      const control: TaskControl = {
        steps: signalSteps(ctl.signal, ctl.progress),
        log: (opts.log ?? noopLogger).child({ task: task.name }),
        solids,
        region2d,
        files: opts.files ?? noFiles,
      }
      const ran = await tryAsync(
        async () => task.run(arg, control),
        'internal.unexpected',
        `${task.name} threw`,
      )
      const result: AppResult<O> = ran.isOk() ? ran.unwrap() : Err(ran.unwrapErr())
      if (!clone) return result
      if (result.isErr()) return fromWire<O>(structuredClone(toWire(result)))
      const out = tryCatch(
        () => structuredClone(result.unwrap()),
        'internal.unexpected',
        'uncloneable',
      )
      if (out.isErr()) return Err(out.unwrapErr().withContext(where))
      return parseWith(task.output, out.unwrap(), where).mapErr(
        (e) =>
          new AppError('internal.unexpected', `${task.name}: malformed output`, {
            issues: e.issues,
            where,
          }),
      )
    },
  }
}

/** In-process worker port with the default options (tests; no solid kernel). */
export const inProcessWorkers: WorkerPort = createInProcessWorkers()

export const JOB_STATES = ['running', 'paused', 'finished'] as const
export type JobState = (typeof JOB_STATES)[number]

const JobControlArgs = z.object({ jobId: z.string().describe('Id returned when the job started') })
const JobControlResult = z.object({ state: z.enum(JOB_STATES).describe('Job state afterwards') })
type JobControl = BuiltinCommand<typeof JobControlArgs, z.output<typeof JobControlResult>>

const control = (name: string, summary: string, title: string): JobControl => ({
  kind: 'builtin',
  name,
  summary,
  title: () => title,
  machine: false,
  // a stop must never wait behind an effect that waits for the machine
  urgent: true,
  args: JobControlArgs,
  result: JobControlResult,
})

export const jobPause = control(
  'job.pause',
  'Pause a running job at its next checkpoint.',
  'Pause job',
)
export const jobResume = control('job.resume', 'Resume a paused job.', 'Resume job')
export const jobAbort = control(
  'job.abort',
  'Abort a job; its result becomes op.aborted.',
  'Abort job',
)

// ── job queries (docs/architecture/workers.md#jobs-for-agents) ──────────────────────────────

const JobProgressSchema = z.object({
  done: z.number(),
  total: z.number().optional(),
  label: z.string().optional(),
})

export const JobInfoSchema = z.object({
  jobId: z.string(),
  name: z.string().describe('The job command'),
  state: z.enum(JOB_STATES),
  progress: JobProgressSchema.optional(),
  startRevision: z.number().describe('Revision when the job started'),
  outcome: ResultWireSchema.optional().describe(
    'Only once finished: { ok: true, value } or { ok: false, error }',
  ),
})

function jobInfo(j: JobHandle): z.output<typeof JobInfoSchema> {
  const outcome = j.outcome
  return {
    jobId: j.id,
    name: j.name,
    state: j.state,
    ...(j.progress === undefined ? {} : { progress: j.progress }),
    startRevision: j.startRevision,
    ...(outcome === undefined ? {} : { outcome: toWire(outcome) }),
  }
}

function jobsOf(ctx: QueryContext, where: string): AppResult<JobDirectory> {
  return ctx.jobs === undefined
    ? fail('internal.unexpected', 'no job directory (query run outside a dispatcher)', { where })
    : Ok(ctx.jobs)
}

export const jobGet = defineQuery({
  name: 'job.get',
  summary: 'Get a job: state, progress, start revision and, once finished, its outcome.',
  args: JobControlArgs,
  result: JobInfoSchema,
  readsDocument: false,
  run(_doc, args, ctx) {
    const where = 'job.get'
    return jobsOf(ctx, where).andThen((jobs) => {
      const j = jobs.get(args.jobId)
      return j.isSome()
        ? Ok(jobInfo(j.unwrap()))
        : fail('input.malformed', `no job ${args.jobId}`, {
            issues: [{ path: ['jobId'], rule: 'unknownJob', message: 'no such job' }],
            where,
          })
    })
  },
})

export const jobList = defineQuery({
  name: 'job.list',
  summary: 'List the running jobs and the retained finished ones, oldest first.',
  args: z.object({}),
  result: z.object({ jobs: z.array(JobInfoSchema) }),
  readsDocument: false,
  run(_doc, _args, ctx) {
    return jobsOf(ctx, 'job.list').map((jobs) => ({ jobs: jobs.list().map(jobInfo) }))
  },
})

/** Read-only view of a started job. */
export interface JobHandle<R = unknown> {
  readonly id: string
  /** Name of the job command. */
  readonly name: string
  readonly source: Source
  /** Revision when the job started: pass it as `expectedRevision` to the follow-up document command. */
  readonly startRevision: number
  readonly state: JobState
  /** Latest progress (unthrottled). */
  readonly progress: JobProgress | undefined
  /** Throttled progress stream (at most one tick per interval, plus completion ticks). */
  onProgress(listener: (p: JobProgress) => void): () => void
  /** Settles when the job finishes; aborted jobs end in `op.aborted`. */
  readonly result: AsyncAppResult<R>
  /** The result once finished (readable synchronously, for `job.get`). */
  readonly outcome: AppResult<R> | undefined
}

export type JobLifecycle = 'started' | 'paused' | 'resumed' | 'finished'

export interface JobOptions {
  readonly id: string
  readonly startRevision: number
  readonly progressIntervalMs: number
  /** Called on each lifecycle transition (the dispatcher logs them). */
  readonly onLifecycle: (state: JobLifecycle, outcome?: AppResult<unknown>) => void
}

/** A job run in-process; heavy work inside goes through `ctx.services.workers`. */
export class JobRun<R = unknown> implements JobHandle<R> {
  readonly id: string
  readonly name: string
  readonly source: Source
  readonly startRevision: number
  readonly result: AsyncAppResult<R>
  private currentState: JobState = 'running'
  private finalOutcome: AppResult<R> | undefined
  private latest: JobProgress | undefined
  private lastEmitMs = Number.NEGATIVE_INFINITY
  private readonly listeners = new Set<(p: JobProgress) => void>()
  private readonly pauseListeners = new Set<(paused: boolean) => void>()
  private readonly controller = new AbortController()
  /** Every checkpoint currently parked (a job may await several at once). */
  private waiters: (() => void)[] = []
  private begin: () => void = () => {}

  constructor(
    private readonly def: JobCommand<z.ZodType, R>,
    doc: ProjectDoc,
    args: unknown,
    ctx: CommandContext,
    private readonly opts: JobOptions,
  ) {
    this.id = opts.id
    this.name = def.name
    this.source = ctx.source
    this.startRevision = opts.startRevision
    const started = new Promise<void>((resolve) => (this.begin = resolve))
    const isPaused = () => this.currentState === 'paused'
    const pause: PauseState = {
      get paused() {
        return isPaused()
      },
      onChange: (listener) => {
        this.pauseListeners.add(listener)
        return () => {
          this.pauseListeners.delete(listener)
        }
      },
    }
    const jobCtx: JobContext = {
      ...ctx,
      jobId: opts.id,
      signal: this.controller.signal,
      progress: (p) => this.report(p, ctx.clock.now()),
      checkpoint: () => this.checkpoint(),
      pause,
    }
    this.result = started.then(() => this.execute(doc, args, jobCtx))
  }

  get state(): JobState {
    return this.currentState
  }

  get progress(): JobProgress | undefined {
    return this.latest
  }

  get outcome(): AppResult<R> | undefined {
    return this.finalOutcome
  }

  onProgress(listener: (p: JobProgress) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Starts the handler (after the dispatcher has logged the dispatch). */
  start(): void {
    this.begin()
  }

  pause(): void {
    if (this.currentState !== 'running') return
    this.currentState = 'paused'
    this.opts.onLifecycle('paused')
    this.notifyPause(true)
  }

  resume(): void {
    if (this.currentState !== 'paused') return
    this.currentState = 'running'
    this.opts.onLifecycle('resumed')
    this.notifyPause(false)
    this.wakeUp()
  }

  abort(): void {
    if (this.currentState === 'finished') return
    this.controller.abort()
    this.wakeUp()
  }

  private notifyPause(paused: boolean): void {
    for (const l of [...this.pauseListeners]) l(paused)
  }

  private wakeUp(): void {
    const all = this.waiters
    this.waiters = []
    for (const w of all) w()
  }

  private async checkpoint(): Promise<void> {
    while (this.currentState === 'paused' && !this.controller.signal.aborted)
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.controller.signal.throwIfAborted()
  }

  private report(p: JobProgress, nowMs: number): void {
    this.latest = p
    const complete = p.total !== undefined && p.done >= p.total
    if (!complete && nowMs - this.lastEmitMs < this.opts.progressIntervalMs) return
    this.lastEmitMs = nowMs
    for (const l of [...this.listeners]) l(p)
  }

  private async execute(doc: ProjectDoc, args: unknown, ctx: JobContext): AsyncAppResult<R> {
    this.opts.onLifecycle('started')
    const ran = await tryAsync(
      () => this.def.run(doc, args, ctx),
      'internal.unexpected',
      `${this.name} threw`,
    )
    let result: AppResult<R> = ran.isOk() ? ran.unwrap() : Err(ran.unwrapErr())
    const abortedErr = result.isErr() && result.unwrapErr().code === 'op.aborted'
    if (this.controller.signal.aborted && !abortedErr)
      result = fail('op.aborted', `${this.name} was aborted`, {
        where: this.name,
        data: { jobId: this.id },
      })
    this.currentState = 'finished'
    this.finalOutcome = result
    this.pauseListeners.clear()
    this.opts.onLifecycle('finished', result)
    return result
  }
}
