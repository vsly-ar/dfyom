/**
 * Long-running commands: job handles, progress, pause/resume/abort, and the worker port.
 * Doc: docs/architecture/commands.md#long-running-commands-jobs
 */
import { z } from 'zod'
import { Err, fail, tryAsync, type AppResult, type AsyncAppResult } from '../../shared/result'
import type { ProjectDoc } from '../project/document'
import type { CommandContext, JobContext, JobProgress, Source } from './context'
import type { BuiltinCommand, JobCommand } from './define'

/** Controls passed to a worker task. */
export interface WorkerControl {
  readonly signal: AbortSignal
  readonly progress: (p: JobProgress) => void
}

/** A unit of heavy work that a worker can run; `name` identifies it across threads. */
export interface WorkerTask<I, O> {
  readonly name: string
  run(input: I, ctl: WorkerControl): AsyncAppResult<O>
}

/**
 * Where job handlers send heavy work. Abstract on purpose: task 2.9 provides Web Worker /
 * `worker_threads` implementations (ADR 0008); until then `inProcessWorkers` runs tasks inline.
 */
export interface WorkerPort {
  run<I, O>(task: WorkerTask<I, O>, input: I, ctl: WorkerControl): AsyncAppResult<O>
}

/** In-process stub of the worker port (tests, and the app until task 2.9). */
export const inProcessWorkers: WorkerPort = {
  run: <I, O>(task: WorkerTask<I, O>, input: I, ctl: WorkerControl): Promise<AppResult<O>> =>
    task.run(input, ctl),
}

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
  private latest: JobProgress | undefined
  private lastEmitMs = Number.NEGATIVE_INFINITY
  private readonly listeners = new Set<(p: JobProgress) => void>()
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
    const jobCtx: JobContext = {
      ...ctx,
      signal: this.controller.signal,
      progress: (p) => this.report(p, ctx.clock.now()),
      checkpoint: () => this.checkpoint(),
    }
    this.result = started.then(() => this.execute(doc, args, jobCtx))
  }

  get state(): JobState {
    return this.currentState
  }

  get progress(): JobProgress | undefined {
    return this.latest
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
  }

  resume(): void {
    if (this.currentState !== 'paused') return
    this.currentState = 'running'
    this.opts.onLifecycle('resumed')
    this.wakeUp()
  }

  abort(): void {
    if (this.currentState === 'finished') return
    this.controller.abort()
    this.wakeUp()
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
    this.opts.onLifecycle('finished', result)
    return result
  }
}
