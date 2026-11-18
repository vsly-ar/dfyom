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
}

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
