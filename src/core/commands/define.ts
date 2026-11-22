/**
 * Command and query definitions – the single definition every adapter (UI, MCP, CLI) dispatches.
 * Doc: docs/architecture/commands.md#command-definition
 *
 * `run`/`title` are method signatures (bivariant) so typed definitions fit `AnyCommand` in the
 * registry; the dispatcher always passes args parsed by the definition's own `args` schema.
 */
import type { Draft } from 'immer'
import type { z } from 'zod'
import type { AppResult, AsyncAppResult } from '../../shared/result'
import type { ProjectDoc } from '../project/document'
import type { ApplyOutcome, PendingChange, PlanApply, ToolChange } from './apply'
import type { CommandContext, JobContext, QueryContext } from './context'

export type CommandKind = 'document' | 'effect' | 'job'

interface CommandMeta<A> {
  /** `<area>.<object>.<verb>` (docs/architecture/commands.md#naming). */
  readonly name: string
  /** Agent/tool description; imperative, one sentence. */
  readonly summary: string
  /** UI label and undo menu text ("Add pocket"). */
  title(args: A): string
  /** Affects a real machine → permission check. */
  readonly machine: boolean
  /**
   * Skips the project's FIFO queue: runs at once even while an effect holds it (the emergency
   * paths: `run.machine.reset`, jog cancel; the `job.*` controls). Only for commands that touch
   * no document. Doc: docs/architecture/commands.md#concurrency
   */
  readonly urgent?: boolean
  /**
   * Implicit apply: the dispatcher runs `project.apply` in the same queue turn before this
   * command (its own log event and entry, the caller's source). For commands that consume the
   * confirmed design or leave the project; a function decides per args (`plan.status.set` into
   * `draft`). Doc: docs/architecture/apply.md#implicit-apply
   */
  readonly applyFirst?: boolean | ArgsPredicate<A>
}

/** A per-args predicate, bivariant like the `run`/`title` methods (see the file comment). */
type ArgsPredicate<A> = { check(args: A): boolean }['check']

/** Sync, undoable, changes `ProjectDoc` only. Never awaits, calls services or dispatches. */
export interface DocumentCommand<S extends z.ZodType = z.ZodType, R = unknown> extends CommandMeta<
  z.output<S>
> {
  readonly kind: 'document'
  readonly args: S
  readonly result: z.ZodType<R>
  run(draft: Draft<ProjectDoc>, args: z.output<S>, ctx: CommandContext): AppResult<R>
}

/** Async, not undoable, never touches `ProjectDoc` (save, export, jog). Holds the queue. */
export interface EffectCommand<S extends z.ZodType = z.ZodType, R = unknown> extends CommandMeta<
  z.output<S>
> {
  readonly kind: 'effect'
  /**
   * Changes nothing: an asynchronous read of app data that cannot be a (synchronous) query, e.g.
   * `project.recovery.list`. Agent tools describe it as read-only
   * (docs/architecture/llm-api.md#annotations-and-server-instructions).
   */
  readonly readOnly?: boolean
  readonly args: S
  readonly result: z.ZodType<R>
  run(doc: ProjectDoc, args: z.output<S>, ctx: CommandContext): AsyncAppResult<R>
}

/** Long-running; dispatch returns `{ jobId }` at once and releases the queue. */
export interface JobCommand<S extends z.ZodType = z.ZodType, R = unknown> extends CommandMeta<
  z.output<S>
> {
  readonly kind: 'job'
  readonly args: S
  readonly result: z.ZodType<R>
  run(doc: ProjectDoc, args: z.output<S>, ctx: JobContext): AsyncAppResult<R>
}

/**
 * Commands executed by the dispatcher itself (`history.undo`, `job.pause`, …): they act on
 * history or job state, not through a handler. Defined in history.ts and jobs.ts.
 */
export interface BuiltinCommand<S extends z.ZodType = z.ZodType, R = unknown> extends CommandMeta<
  z.output<S>
> {
  readonly kind: 'builtin'
  readonly args: S
  readonly result: z.ZodType<R>
}

export type AnyCommand = DocumentCommand | EffectCommand | JobCommand | BuiltinCommand

/**
 * Runs on the same draft after every successful `document` command and before the commit, so
 * its changes join the command's patches (one undo step). For derived follow-ups owned by
 * another module, e.g. the auto-rebuild of `draft` plans after design commands
 * (docs/architecture/commands.md#document-hooks). Same rules as a document handler: synchronous,
 * no dispatch; an `Err` fails the whole command.
 */
export interface DocumentHook {
  readonly name: string
  after(
    draft: Draft<ProjectDoc>,
    command: { readonly name: string; readonly args: unknown },
    ctx: CommandContext,
  ): AppResult<void>
}

/** What an apply hook reports for the `ApplyOutcome` (apply.md § Steps). */
export interface ApplyContribution {
  readonly toolChanges?: readonly ToolChange[]
  readonly plans?: readonly PlanApply[]
}

/**
 * Deferred document work, run once by `project.apply` on its draft with all pending changes,
 * in registry order (docs/architecture/apply.md#apply-hooks). Same rules as a document hook:
 * synchronous, no dispatch, synchronous library reads only; an `Err` or throw fails the Apply and
 * leaves document, history and pending set unchanged. Derived problems (no fitting tool, a plan
 * that cannot follow) are reported in the contribution, never an `Err`.
 */
export interface ApplyHook {
  readonly name: string
  apply(
    draft: Draft<ProjectDoc>,
    pending: readonly PendingChange[],
    ctx: CommandContext,
  ): AppResult<ApplyContribution | void>
}

/** A job an apply job starts: a registered `job` command, its args and its supersede key. */
export interface ApplyJobStart {
  readonly command: string
  readonly args: unknown
  /** A newer Apply aborts the running apply job with the same key (e.g. `toolpaths:<planId>`). */
  readonly key: string
}

/**
 * Deferred cache work after the document phase of an Apply (docs/architecture/apply.md#apply-jobs):
 * returns the jobs to start on the applied document. Not undoable, not in the Apply entry.
 */
export interface ApplyJob {
  readonly name: string
  jobs(
    doc: ProjectDoc,
    pending: readonly PendingChange[],
    ctx: CommandContext,
  ): readonly ApplyJobStart[]
}

/**
 * Pending keys beyond the design diff (docs/architecture/apply.md#what-is-pending): plan inputs
 * of kept-current plans, `draft` plans that do not follow their part yet, changed library items
 * that `draft` plans copy. Derived from the current document, the baseline and services (library,
 * toolpath cache) on every pending read; `design` are the design keys already found. Pure and
 * cheap: unchanged records are skipped by reference.
 */
export interface PendingSource {
  readonly name: string
  changes(
    doc: ProjectDoc,
    baseline: ProjectDoc,
    design: readonly PendingChange[],
    ctx: Pick<QueryContext, 'services'>,
  ): readonly PendingChange[]
}

/**
 * The consistency scan on open (docs/architecture/apply.md#opening-and-recovery): keys of the
 * opened document that an older build or a recovered working folder left unapplied. They stay
 * pending until the next successful Apply.
 */
export type OpenScan = (doc: ProjectDoc, ctx: Pick<QueryContext, 'services'>) => PendingChange[]

/** `warnings` of the `ApplyOutcome`: the DFM warnings of the parts with applied changes. */
export type ApplyWarnings = (
  doc: ProjectDoc,
  partIds: readonly string[],
  ctx: QueryContext,
) => ApplyOutcome['warnings']

export interface QueryDef<S extends z.ZodType = z.ZodType, R = unknown> {
  /** e.g. `design.pocket.get`, `plan.operation.list`. */
  readonly name: string
  readonly summary: string
  readonly args: S
  readonly result: z.ZodType<R>
  /**
   * Whether the result depends on `ProjectDoc` (default true). Only such queries count as a
   * read for the stale-write baseline (docs/architecture/commands.md#stale-writes); e.g.
   * library queries read app data and set `false`.
   */
  readonly readsDocument?: boolean
  /** Side-effect free; reads the latest committed snapshot. */
  run(doc: ProjectDoc, args: z.output<S>, ctx: QueryContext): AppResult<R>
}

/** Identity helpers that infer the arg/result types of a definition. */
export function defineCommand<S extends z.ZodType, R>(
  def: DocumentCommand<S, R>,
): DocumentCommand<S, R>
export function defineCommand<S extends z.ZodType, R>(def: EffectCommand<S, R>): EffectCommand<S, R>
export function defineCommand<S extends z.ZodType, R>(def: JobCommand<S, R>): JobCommand<S, R>
export function defineCommand(def: AnyCommand): AnyCommand {
  return def
}

export function defineQuery<S extends z.ZodType, R>(def: QueryDef<S, R>): QueryDef<S, R> {
  return def
}
