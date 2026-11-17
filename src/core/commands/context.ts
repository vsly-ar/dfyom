/**
 * What a handler may use besides its args: source, ids, clock and injected service ports.
 * Doc: docs/architecture/commands.md#command-definition
 *
 * Ports keep src/core headless: each process injects its own implementations.
 */
import type { EntryPoint } from '../../shared/boundary'
import type { Library } from '../library/library'
import type { ProjectSession } from '../project/storage'
import type { EvaluationService } from '../design/evaluation'
import type { ToolpathCache } from '../toolpath/cache'
import type { JobHandle, WorkerPort } from './jobs'
import type { Option } from '../../shared/result'

/**
 * A per-session identity: one window, MCP session, CLI invocation or script run.
 * Doc: docs/architecture/commands.md#stale-writes
 */
export interface Source {
  readonly kind: EntryPoint['kind']
  readonly id: string
}

/** Stable map key of a source. */
export function sourceKey(s: Source): string {
  return `${s.kind}:${s.id}`
}

export function sameSource(a: Source, b: Source): boolean {
  return a.kind === b.kind && a.id === b.id
}

/** Generates ids for new records; deterministic in tests (`fakeIds` in testing.ts). */
export interface IdGenerator {
  next(prefix: string): string
}

/** Wall clock in epoch milliseconds; fake in tests. */
export interface Clock {
  now(): number
}

/** One-shot timers (debounce, timeouts); fake in tests. Doc: docs/architecture/workers.md */
export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/**
 * Injected service ports. The machine port arrives with run mode (task 3.9).
 */
export interface Services {
  readonly workers: WorkerPort
  /**
   * Automatic part evaluation (docs/architecture/workers.md#automatic-evaluation-after-design-edits);
   * absent = no geometry warnings (`evaluation: 'pending'`) and `design.part.evaluate` fails.
   */
  readonly evaluations?: EvaluationService
  /** Toolpath cache of the project (docs/architecture/workers.md#toolpath-cache); absent = toolpath commands fail. */
  readonly toolpaths?: ToolpathCache
  /** The shared library (docs/architecture/library.md#storage); absent = library commands fail. */
  readonly library?: Library
  /** Persistence of the open project (docs/architecture/persistence.md); absent in tests. */
  readonly project?: ProjectSession
}

export interface CommandContext {
  readonly source: Source
  readonly ids: IdGenerator
  readonly clock: Clock
  readonly services: Services
}

/** Progress of a job; `total` unknown for indeterminate work. */
export interface JobProgress {
  readonly done: number
  readonly total?: number
  readonly label?: string
}

/** Whether a job is paused, observable (workers park at their next step while it is). */
export interface PauseState {
  readonly paused: boolean
  /** Called on every pause and resume; returns the unsubscribe. */
  onChange(listener: (paused: boolean) => void): () => void
}

export interface JobContext extends CommandContext {
  readonly signal: AbortSignal
  readonly progress: (p: JobProgress) => void
  /** Resolves when the job is not paused; rejects with an `AbortError` once aborted. */
  readonly checkpoint: () => Promise<void>
  /** Pass to `workers.run` so a pause also parks the worker mid-task. */
  readonly pause: PauseState
}

/** The dispatcher's jobs, for `job.get` / `job.list`: running and the retained finished ones. */
export interface JobDirectory {
  get(jobId: string): Option<JobHandle>
  list(): readonly JobHandle[]
}

export interface QueryContext {
  readonly source: Source
  readonly services: Services
  /** Set by the dispatcher; absent when a query runs without one (tests). */
  readonly jobs?: JobDirectory
}

export const systemIds: IdGenerator = { next: (prefix) => `${prefix}-${crypto.randomUUID()}` }
export const systemClock: Clock = { now: () => Date.now() }
export const systemTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}
