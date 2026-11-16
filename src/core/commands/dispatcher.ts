/**
 * One dispatcher per open project: FIFO queue and the dispatch pipeline.
 * Doc: docs/architecture/commands.md#dispatcher-pipeline
 *
 * Adapters (IPC, MCP, CLI) call `dispatch`/`query` inside `atBoundary`; they contain no domain logic.
 */
import { freeze } from 'immer'
import { summarizeArgs } from '../../shared/boundary'
import { parseWith } from '../../shared/parse'
import {
  Err,
  fail,
  None,
  Ok,
  Some,
  toWire,
  tryAsync,
  tryCatch,
  type AppResult,
  type AsyncAppResult,
  type Option,
} from '../../shared/result'
import type { ProjectDoc } from '../project/document'
import {
  createActionLog,
  type ActionLog,
  type ActionEventBody,
  type WritableActionLog,
} from './action-log'
import {
  sourceKey,
  systemClock,
  systemIds,
  type Clock,
  type CommandContext,
  type IdGenerator,
  type Services,
  type Source,
} from './context'
import type { AnyCommand, BuiltinCommand, DocumentCommand } from './define'
import {
  applyDocPatches,
  DEFAULT_HISTORY_LIMITS,
  executeDocumentCommand,
  History,
  type HistoryEntry,
  type HistoryLimits,
} from './history'
import { inProcessWorkers, JobRun, type JobHandle, type JobState } from './jobs'
import { defaultPermissionPolicy, type PermissionPolicy } from './permission'
import type { Registry } from './registry'

export interface DispatchOptions {
  /** If given, must equal the current revision (else `command.conflict`). */
  readonly expectedRevision?: number
}

/** Ok result of a dispatch. A job's `value` is `{ jobId }`. */
export interface CommandOutcome {
  readonly value: unknown
  /** Revision after the command. */
  readonly revision: number
}

/** Ok result of a query: the value and the revision it read. */
export interface QueryOutcome {
  readonly value: unknown
  readonly revision: number
}

export interface DispatcherOptions {
  readonly registry: Registry
  /** Initial document (opening or resetting a project starts an empty history). */
  readonly doc: ProjectDoc
  readonly services?: Services
  readonly ids?: IdGenerator
  readonly clock?: Clock
  readonly policy?: PermissionPolicy
  readonly logCapacity?: number
  readonly historyLimits?: HistoryLimits
  /** Min interval between delivered progress ticks of a job. */
  readonly progressIntervalMs?: number
}

export interface Dispatcher {
  dispatch(
    name: string,
    rawArgs: unknown,
    source: Source,
    opts?: DispatchOptions,
  ): AsyncAppResult<CommandOutcome>
  /** Side-effect free; reads the latest committed snapshot without queueing; not logged. */
  query(name: string, rawArgs: unknown, source: Source): AppResult<QueryOutcome>
  readonly doc: ProjectDoc
  readonly revision: number
  readonly log: ActionLog
  readonly history: {
    readonly undoable: readonly HistoryEntry[]
    readonly redoable: readonly HistoryEntry[]
  }
  job(jobId: string): Option<JobHandle>
}

/** Commands that can change `ProjectDoc` are subject to the stale-write rule. */
function writesDocument(def: AnyCommand): boolean {
  return def.kind === 'document' || def.name === 'history.undo' || def.name === 'history.redo'
}

export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  return new ProjectDispatcher(opts)
}

class ProjectDispatcher implements Dispatcher {
  private current: ProjectDoc
  private rev = 0
  private readonly registry: Registry
  private readonly services: Services
  private readonly ids: IdGenerator
  private readonly clock: Clock
  private readonly policy: PermissionPolicy
  private readonly progressIntervalMs: number
  private readonly actionLog: WritableActionLog
  private readonly undo: History
  private readonly jobs = new Map<string, JobRun>()
  /** Per source: the later of its last read revision and its last own commit. */
  private readonly baseline = new Map<string, number>()
  private tail: Promise<unknown> = Promise.resolve()

  constructor(o: DispatcherOptions) {
    this.registry = o.registry
    this.current = freeze(o.doc, true)
    this.services = o.services ?? { workers: inProcessWorkers }
    this.ids = o.ids ?? systemIds
    this.clock = o.clock ?? systemClock
    this.policy = o.policy ?? defaultPermissionPolicy
    this.progressIntervalMs = o.progressIntervalMs ?? 100
    this.actionLog = createActionLog(o.logCapacity === undefined ? {} : { capacity: o.logCapacity })
    this.undo = new History(o.historyLimits ?? DEFAULT_HISTORY_LIMITS)
  }

  get doc(): ProjectDoc {
    return this.current
  }

  get revision(): number {
    return this.rev
  }

  get log(): ActionLog {
    return this.actionLog
  }

  get history() {
    return { undoable: this.undo.undoable, redoable: this.undo.redoable }
  }

  job(jobId: string): Option<JobHandle> {
    const j = this.jobs.get(jobId)
    return j === undefined ? None : Some(j)
  }

  query(name: string, rawArgs: unknown, source: Source): AppResult<QueryOutcome> {
    const found = this.registry.query(name)
    if (found.isNone()) return fail('command.unknown', `unknown query ${name}`, { where: 'query' })
    const def = found.unwrap()
    const args = parseWith(def.args, rawArgs, name)
    if (args.isErr()) return args
    const revision = this.rev
    const ran = tryCatch(
      () => def.run(this.current, args.unwrap(), { source }),
      'internal.unexpected',
      `${name} threw`,
    )
    const value = ran.isOk() ? ran.unwrap() : Err(ran.unwrapErr())
    if (value.isErr()) return Err(value.unwrapErr())
    this.recordBaseline(source, revision)
    return Ok({ value: value.unwrap(), revision })
  }

  async dispatch(
    name: string,
    rawArgs: unknown,
    source: Source,
    opts: DispatchOptions = {},
  ): AsyncAppResult<CommandOutcome> {
    // 1. Look up
    const found = this.registry.command(name)
    if (found.isNone())
      return this.logged(
        name,
        rawArgs,
        source,
        fail('command.unknown', `unknown command ${name}`, { where: 'dispatch' }),
      )
    const def = found.unwrap()
    // 2. Parse args
    const parsed = parseWith(def.args, rawArgs, name)
    if (parsed.isErr()) return this.logged(name, rawArgs, source, Err(parsed.unwrapErr()))
    const args: unknown = parsed.unwrap()
    // 3. Enqueue (FIFO; a failing step never breaks the chain)
    const run = this.tail.then(() => this.execute(def, args, source, opts))
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async execute(
    def: AnyCommand,
    args: unknown,
    source: Source,
    opts: DispatchOptions,
  ): AsyncAppResult<CommandOutcome> {
    // 4. Revision check
    const stale = this.checkRevision(def, source, opts)
    if (stale.isErr()) return this.logged(def.name, args, source, stale)
    // 5. Permission
    if (def.machine) {
      const allowed = await tryAsync(
        async () => this.policy.check(def, args, source),
        'internal.unexpected',
        'permission policy threw',
      )
      const verdict = allowed.isOk() ? allowed.unwrap() : Err(allowed.unwrapErr())
      if (verdict.isErr()) return this.logged(def.name, args, source, Err(verdict.unwrapErr()))
    }
    // 6. + 7. Execute by kind; each branch logs exactly one dispatch event
    const ctx: CommandContext = {
      source,
      ids: this.ids,
      clock: this.clock,
      services: this.services,
    }
    switch (def.kind) {
      case 'document':
        return this.runDocument(def, args, ctx)
      case 'effect': {
        const ran = await tryAsync(
          () => def.run(this.current, args, ctx),
          'internal.unexpected',
          `${def.name} threw`,
        )
        const r = ran.isOk() ? ran.unwrap() : Err(ran.unwrapErr())
        return this.logged(
          def.name,
          args,
          source,
          r.map((value) => ({ value, revision: this.rev })),
        )
      }
      case 'job':
        return this.startJob(def, args, ctx)
      case 'builtin':
        return this.runBuiltin(def, args, source)
    }
  }

  private checkRevision(def: AnyCommand, source: Source, opts: DispatchOptions): AppResult<void> {
    const conflict = (message: string, data: Record<string, unknown>) =>
      fail('command.conflict', message, { where: 'dispatch.revisionCheck', data })
    if (opts.expectedRevision !== undefined) {
      if (opts.expectedRevision === this.rev) return Ok(undefined)
      return conflict(
        `expected revision ${opts.expectedRevision} but the project is at ${this.rev}; re-query and retry`,
        { expectedRevision: opts.expectedRevision, revision: this.rev },
      )
    }
    if (source.kind === 'ui' || !writesDocument(def)) return Ok(undefined)
    const seen = this.baseline.get(sourceKey(source))
    // Own commits advance the baseline, so "every revision since was made by this source"
    // reduces to: the baseline is the current revision.
    if (seen === this.rev) return Ok(undefined)
    return conflict(
      seen === undefined
        ? `${def.name}: no baseline for this source yet; re-query and retry`
        : `the project changed since your last read (revision ${seen}, now ${this.rev}); re-query and retry`,
      { lastSeenRevision: seen ?? null, revision: this.rev },
    )
  }

  private recordBaseline(source: Source, revision: number): void {
    const key = sourceKey(source)
    this.baseline.set(key, Math.max(this.baseline.get(key) ?? 0, revision))
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString()
  }

  private runDocument(def: DocumentCommand, args: unknown, ctx: CommandContext) {
    const ran = executeDocumentCommand(this.current, def, args, ctx)
    if (ran.result.isErr())
      return this.logged(def.name, args, ctx.source, Err(ran.result.unwrapErr()))
    const value = ran.result.unwrap()
    if (ran.patches.length === 0)
      return this.logged(def.name, args, ctx.source, Ok({ value, revision: this.rev }))
    const revisionBefore = this.rev
    this.commit(ran.next, ctx.source)
    const outcome = Ok({ value, revision: this.rev })
    const event = this.emit(ctx.source, {
      type: 'command',
      name: def.name,
      args: summarizeArgs(args),
      outcome: toWire(Ok(value)),
      patches: ran.patches,
    })
    this.undo.push({
      seq: event.seq,
      command: def.name,
      args,
      source: ctx.source,
      title: def.title(args),
      patches: ran.patches,
      inversePatches: ran.inversePatches,
      revisionBefore,
      revisionAfter: this.rev,
      at: event.at,
    })
    return outcome
  }

  private commit(next: ProjectDoc, source: Source): void {
    this.current = next
    this.rev += 1
    this.recordBaseline(source, this.rev)
  }

  private runBuiltin(
    def: BuiltinCommand,
    args: unknown,
    source: Source,
  ): AppResult<CommandOutcome> {
    if (def.name === 'history.undo' || def.name === 'history.redo') {
      const isUndo = def.name === 'history.undo'
      const entry = isUndo ? this.undo.peekUndo() : this.undo.peekRedo()
      if (entry === undefined)
        return this.logged(
          def.name,
          args,
          source,
          Ok({ value: { entrySeq: null }, revision: this.rev }),
        )
      const patches = isUndo ? entry.inversePatches : entry.patches
      const applied = applyDocPatches(this.current, patches)
      if (applied.isErr()) return this.logged(def.name, args, source, Err(applied.unwrapErr()))
      this.commit(applied.unwrap(), source)
      if (isUndo) this.undo.markUndone()
      else this.undo.markRedone()
      this.emit(source, { type: isUndo ? 'undo' : 'redo', entrySeq: entry.seq, patches })
      return Ok({ value: { entrySeq: entry.seq }, revision: this.rev })
    }
    // job.pause / job.resume / job.abort
    const { jobId } = args as { jobId: string }
    const job = this.jobs.get(jobId)
    if (job === undefined)
      return this.logged(
        def.name,
        args,
        source,
        fail('input.malformed', `no job ${jobId}`, {
          issues: [{ path: ['jobId'], rule: 'unknownJob', message: 'no such job' }],
          where: def.name,
        }),
      )
    // The dispatch event comes first; lifecycle events follow.
    const before: JobState = job.state
    const next: JobState =
      def.name === 'job.pause' && before === 'running'
        ? 'paused'
        : def.name === 'job.resume' && before === 'paused'
          ? 'running'
          : before
    const out = this.logged(
      def.name,
      args,
      source,
      Ok({ value: { state: next }, revision: this.rev }),
    )
    if (def.name === 'job.pause') job.pause()
    else if (def.name === 'job.resume') job.resume()
    else job.abort()
    return out
  }

  private startJob(
    def: Extract<AnyCommand, { kind: 'job' }>,
    args: unknown,
    ctx: CommandContext,
  ): AppResult<CommandOutcome> {
    const jobId = this.ids.next('job')
    const job = new JobRun(def, this.current, args, ctx, {
      id: jobId,
      startRevision: this.rev,
      progressIntervalMs: this.progressIntervalMs,
      onLifecycle: (state, outcome) =>
        this.emit(ctx.source, {
          type: 'job',
          jobId,
          name: def.name,
          state,
          ...(outcome === undefined ? {} : { outcome: toWire(outcome) }),
        }),
    })
    this.jobs.set(jobId, job)
    const out = this.logged(
      def.name,
      args,
      ctx.source,
      Ok({ value: { jobId }, revision: this.rev }),
    )
    job.start() // the queue is released when this returns
    return out
  }

  private emit(source: Source, body: ActionEventBody) {
    return this.actionLog.append({ ...body, at: this.nowIso(), source, revision: this.rev })
  }

  /** Step 7 for dispatches without patches: log one command event, return the result. */
  private logged(
    name: string,
    args: unknown,
    source: Source,
    result: AppResult<CommandOutcome>,
  ): AppResult<CommandOutcome> {
    this.emit(source, {
      type: 'command',
      name,
      args: summarizeArgs(args),
      outcome: toWire(result.map((o) => o.value)),
    })
    return result
  }
}
