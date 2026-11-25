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
import type { ExportFiles } from '../post/plan-export'
import type { JobHandle, WorkerPort } from './jobs'
import type { HistoryEntry } from './history'
import type { ApplyView } from './apply'
import type { HostPort } from '../project/lifecycle'
import type { Region2dPort } from '../geometry/2d/port'
import type { MachineService } from '../run/service'
import type { GcodeFiles } from '../run/gcode-file'
import type { AsyncAppResult, Option } from '../../shared/result'

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
 * Injected service ports.
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
  /**
   * The machine connection of the app instance (docs/modes/run-v0.1.md#commands-and-queries);
   * absent = run commands fail with `run.notConnected`.
   */
  readonly machine?: MachineService
  /**
   * Reads external gCode files for a run (DF93, docs/modes/run.md#run-an-external-g-code-file-df93);
   * absent = `run.job.start { file }` fails.
   */
  readonly gcodeFiles?: GcodeFiles
  /** Writes exported gCode files (docs/architecture/grbl.md#plan-export-command); absent = `plan.export` fails. */
  readonly exportFiles?: ExportFiles
  /**
   * The app host, for the app-scope `project.*` lifecycle commands
   * (docs/architecture/llm-api.md#app-scope-and-project-scope); absent = they fail.
   */
  readonly host?: HostPort
  /**
   * The 2D port (offsets and booleans of shapes), loaded synchronously at host start
   * (docs/architecture/shapes.md#where-the-2d-layer-runs); absent = shape commands fail (K2).
   */
  readonly region2d?: Region2dPort
  /**
   * The app's version (package.json at runtime), for the gCode header's `Generator:` line
   * (docs/architecture/grbl.md#plan-export-command); absent (core tests) = `DFYOM` alone.
   */
  readonly appVersion?: string
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
  /** The dispatcher's id of this job (what `{ jobId }` returned). */
  readonly jobId: string
  readonly signal: AbortSignal
  readonly progress: (p: JobProgress) => void
  /** Resolves when the job is not paused; rejects with an `AbortError` once aborted. */
  readonly checkpoint: () => Promise<void>
  /** Pass to `workers.run` so a pause also parks the worker mid-task. */
  readonly pause: PauseState
  /**
   * For jobs with the `handled` pause policy: how `job.pause`/`job.resume` act while the work can
   * be held (e.g. a feed hold during a probe cycle); returns the unregister. While none is
   * registered, `job.pause` fails `job.notPausable`. Doc: docs/architecture/commands.md#pausing-a-job
   */
  readonly onPause: (handler: PauseHandler) => () => void
  /**
   * For `handled` jobs: the work was held or released without `job.pause`/`job.resume` (a hold
   * the machine reports that DFYOM did not send: its hold button or safety door, DF82). The job's
   * state follows (`paused`/`running`, with the lifecycle event), so `job.resume` resumes it as
   * usual. A no-op for other policies or a finished job. Doc: docs/architecture/commands.md#pausing-a-job
   */
  readonly adoptPause: (paused: boolean) => void
}

/** Holds and resumes a job's work (`JobContext.onPause`). */
export interface PauseHandler {
  /** Resolves once the work stands still; an `Err` leaves the job running. */
  hold(): AsyncAppResult<void>
  /** Resolves once the work continues. */
  resume(): AsyncAppResult<void>
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
  /** The dispatcher's undo/redo stacks (`history.list`); absent without a dispatcher. */
  readonly history?: HistoryView
  /** The dispatcher's pending changes and apply jobs (`project.pending.get`); absent without one. */
  readonly apply?: ApplyView
}

/** Read-only view of a dispatcher's linear history (docs/architecture/commands.md#undo--redo). */
export interface HistoryView {
  /** Oldest first; the last entry is undone next. */
  readonly undoable: readonly HistoryEntry[]
  /** Oldest first; the last entry is redone next. */
  readonly redoable: readonly HistoryEntry[]
}

export const systemIds: IdGenerator = { next: (prefix) => `${prefix}-${crypto.randomUUID()}` }
export const systemClock: Clock = { now: () => Date.now() }
export const systemTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}
