/**
 * One dispatcher per open project: FIFO queue and the dispatch pipeline.
 * Doc: docs/architecture/commands.md#dispatcher-pipeline
 *
 * Adapters (IPC, MCP, CLI) call `dispatch`/`query` inside `atBoundary`; they contain no domain logic.
 */
import { freeze } from 'immer'
import { summarizeArgs } from '../../shared/boundary'
import type { AppError, AppErrorData } from '../../shared/errors/app-error'
import { parseArgs } from './args'
import {
  Err,
  fail,
  None,
  Ok,
  Some,
  toDataWire,
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
import {
  applyTitle,
  EMPTY_APPLY,
  pendingChanges,
  pendingKey,
  type ApplyOutcome,
  type ApplyView,
  type LastApply,
  type PendingChange,
  type PendingChangeInfo,
} from './apply'
import type {
  AnyCommand,
  ApplyJobStart,
  BuiltinCommand,
  DocumentCommand,
  JobCommand,
} from './define'
import {
  applyDocPatches,
  DEFAULT_HISTORY_LIMITS,
  entrySize,
  executeApplyHooks,
  executeDocumentCommand,
  type Patch,
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
  /**
   * A step of a live-edit gesture (UI only): merged into the top undo entry when it is the same
   * gesture, source and command with nothing committed since (commands.md#gestures-live-edits).
   */
  readonly gesture?: string
  /**
   * Auto-apply (agents, CLI, automation; set by the session core): a successful `document`
   * command is followed by `project.apply` in the same queue turn, and the outcome gains
   * `applied` (docs/architecture/apply.md#agents-mcp-and-cli).
   */
  readonly apply?: boolean
}

/** `applied` of an auto-applied call: the Apply's outcome, or why it failed (the edit stays). */
export type AppliedResult = ApplyOutcome | { readonly error: AppErrorData }

/** Ok result of a dispatch. A job's `value` is `{ jobId }`. */
export interface CommandOutcome {
  readonly value: unknown
  /** Revision after the command (after its Apply, when auto-applied). */
  readonly revision: number
  /** Present when the command was auto-applied (`DispatchOptions.apply`). */
  readonly applied?: AppliedResult
}

/** How an Apply was asked for; only the logged args differ. */
type ApplyMode =
  | { readonly kind: 'explicit'; readonly args: unknown }
  | { readonly kind: 'auto' }
  | { readonly kind: 'before'; readonly command: string }

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
  /** Pending changes and apply state (docs/architecture/apply.md#queries-for-pending-state). */
  readonly applyState: ApplyView
  /**
   * Records `revision` as `source`'s read (stale-write baseline): an adapter showed the source
   * the document at that revision, e.g. the result of a `project.open` that started this
   * project's runtime (docs/architecture/commands.md#stale-writes).
   */
  markRead(source: Source, revision: number): void
  /**
   * Closing: refuses every new non-urgent dispatch (`input.malformed`, rule `projectClosing`) and
   * resolves once the queue has drained; `resume()` accepts dispatches again (the close was
   * refused). Urgent commands (job controls) still run, so a close can abort jobs.
   */
  suspend(): Promise<void>
  resume(): void
}

/** Commands that can change `ProjectDoc` are subject to the stale-write rule. */
function writesDocument(def: AnyCommand): boolean {
  // `project.apply` writes only derived state from the current document: exempt from the
  // baseline rule (apply.md § Concurrency and stale writes); `expectedRevision` still holds.
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
  private suspended = false
  private readonly jobDirectory: JobDirectory = {
    get: (jobId) => this.job(jobId),
    list: () => [...this.runs.values()],
  }
  /** The document at open: the baseline while no Apply marker exists (apply.md § Baseline). */
  private readonly opened: ProjectDoc
  /** Last commit per touched record (`parts/<id>`, `snapshots/<id>`, …), for pending provenance. */
  private readonly touched = new Map<string, { source: Source; revision: number }>()
  private lastCommit: { source: Source; revision: number } | undefined
  private pendingCache: { doc: ProjectDoc; base: ProjectDoc; changes: PendingChange[] } | undefined
  /**
   * Keys of the consistency scan on open (apply.md § Opening and recovery): pending until the
   * next successful Apply consumes them.
   */
  private openMarks: readonly PendingChange[] = []
  private lastApplyInfo: LastApply | null = null
  /** Running apply jobs by supersede key; the job ids of the last Apply (retry of failures). */
  private readonly applyRuns = new Map<string, string>()
  private lastApplyJobIds: readonly string[] = []
  private readonly applyView: ApplyView

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
    this.opened = this.current
    const scan = this.registry.openScan
    if (scan !== undefined) {
      const marks = tryCatch(
        () => scan(this.current, { services: this.services }),
        'internal.unexpected',
        'consistency scan threw',
      )
      // the scan only adds pending keys: a failure leaves none (the commands report broken parts)
      if (marks.isOk()) this.openMarks = marks.unwrap()
    }
    const pending = () => this.pendingInfo()
    const applying = () => this.runningApplyJobs()
    const lastApply = () => this.lastApplyInfo
    this.applyView = {
      pending,
      get applying() {
        return applying()
      },
      get lastApply() {
        return lastApply()
      },
    }
  }

  get applyState(): ApplyView {
    return this.applyView
  }

  /** Baseline: the newest marker at or below the top of the undo stack, else the opened document. */
  private baselineDoc(): ProjectDoc {
    return this.undo.baseline() ?? this.opened
  }

  /**
   * All pending keys: the design diff against the baseline (cached per document pair), the
   * registry's pending sources (plan inputs, draft plans, library items: they also read the
   * library and the toolpath cache, so they are derived on every read) and the open scan's
   * marks; one per key.
   */
  private pendingNow(): PendingChange[] {
    const doc = this.current
    const base = this.baselineDoc()
    const c = this.pendingCache
    let design: PendingChange[]
    if (c !== undefined && c.doc === doc && c.base === base) design = c.changes
    else {
      design = pendingChanges(doc, base)
      this.pendingCache = { doc, base, changes: design }
    }
    const extra = [
      ...this.registry.pendingSources.flatMap((p) =>
        p.changes(doc, base, design, { services: this.services }),
      ),
      ...this.openMarks,
    ]
    if (extra.length === 0) return design
    const seen = new Set(design.map(pendingKey))
    const out = [...design]
    for (const e of extra) {
      const k = pendingKey(e)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(e)
    }
    return out
  }

  /** Pending changes with the last commit that touched their part (or its stock snapshot). */
  private pendingInfo(): PendingChangeInfo[] {
    const fallback = this.lastCommit ?? {
      source: { kind: 'system', id: 'open' } as Source,
      revision: this.rev,
    }
    return this.pendingNow().map((c) => {
      const part = c.partId === undefined ? undefined : this.current.parts[c.partId]
      const keys = [
        ...(c.partId === undefined ? [] : [`parts/${c.partId}`, 'parts/*']),
        ...(part === undefined ? [] : [`snapshots/${part.stock}`, 'snapshots/*']),
        ...(c.planId === undefined ? [] : [`plans/${c.planId}`, 'plans/*']),
      ]
      let by: { source: Source; revision: number } | undefined
      for (const k of keys) {
        const t = this.touched.get(k)
        if (t !== undefined && (by === undefined || t.revision > by.revision)) by = t
      }
      const found = by ?? fallback
      return { ...c, source: found.source, revision: found.revision }
    })
  }

  private runningApplyJobs(): string[] {
    return [...this.applyRuns.values()].filter((id) => {
      const j = this.runs.get(id)
      return j !== undefined && j.state !== 'finished'
    })
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

  markRead(source: Source, revision: number): void {
    this.recordBaseline(source, revision)
  }

  async suspend(): Promise<void> {
    this.suspended = true
    await this.tail
  }

  resume(): void {
    this.suspended = false
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
      apply: this.applyView,
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
    if (this.suspended)
      return this.logged(
        name,
        args,
        source,
        fail('input.malformed', 'the project is closing', {
          where: 'dispatch',
          issues: [{ path: [], rule: 'projectClosing', message: 'the project is being closed' }],
        }),
      )
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
    // 5. Permission; resuming a machine job (a held run) is motion too: its command decides
    // (docs/modes/run.md#2-who-may-command-a-real-connection-q50)
    const checked = def.machine ? def : this.resumedMachineCommand(def, args)
    if (checked !== undefined) {
      const allowed = await tryAsync(
        async () => this.policy.check(checked, def === checked ? args : {}, source, this.services),
        'internal.unexpected',
        'permission policy threw',
      )
      const verdict = allowed.isOk() ? allowed.unwrap() : Err(allowed.unwrapErr())
      if (verdict.isErr()) return this.logged(def.name, args, source, Err(verdict.unwrapErr()))
    }
    // Implicit apply (apply.md § Implicit apply): its own event and entry, in this queue turn
    if (this.appliesFirst(def, args)) {
      const applied = this.runApply(source, { kind: 'before', command: def.name })
      if (applied.isErr())
        return this.logged(
          def.name,
          args,
          source,
          Err(applied.unwrapErr().withContext(`apply before ${def.name}`)),
        )
    }
    // 6. + 7. Execute by kind; each branch logs exactly one dispatch event
    const ctx = this.context(source)
    switch (def.kind) {
      case 'document': {
        let prepared: unknown
        if (def.prepare !== undefined) {
          const prepare = def.prepare.bind(def)
          const ran = await tryAsync(
            () => prepare(this.current, args, ctx),
            'internal.unexpected',
            `${def.name}: prepare threw`,
          )
          const r = ran.isOk() ? ran.unwrap() : Err(ran.unwrapErr())
          if (r.isErr()) return this.logged(def.name, args, source, Err(r.unwrapErr()))
          prepared = r.unwrap()
        }
        const done = this.runDocument(def, args, ctx, opts.gesture, prepared)
        if (opts.apply !== true || done.isErr()) return done
        return Ok(this.autoApply(done.unwrap(), source))
      }
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
        if (def.name === 'project.apply') return this.runApply(source, { kind: 'explicit', args })
        return this.runBuiltin(def, args, source)
    }
  }

  private context(source: Source): CommandContext {
    return { source, ids: this.ids, clock: this.clock, services: this.services }
  }

  private appliesFirst(def: AnyCommand, args: unknown): boolean {
    const f = def.applyFirst as boolean | ((a: unknown) => boolean) | undefined
    return typeof f === 'function' ? f(args) : f === true
  }

  /** The edit stays committed whatever the Apply does; its error goes into `applied`. */
  private autoApply(done: CommandOutcome, source: Source): CommandOutcome {
    const applied = this.runApply(source, { kind: 'auto' })
    if (applied.isErr()) {
      return { ...done, revision: this.rev, applied: { error: applied.unwrapErr().toWireData() } }
    }
    return { ...done, revision: this.rev, applied: applied.unwrap().value as ApplyOutcome }
  }

  /** Whether a job of the last Apply failed (then an Apply with nothing pending retries). */
  private failedApplyJobs(): boolean {
    return this.lastApplyJobIds.some((id) => {
      const o = this.runs.get(id)?.outcome
      return o !== undefined && o.isErr() && o.unwrapErr().code !== 'op.aborted'
    })
  }

  /**
   * `project.apply` (apply.md § Steps): document phase (apply hooks → one "Apply N changes"
   * entry, or none), the apply marker, then the job phase. Everything that can fail runs before
   * the commit; a failure leaves document, history and pending set unchanged.
   */
  private runApply(source: Source, mode: ApplyMode): AppResult<CommandOutcome> {
    const name = 'project.apply'
    const logArgs =
      mode.kind === 'explicit'
        ? mode.args
        : mode.kind === 'auto'
          ? { auto: true }
          : { before: mode.command }
    const pending = this.pendingNow()
    if (pending.length === 0 && !this.failedApplyJobs())
      return this.logged(name, logArgs, source, Ok({ value: EMPTY_APPLY, revision: this.rev }))
    const ctx = this.context(source)
    const ran = executeApplyHooks(this.current, this.registry.applyHooks, pending, ctx)
    if (ran.result.isErr()) return this.logged(name, logArgs, source, Err(ran.result.unwrapErr()))
    const contributions = ran.result.unwrap()
    const changed = ran.patches.length > 0
    const partIds = [...new Set(pending.flatMap((c) => (c.partId === undefined ? [] : [c.partId])))]
    const prepared = tryCatch(
      () => ({
        title: applyTitle(pending.length),
        size: changed
          ? entrySize({ args: logArgs, patches: ran.patches, inversePatches: ran.inversePatches })
          : 0,
        jobs: this.registry.applyJobs.flatMap((j) => j.jobs(ran.next, pending, ctx)),
        warnings:
          this.registry.applyWarnings?.(ran.next, partIds, {
            source,
            services: this.services,
            jobs: this.jobDirectory,
            history: this.history,
          }) ?? [],
      }),
      'internal.unexpected',
      'project.apply: preparing the entry, jobs or warnings failed',
    )
    if (prepared.isErr()) return this.logged(name, logArgs, source, Err(prepared.unwrapErr()))
    const { title, size, jobs, warnings } = prepared.unwrap()
    const starts: { start: ApplyJobStart; def: JobCommand }[] = []
    for (const start of jobs) {
      const found = this.registry.command(start.command)
      const def = found.isSome() ? found.unwrap() : undefined
      if (def?.kind !== 'job')
        return this.logged(
          name,
          logArgs,
          source,
          fail('internal.unexpected', `apply job ${start.command} is not a registered job`, {
            where: name,
          }),
        )
      starts.push({ start, def })
    }
    // Commit: nothing below may fail.
    const frozenSource = freeze({ kind: source.kind, id: source.id }, true)
    const revisionBefore = this.rev
    if (changed) this.commit(ran.next, frozenSource, ran.patches, { derived: true })
    const runs = starts.map(({ start, def }) => {
      const superseded = this.applyRuns.get(start.key)
      if (superseded !== undefined) this.runs.get(superseded)?.abort()
      const job = this.createJob(def, start.args, ctx)
      this.applyRuns.set(start.key, job.id)
      return job
    })
    const outcome: ApplyOutcome = {
      changes: pending.length,
      entrySeq: changed ? this.actionLog.lastSeq + 1 : null,
      toolChanges: contributions.flatMap((c) => [...(c.toolChanges ?? [])]),
      plans: contributions.flatMap((c) => [...(c.plans ?? [])]),
      jobIds: runs.map((j) => j.id),
      warnings,
    }
    const event = this.emit(frozenSource, {
      type: 'command',
      name,
      args: summarizeArgs(logArgs),
      outcome: toWire(Ok(outcome)),
      ...(changed ? { patches: ran.patches } : {}),
    })
    if (changed)
      this.undo.push(
        {
          seq: event.seq,
          command: name,
          args: logArgs,
          source: frozenSource,
          title,
          patches: ran.patches,
          inversePatches: ran.inversePatches,
          revisionBefore,
          revisionAfter: this.rev,
          at: event.at,
        },
        size,
      )
    this.undo.markApplied(this.current)
    this.openMarks = []
    this.lastApplyInfo = {
      entrySeq: changed ? event.seq : null,
      revision: this.rev,
      at: event.at,
      source: { kind: source.kind, id: source.id },
    }
    this.lastApplyJobIds = outcome.jobIds
    for (const job of runs) job.start()
    return Ok({ value: outcome, revision: this.rev })
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

  private runDocument(
    def: DocumentCommand,
    args: unknown,
    ctx: CommandContext,
    gesture: string | undefined,
    input?: unknown,
  ): AppResult<CommandOutcome> {
    const ran = executeDocumentCommand(this.current, def, args, ctx, this.registry.hooks, input)
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
    const merges = gesture !== undefined && this.continuesGesture(gesture, source, def.name)
    this.commit(ran.next, source, ran.patches)
    const outcome = Ok({ value, revision: this.rev })
    const event = this.emit(source, {
      type: 'command',
      name: def.name,
      args: summarizeArgs(args),
      outcome: toWire(Ok(value)),
      patches: ran.patches,
      ...(gesture === undefined ? {} : { gesture }),
    })
    const entry: HistoryEntry = {
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
      ...(gesture === undefined ? {} : { gesture }),
    }
    if (merges) this.undo.mergeTop(entry, size)
    else this.undo.push(entry, size)
    return outcome
  }

  /**
   * The top undo entry is this gesture's, by this source and command, with nothing committed
   * since and no Apply in between (an Apply without changes marks the top entry).
   */
  private continuesGesture(gesture: string, source: Source, command: string): boolean {
    const top = this.undo.peekUndo()
    return (
      top !== undefined &&
      !this.undo.topApplied() &&
      top.gesture === gesture &&
      top.command === command &&
      sourceKey(top.source) === sourceKey(source) &&
      top.revisionAfter === this.rev
    )
  }

  /**
   * `derived` (an Apply): the source's stale-write baseline advances only if it was current, so
   * applying someone else's pending edits never counts as reading them.
   */
  private commit(
    next: ProjectDoc,
    source: Source,
    patches: readonly Patch[],
    opts: { derived?: boolean } = {},
  ): void {
    const wasCurrent = this.baseline.get(sourceKey(source)) === this.rev
    this.current = next
    this.rev += 1
    if (opts.derived !== true || wasCurrent) this.recordBaseline(source, this.rev)
    const by = { source, revision: this.rev }
    this.lastCommit = by
    for (const p of patches) {
      const [root, id] = p.path
      this.touched.set(`${String(root)}/${id === undefined ? '*' : String(id)}`, by)
    }
  }

  /** `job.resume` of a job whose command is a machine command: that command, else undefined. */
  private resumedMachineCommand(def: AnyCommand, args: unknown): AnyCommand | undefined {
    if (def.name !== 'job.resume') return undefined
    const job = this.runs.get((args as { jobId?: string } | null)?.jobId ?? '')
    if (job === undefined) return undefined
    const jobDef = this.registry.command(job.name)
    return jobDef.isSome() && jobDef.unwrap().machine ? jobDef.unwrap() : undefined
  }

  private runBuiltin(
    def: BuiltinCommand,
    args: unknown,
    source: Source,
  ): AppResult<CommandOutcome> {
    if (def.name === 'history.undo' || def.name === 'history.redo') {
      const isUndo = def.name === 'history.undo'
      const gesture = isUndo ? (args as { gesture?: string }).gesture : undefined
      const top = isUndo ? this.undo.peekUndo() : this.undo.peekRedo()
      // a gesture cancel only reverts the caller's own top entry of that gesture
      // ...and not once an Apply marked it (apply.md § Adjust popover)
      const entry =
        gesture === undefined ||
        (top?.gesture === gesture &&
          sourceKey(top.source) === sourceKey(source) &&
          !this.undo.topApplied())
          ? top
          : undefined
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
      this.commit(applied.unwrap(), source, patches)
      if (gesture !== undefined) this.undo.discardTop()
      else if (isUndo) this.undo.markUndone()
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
          issues: [
            { path: ['jobId'], rule: 'unknownJob', message: 'no such job; job_list lists them' },
          ],
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
    const job = this.createJob(def, args, ctx)
    const out = this.logged(
      def.name,
      args,
      ctx.source,
      Ok({ value: { jobId: job.id }, revision: this.rev }),
    )
    job.start() // the queue is released when this returns
    return out
  }

  /** A registered job run, not started yet (its lifecycle events are logged). */
  private createJob(def: JobCommand, args: unknown, ctx: CommandContext): JobRun {
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
          ...(outcome === undefined ? {} : { outcome: toDataWire(outcome) }),
        })
        if (state === 'finished') this.retireJob(jobId)
      },
    })
    this.runs.set(jobId, job)
    return job
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
      outcome: toDataWire(result.map((o) => o.value)),
    })
    return result
  }
}
