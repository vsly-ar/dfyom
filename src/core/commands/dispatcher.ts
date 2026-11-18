/**
 * One dispatcher per open project: FIFO queue and the dispatch pipeline.
 * Doc: docs/architecture/commands.md#dispatcher-pipeline
 *
 * Adapters (IPC, MCP, CLI) call `dispatch`/`query` inside `atBoundary`; they contain no domain logic.
 */
import { freeze } from 'immer'
import { summarizeArgs } from '../../shared/boundary'
import type { AppError } from '../../shared/errors/app-error'
import { parseArgs } from './args'
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
  type JobDirectory,
  type Services,
  type Source,
} from './context'
import type { AnyCommand, BuiltinCommand, DocumentCommand } from './define'
import {
  applyDocPatches,
  DEFAULT_HISTORY_LIMITS,
  entrySize,
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
  /** Revision of `doc` (an opened project starts at its manifest's revision; default 0). */
  readonly revision?: number
  readonly services?: Services
  readonly ids?: IdGenerator
  readonly clock?: Clock
  readonly policy?: PermissionPolicy
  /** Action-log limits (defaults in action-log.ts). */
  readonly logCapacity?: number
  readonly logMaxChars?: number
  /** Receives action-log listener throws (they never break a dispatch). */
  readonly onListenerError?: (error: AppError) => void
  readonly historyLimits?: HistoryLimits
  /** Min interval between delivered progress ticks of a job. */
  readonly progressIntervalMs?: number
  /** Finished jobs kept for `job(id)` and `job.*` (oldest evicted first; default 100). */
  readonly maxFinishedJobs?: number
}

/** JSON copy for log events: never freezes or shares caller-owned objects. */
function jsonCopy(value: unknown): unknown {
  if (value === undefined) return undefined
  const r = tryCatch(
    () => JSON.parse(JSON.stringify(value)) as unknown,
    'internal.unexpected',
    'unserializable',
  )
  return r.isOk() ? r.unwrap() : '[unserializable]'
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
  /** Running and retained finished jobs (`checkNoRunJob`, closing a project aborts them). */
  readonly jobs: JobDirectory
  /**
   * Records the current revision as `source`'s read (stale-write baseline) and returns it: an
   * adapter showed the source this revision, e.g. a `project.open`/`project.bind` result
   * (docs/architecture/commands.md#stale-writes).
   */
  markRead(source: Source): number
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
  private readonly runs = new Map<string, JobRun>()
  private readonly finishedJobs: string[] = []
  private readonly maxFinishedJobs: number
  /** Per source: the later of its last read revision and its last own commit. */
  private readonly baseline = new Map<string, number>()
  private tail: Promise<unknown> = Promise.resolve()
  private readonly jobDirectory: JobDirectory = {
    get: (jobId) => this.job(jobId),
    list: () => [...this.runs.values()],
  }

  constructor(o: DispatcherOptions) {
    this.registry = o.registry
    this.current = freeze(o.doc, true)
    this.rev = o.revision ?? 0
    this.services = o.services ?? { workers: inProcessWorkers }
    this.ids = o.ids ?? systemIds
    this.clock = o.clock ?? systemClock
    this.policy = o.policy ?? defaultPermissionPolicy
    this.progressIntervalMs = o.progressIntervalMs ?? 100
    this.maxFinishedJobs = o.maxFinishedJobs ?? 100
    this.actionLog = createActionLog({
      ...(o.logCapacity === undefined ? {} : { capacity: o.logCapacity }),
      ...(o.logMaxChars === undefined ? {} : { maxChars: o.logMaxChars }),
      ...(o.onListenerError === undefined ? {} : { onListenerError: o.onListenerError }),
    })
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

  get jobs(): JobDirectory {
    return this.jobDirectory
  }

  markRead(source: Source): number {
    this.recordBaseline(source, this.rev)
    return this.rev
  }

  job(jobId: string): Option<JobHandle> {
    const j = this.runs.get(jobId)
    return j === undefined ? None : Some(j)
  }

  /** Never throws: any stray throw (schema, handler) becomes `internal.unexpected`. */
  query(name: string, rawArgs: unknown, source: Source): AppResult<QueryOutcome> {
    const ran = tryCatch(
      () => this.runQuery(name, rawArgs, source),
      'internal.unexpected',
      `query ${name} threw`,
    )
    return ran.isOk() ? ran.unwrap() : Err(ran.unwrapErr())
  }

  private runQuery(name: string, rawArgs: unknown, source: Source): AppResult<QueryOutcome> {
    const found = this.registry.query(name)
    if (found.isNone()) return fail('command.unknown', `unknown query ${name}`, { where: 'query' })
    const def = found.unwrap()
    const args = parseArgs(def.args, rawArgs, name)
    if (args.isErr()) return args
    const revision = this.rev
    const value = def.run(this.current, args.unwrap(), {
      source,
      services: this.services,
      jobs: this.jobDirectory,
      history: this.history,
    })
    if (value.isErr()) return Err(value.unwrapErr())
    if (def.readsDocument !== false) this.recordBaseline(source, revision)
    return Ok({ value: value.unwrap(), revision })
  }

  /** Never rejects: any stray throw becomes `internal.unexpected` (and is logged). */
  async dispatch(
    name: string,
    rawArgs: unknown,
    source: Source,
    opts: DispatchOptions = {},
  ): AsyncAppResult<CommandOutcome> {
    const ran = await tryAsync(
      () => this.pipeline(name, rawArgs, source, opts),
      'internal.unexpected',
      `dispatch of ${name} threw`,
    )
    if (ran.isOk()) return ran.unwrap()
    const logged = tryCatch(
      () => this.logged(name, rawArgs, source, Err(ran.unwrapErr())),
      'internal.unexpected',
      'logging failed',
    )
    return logged.isOk() ? logged.unwrap() : Err(ran.unwrapErr())
  }

  private async pipeline(
    name: string,
    rawArgs: unknown,
    source: Source,
    opts: DispatchOptions,
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
    const parsed = parseArgs(def.args, rawArgs, name)
    if (parsed.isErr()) return this.logged(name, rawArgs, source, Err(parsed.unwrapErr()))
    // Frozen once: the same args go to the handler, the history entry and the log.
    const args: unknown = freeze(parsed.unwrap(), true)
    // Urgent commands (emergency paths, job controls; never document writers) skip the queue
    if (def.urgent === true && !writesDocument(def)) return this.execute(def, args, source, opts)
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
        async () => this.policy.check(def, args, source, this.services),
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
    const ran = executeDocumentCommand(this.current, def, args, ctx, this.registry.hooks)
    if (ran.result.isErr())
      return this.logged(def.name, args, ctx.source, Err(ran.result.unwrapErr()))
    const value = ran.result.unwrap()
    if (ran.patches.length === 0)
      return this.logged(def.name, args, ctx.source, Ok({ value, revision: this.rev }))
    // Everything that can fail is computed before the commit: after it, nothing may throw.
    const prepared = tryCatch(
      () => ({
        title: def.title(args),
        size: entrySize({ args, patches: ran.patches, inversePatches: ran.inversePatches }),
      }),
      'internal.unexpected',
      `${def.name}: title or history entry failed`,
    )
    if (prepared.isErr()) return this.logged(def.name, args, ctx.source, Err(prepared.unwrapErr()))
    const { title, size } = prepared.unwrap()
    const source = freeze({ kind: ctx.source.kind, id: ctx.source.id }, true)
    const revisionBefore = this.rev
    this.commit(ran.next, source)
    const outcome = Ok({ value, revision: this.rev })
    const event = this.emit(source, {
      type: 'command',
      name: def.name,
      args: summarizeArgs(args),
      outcome: toWire(Ok(value)),
      patches: ran.patches,
    })
    this.undo.push(
      {
        seq: event.seq,
        command: def.name,
        args,
        source,
        title,
        patches: ran.patches,
        inversePatches: ran.inversePatches,
        revisionBefore,
        revisionAfter: this.rev,
        at: event.at,
      },
      size,
    )
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
    const job = this.runs.get(jobId)
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
      onLifecycle: (state, outcome) => {
        this.emit(ctx.source, {
          type: 'job',
          jobId,
          name: def.name,
          state,
          ...(outcome === undefined ? {} : { outcome: toWire(outcome) }),
        })
        if (state === 'finished') this.retireJob(jobId)
      },
    })
    this.runs.set(jobId, job)
    const out = this.logged(
      def.name,
      args,
      ctx.source,
      Ok({ value: { jobId }, revision: this.rev }),
    )
    job.start() // the queue is released when this returns
    return out
  }

  /** Keeps the newest `maxFinishedJobs` finished jobs; evicted ids answer like unknown ones. */
  private retireJob(jobId: string): void {
    this.finishedJobs.push(jobId)
    while (this.finishedJobs.length > this.maxFinishedJobs) {
      const old = this.finishedJobs.shift()
      if (old !== undefined) this.runs.delete(old)
    }
  }

  /** Args and outcomes are JSON-copied so freezing the event never touches caller-owned objects. */
  private emit(source: Source, body: ActionEventBody) {
    const copied = {
      ...body,
      ...('args' in body ? { args: jsonCopy(body.args) } : {}),
      ...('outcome' in body && body.outcome !== undefined
        ? { outcome: jsonCopy(body.outcome) }
        : {}),
    } as ActionEventBody
    return this.actionLog.append({
      ...copied,
      at: this.nowIso(),
      source: { kind: source.kind, id: source.id },
      revision: this.rev,
    })
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
