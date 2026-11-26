/**
 * Automatic evaluation after edits: per-subject trailing debounce, abort on a newer revision, a
 * result store keyed by input hash with a small LRU, and the `design.part.evaluate` job. Subjects
 * are the design's parts and the plans' parts (their design snapshots with plan-only edits, for
 * the plan scene); an input hash evaluated for one subject serves every other subject with that
 * hash. Not a job itself (one job per edit would flood the action log); debug log only.
 * Doc: docs/architecture/workers.md#automatic-evaluation-after-design-edits,
 * docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene
 *
 * Headless: timers come through the injected `Timers` port, results through the `WorkerPort`.
 */
import type { Patch } from 'immer'
import { z } from 'zod'
import type { AppError, AppErrorData } from '../../shared/errors/app-error'
import { AppErrorDataSchema } from '../../shared/errors/schema'
import { noopLogger, type Logger } from '../../shared/logging'
import { Err, fail, Ok, type AppResult, type AsyncAppResult } from '../../shared/result'
import type { ActionLog } from '../commands/action-log'
import { systemClock, systemTimers, type Clock, type Timers } from '../commands/context'
import { defineCommand } from '../commands/define'
import type { WorkerPort } from '../commands/jobs'
import type { Region2dPort } from '../geometry/2d/port'
import type { PartEvaluation } from '../geometry/evaluate'
import type { DfmWarning, PartGeometryInput } from '../geometry/model'
import { planGeometryInput, unknownPlan } from '../plan/plan'
import { hashJson } from '../plan/snapshot'
import type { ProjectDoc } from '../project/document'
import { geometryEvaluate } from '../workers/tasks'
import { loadEnabledPart, partGeometryInput, unknownPart } from './load'
import { PartIdSchema } from './part.dto'
import { DfmWarningSchema, libraryTools, namedMessages, partWarnings } from './warnings'

export const EVALUATION_STATUSES = ['done', 'pending', 'failed'] as const
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number]

/** An evaluation for one document: `done` / `failed` for its current input hash, else `pending`. */
export interface PartEvaluationState {
  readonly status: EvaluationStatus
  /** Hash of the geometry input in that document (absent when the input fails). */
  readonly inputHash?: string
  readonly evaluation?: PartEvaluation
  readonly error?: AppError
}

/** What queries and the `design.part.evaluate` job use (`Services.evaluations`). */
export interface EvaluationService {
  /** The part's state in `doc`: current means the stored result's hash equals the doc's. */
  state(doc: ProjectDoc, partId: string): PartEvaluationState
  /**
   * Skip the debounce for the part's current input, join a running evaluation of that input,
   * resolve when it is done or failed; a newer revision of the part (or `signal`) → `op.aborted`.
   */
  evaluate(partId: string, signal: AbortSignal): AsyncAppResult<PartEvaluationState>
}

/** The dispatcher, as the scheduler sees it. */
export interface EvaluationSource {
  readonly doc: ProjectDoc
  readonly revision: number
  readonly log: ActionLog
}

export interface EvaluationScheduler extends EvaluationService {
  /** Start following a project: every part and plan is dirty (evaluated at once, parts first). */
  attach(source: EvaluationSource): void
  /** Project closed: abort everything, drop all results. */
  close(): void
  /**
   * Called with a part id whenever its state may have changed (edit, debounce over, result,
   * removal); read it with `state`. For pushing evaluations to windows (renderer mesh push,
   * docs/architecture/workers.md#evaluation-status). Returns the unsubscribe.
   */
  onChange(listener: (partId: string) => void): () => void
  /**
   * The plan's part (snapshot scene, docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene):
   * as `state`, for `design.part` of the plan on its stock copy.
   */
  planState(doc: ProjectDoc, planId: string): PartEvaluationState
  /** As `evaluate`, for the plan's part; a newer revision of the plan's part → `op.aborted`. */
  evaluatePlan(planId: string, signal: AbortSignal): AsyncAppResult<PartEvaluationState>
  /** As `onChange`, with a plan id whenever the state of the plan's part may have changed. */
  onPlanChange(listener: (planId: string) => void): () => void
}

export interface SchedulerOptions {
  readonly workers: WorkerPort
  readonly timers?: Timers
  readonly clock?: Clock
  readonly log?: Logger
  /** Trailing debounce per subject, no max wait (default 200 ms). */
  readonly debounceMs?: number
  /** Results kept per subject, by input hash (default 8). */
  readonly lruSize?: number
  /** The 2D port that places named and rotated shapes (absent: their parts fail to map). */
  readonly region2d?: Region2dPort
}

export const EVALUATION_DEBOUNCE_MS = 200
export const EVALUATION_LRU_SIZE = 8

/** What is evaluated: a design part, or a plan's part (its snapshot with plan-only edits). */
type SubjectKind = 'part' | 'plan'

/** Map key of a subject (ids are file-name safe, never contain `:`). */
const keyOf = (kind: SubjectKind, id: string): string => `${kind}:${id}`

type Computed =
  | { readonly ok: true; readonly hash: string; readonly input: PartGeometryInput }
  | { readonly ok: false; readonly error: AppError }

interface Waiter {
  readonly hash: string
  readonly resolve: (r: AppResult<PartEvaluationState>) => void
}

interface Request {
  readonly hash: string
  readonly revision: number
  readonly controller: AbortController
  readonly attempt: number
}

interface Entry {
  readonly kind: SubjectKind
  readonly id: string
  /** Clock time of the last change that altered the input (priority: most recent first). */
  lastEdit: number
  current: Computed | undefined
  timer: unknown
  /** Debounce over (or skipped): waiting for its turn. */
  due: boolean
  /** Asked for by `design.part.evaluate` / `evaluatePlan`: goes before automatic ones. */
  urgent: boolean
  attempt: number
  running: Request | undefined
  /**
   * The current input's debounce has elapsed (or was skipped): only then is a cached result
   * shown (docs/architecture/workers.md#triggers-and-debounce: nothing is requested or shown
   * until edits stop plus 200 ms).
   */
  quiet: boolean
  /** A transient failure (crash, timeout, unrequested abort) of the current input: shown, never cached. */
  transient: { readonly hash: string; readonly error: AppError } | undefined
  /** Revision of the newest accepted result. */
  storedRevision: number
  readonly lru: Map<string, AppResult<PartEvaluation>>
  waiters: Waiter[]
}

const WHERE = 'EvaluationScheduler'

const abortedErr = (message: string) => fail('op.aborted', message, { where: WHERE })

const exists = (doc: ProjectDoc, kind: SubjectKind, id: string): boolean =>
  Object.hasOwn(kind === 'part' ? doc.parts : doc.plans, id)

const idsOf = (doc: ProjectDoc, kind: SubjectKind): string[] =>
  Object.keys(kind === 'part' ? doc.parts : doc.plans)

/** Subjects a patch may change the geometry input of, as `[kind, id]` by key. */
function touchedSubjects(
  patches: readonly Patch[],
  doc: ProjectDoc,
): Map<string, [SubjectKind, string]> {
  const out = new Map<string, [SubjectKind, string]>()
  const add = (kind: SubjectKind, id: string) => out.set(keyOf(kind, id), [kind, id])
  for (const p of patches) {
    const [area, id] = p.path
    if (area === 'parts' && typeof id === 'string') add('part', id)
    else if (area === 'plans' && typeof id === 'string') add('plan', id)
    // a whole-record replace, or a stock snapshot change: recompute every part (cheap); plans
    // keep their own stock copies
    else if (area === 'parts' || area === 'snapshots' || p.path.length === 0)
      for (const partId of idsOf(doc, 'part')) add('part', partId)
    if ((area === 'plans' && id === undefined) || p.path.length === 0)
      for (const planId of idsOf(doc, 'plan')) add('plan', planId)
  }
  return out
}

export function createEvaluationScheduler(opts: SchedulerOptions): EvaluationScheduler {
  const timers = opts.timers ?? systemTimers
  const clock = opts.clock ?? systemClock
  const log = (opts.log ?? noopLogger).child({ scope: 'evaluation' })
  const debounceMs = opts.debounceMs ?? EVALUATION_DEBOUNCE_MS
  const lruSize = opts.lruSize ?? EVALUATION_LRU_SIZE
  const entries = new Map<string, Entry>()
  /** Per immutable document: the computed input of each subject, by key. */
  const computedByDoc = new WeakMap<ProjectDoc, Map<string, Computed>>()
  let source: EvaluationSource | undefined
  let unsubscribe: (() => void) | undefined
  /** At most one evaluation requested at a time, so a newly due subject can go first. */
  let inFlight: Entry | undefined
  const listeners: Record<SubjectKind, Set<(id: string) => void>> = {
    part: new Set(),
    plan: new Set(),
  }
  const notify = (kind: SubjectKind, id: string): void => {
    for (const l of [...listeners[kind]]) l(id)
  }
  const label = (e: Pick<Entry, 'kind' | 'id'>) =>
    e.kind === 'part' ? `part ${e.id}` : `the part of plan ${e.id}`

  function compute(doc: ProjectDoc, kind: SubjectKind, id: string): Computed {
    let perDoc = computedByDoc.get(doc)
    if (perDoc === undefined) computedByDoc.set(doc, (perDoc = new Map()))
    const key = keyOf(kind, id)
    const hit = perDoc.get(key)
    if (hit !== undefined) return hit
    const input =
      kind === 'part'
        ? partGeometryInput(doc, id, opts.region2d)
        : planGeometryInput(doc, id, opts.region2d)
    const c: Computed = input.isOk()
      ? { ok: true, hash: hashJson(input.unwrap()), input: input.unwrap() }
      : { ok: false, error: input.unwrapErr() }
    perDoc.set(key, c)
    return c
  }

  function entry(kind: SubjectKind, id: string): Entry {
    const key = keyOf(kind, id)
    let e = entries.get(key)
    if (e === undefined) {
      e = {
        kind,
        id,
        lastEdit: 0,
        current: undefined,
        timer: undefined,
        due: false,
        urgent: false,
        attempt: 1,
        running: undefined,
        quiet: false,
        transient: undefined,
        storedRevision: -1,
        lru: new Map(),
        waiters: [],
      }
      entries.set(key, e)
    }
    return e
  }

  function stateOf(e: Entry | undefined, c: Computed): PartEvaluationState {
    if (!c.ok) return { status: 'failed', error: c.error }
    const isCurrent = e?.current?.ok === true && e.current.hash === c.hash
    if (isCurrent && !e.quiet) return { status: 'pending', inputHash: c.hash }
    if (isCurrent && e.transient?.hash === c.hash)
      return { status: 'failed', inputHash: c.hash, error: e.transient.error }
    const r = e?.lru.get(c.hash)
    if (r === undefined) return { status: 'pending', inputHash: c.hash }
    return r.isOk()
      ? { status: 'done', inputHash: c.hash, evaluation: r.unwrap() }
      : { status: 'failed', inputHash: c.hash, error: r.unwrapErr() }
  }

  /** Stores a result as the most recent of the subject's LRU. */
  function store(e: Entry, hash: string, r: AppResult<PartEvaluation>): void {
    e.lru.delete(hash)
    e.lru.set(hash, r)
    while (e.lru.size > lruSize) e.lru.delete(e.lru.keys().next().value!)
  }

  /** A result for `hash` stored by another subject (e.g. an unedited plan and its design part). */
  function shared(hash: string): AppResult<PartEvaluation> | undefined {
    for (const other of entries.values()) {
      const r = other.lru.get(hash)
      if (r !== undefined) return r
    }
    return undefined
  }

  function resolveWaiters(
    e: Entry,
    pred: (w: Waiter) => boolean,
    r: () => AppResult<PartEvaluationState>,
  ) {
    const keep: Waiter[] = []
    for (const w of e.waiters) {
      if (pred(w)) w.resolve(r())
      else keep.push(w)
    }
    e.waiters = keep
  }

  function abortRunning(e: Entry, why: string): void {
    if (e.running === undefined) return
    log.debug({ [`${e.kind}Id`]: e.id, hash: e.running.hash, why }, 'evaluation aborted')
    e.running.controller.abort()
    e.running = undefined
  }

  function remove(kind: SubjectKind, id: string): void {
    const key = keyOf(kind, id)
    const e = entries.get(key)
    if (e === undefined) return
    timers.clear(e.timer)
    abortRunning(e, `${kind} removed`)
    resolveWaiters(
      e,
      () => true,
      () => abortedErr(`${label(e)} was removed`),
    )
    entries.delete(key)
    notify(kind, id)
  }

  /** A commit may have changed the subject's input. */
  function changed(doc: ProjectDoc, kind: SubjectKind, id: string, debounce: boolean): void {
    if (!exists(doc, kind, id)) return remove(kind, id)
    const before = entries.get(keyOf(kind, id))?.current
    update(doc, kind, id, debounce)
    if (entries.get(keyOf(kind, id))?.current !== before) notify(kind, id)
  }

  function update(doc: ProjectDoc, kind: SubjectKind, id: string, debounce: boolean): void {
    const e = entry(kind, id)
    const c = compute(doc, kind, id)
    const prev = e.current
    if (prev !== undefined && prev.ok && c.ok && prev.hash === c.hash) return // e.g. a rename
    e.current = c
    e.lastEdit = clock.now()
    e.attempt = 1
    e.quiet = !debounce
    e.transient = undefined
    timers.clear(e.timer)
    e.timer = undefined
    e.due = false
    if (e.running !== undefined && (!c.ok || e.running.hash !== c.hash))
      abortRunning(e, 'newer revision')
    if (!c.ok) {
      // an input error (e.g. an expression) is `failed` at once; nothing goes to a worker
      resolveWaiters(
        e,
        () => true,
        () => Ok(stateOf(e, c)),
      )
      return
    }
    resolveWaiters(
      e,
      (w) => w.hash !== c.hash,
      () => abortedErr(`${label(e)} changed; evaluate again`),
    )
    if (!debounce) {
      e.due = true
      return
    }
    e.timer = timers.set(() => {
      e.timer = undefined
      e.quiet = true
      e.due = true
      schedule()
      notify(e.kind, e.id) // a cached result of this input shows now
    }, debounceMs)
  }

  function next(): Entry | undefined {
    let best: Entry | undefined
    for (const e of entries.values()) {
      if (!e.due || e.running !== undefined) continue
      if (
        best === undefined ||
        (e.urgent && !best.urgent) ||
        (e.urgent === best.urgent && e.lastEdit > best.lastEdit)
      )
        best = e
    }
    return best
  }

  function schedule(): void {
    while (inFlight === undefined && source !== undefined) {
      const e = next()
      if (e === undefined) return
      e.due = false
      e.urgent = false
      const c = e.current
      if (c === undefined || !c.ok) continue
      const own = e.lru.get(c.hash)
      const r = own ?? shared(c.hash)
      if (r !== undefined) {
        // undo/redo back to an evaluated input, or an input another subject has: instant, no
        // worker run
        store(e, c.hash, r)
        resolveWaiters(
          e,
          (w) => w.hash === c.hash,
          () => Ok(stateOf(e, c)),
        )
        if (own === undefined) notify(e.kind, e.id)
        continue
      }
      start(e, c)
    }
  }

  function start(e: Entry, c: Extract<Computed, { ok: true }>): void {
    const req: Request = {
      hash: c.hash,
      revision: source!.revision,
      controller: new AbortController(),
      attempt: e.attempt,
    }
    e.running = req
    inFlight = e
    log.debug(
      {
        [`${e.kind}Id`]: e.id,
        hash: c.hash,
        revision: req.revision,
        attempt: req.attempt,
      },
      'evaluation started',
    )
    void opts.workers
      .run(geometryEvaluate, c.input, { signal: req.controller.signal, progress: () => {} })
      .then((r) => finished(e, req, r))
  }

  function finished(e: Entry, req: Request, r: AppResult<PartEvaluation>): void {
    if (inFlight === e) inFlight = undefined
    if (e.running === req) e.running = undefined
    // aborted by us (newer revision, removed subject, close): nothing to store or answer
    if (entries.get(keyOf(e.kind, e.id)) !== e || req.controller.signal.aborted) {
      schedule()
      return
    }
    const current = e.current?.ok === true && e.current.hash === req.hash
    const code = r.isErr() ? r.unwrapErr().code : undefined
    // a crash, a timeout or an abort nobody asked for (e.g. the pool closed): not the input's fault
    if (code === 'internal.unexpected' || code === 'op.timeout' || code === 'op.aborted') {
      if (req.attempt === 1 && current) {
        log.debug({ [`${e.kind}Id`]: e.id, code }, 'evaluation retried')
        e.attempt = 2
        e.due = true
      } else if (current) {
        // shown as failed, never cached by hash: design.part.evaluate runs it again
        e.transient = { hash: req.hash, error: r.unwrapErr() }
        const c = e.current!
        resolveWaiters(
          e,
          (w) => w.hash === req.hash,
          () => Ok(stateOf(e, c)),
        )
        notify(e.kind, e.id)
      }
      schedule()
      return
    }
    // a straggler for an older input (out of order): dropped; a result for the current input
    // is valid whatever its revision (e.g. after a re-attach)
    if (req.revision <= e.storedRevision && !current) {
      log.debug(
        { [`${e.kind}Id`]: e.id, revision: req.revision },
        'out-of-order evaluation result dropped',
      )
      schedule()
      return
    }
    e.storedRevision = Math.max(e.storedRevision, req.revision)
    store(e, req.hash, r)
    log.debug(
      {
        [`${e.kind}Id`]: e.id,
        hash: req.hash,
        ok: r.isOk(),
        ms: r.isOk() ? r.unwrap().stats.ms : undefined,
      },
      'evaluation finished',
    )
    const c = e.current
    if (c !== undefined)
      resolveWaiters(
        e,
        (w) => w.hash === req.hash,
        () => Ok(stateOf(e, c)),
      )
    notify(e.kind, e.id)
    schedule()
  }

  function onCommit(patches: readonly Patch[] | undefined): void {
    if (source === undefined || patches === undefined || patches.length === 0) return
    const doc = source.doc
    for (const [kind, id] of touchedSubjects(patches, doc).values()) changed(doc, kind, id, true)
    // subjects that vanished without a `parts/<id>` / `plans/<id>` patch (whole-record replace)
    for (const e of [...entries.values()]) if (!exists(doc, e.kind, e.id)) remove(e.kind, e.id)
    schedule()
  }

  function close(): void {
    unsubscribe?.()
    unsubscribe = undefined
    source = undefined
    for (const e of [...entries.values()]) remove(e.kind, e.id)
    inFlight = undefined
  }

  function subscribe(kind: SubjectKind, listener: (id: string) => void): () => void {
    listeners[kind].add(listener)
    return () => void listeners[kind].delete(listener)
  }

  function evaluateSubject(
    kind: SubjectKind,
    id: string,
    signal: AbortSignal,
  ): AsyncAppResult<PartEvaluationState> {
    if (source === undefined)
      return Promise.resolve(fail('internal.unexpected', 'no project attached', { where: WHERE }))
    const doc = source.doc
    if (!exists(doc, kind, id))
      return Promise.resolve(
        kind === 'part' ? unknownPart(id, 'design.part.evaluate') : unknownPlan(id, WHERE),
      )
    if (signal.aborted) return Promise.resolve(abortedErr('aborted'))
    const e = entry(kind, id)
    if (e.current === undefined) changed(doc, kind, id, false)
    const c = e.current!
    // skips the debounce; a transient failure is run again
    e.quiet = true
    if (c.ok && e.transient?.hash === c.hash) {
      e.transient = undefined
      e.attempt = 1
    }
    const now = stateOf(e, c)
    if (now.status !== 'pending') {
      notify(kind, id) // skipping the debounce may show a cached result
      return Promise.resolve(Ok(now))
    }
    return new Promise((resolve) => {
      const w: Waiter = {
        hash: (c as Extract<Computed, { ok: true }>).hash,
        resolve: (r) => {
          signal.removeEventListener('abort', onAbort)
          resolve(r)
        },
      }
      const onAbort = () => {
        e.waiters = e.waiters.filter((x) => x !== w)
        resolve(
          abortedErr(
            kind === 'part'
              ? 'design.part.evaluate was aborted'
              : `evaluation of ${label(e)} was aborted`,
          ),
        )
      }
      signal.addEventListener('abort', onAbort, { once: true })
      e.waiters.push(w)
      if (e.running?.hash !== w.hash) {
        timers.clear(e.timer)
        e.timer = undefined
        e.due = true
        e.urgent = true
      }
      schedule()
    })
  }

  return {
    attach(s) {
      // a second attach starts over, as close() then attach()
      if (source !== undefined) close()
      source = s
      unsubscribe = s.log.subscribe({ withPatches: true }, (e) =>
        onCommit('patches' in e ? e.patches : undefined),
      )
      // parts first: an unedited plan's part then reuses its design part's result
      for (const partId of idsOf(s.doc, 'part')) changed(s.doc, 'part', partId, false)
      for (const planId of idsOf(s.doc, 'plan')) changed(s.doc, 'plan', planId, false)
      schedule()
    },
    close,
    onChange: (listener) => subscribe('part', listener),
    onPlanChange: (listener) => subscribe('plan', listener),
    state(doc, partId) {
      return stateOf(entries.get(keyOf('part', partId)), compute(doc, 'part', partId))
    },
    planState(doc, planId) {
      return stateOf(entries.get(keyOf('plan', planId)), compute(doc, 'plan', planId))
    },
    evaluate: (partId, signal) => evaluateSubject('part', partId, signal),
    evaluatePlan: (planId, signal) => evaluateSubject('plan', planId, signal),
  }
}

// ── warnings and the job ──────────────────────────────────────────────────────────────────

/**
 * Parameter warnings plus the geometry warnings of a `done` evaluation, ordered by operation
 * (design order; parameter warnings first within an operation; unknown ids such as `stock` last).
 * Doc: docs/modes/design.md#dfm-warnings-task-28-wiring
 */
export function mergeWarnings(
  parameter: readonly DfmWarning[],
  geometry: readonly DfmWarning[],
  operationIds: readonly string[],
): DfmWarning[] {
  const rank = new Map(operationIds.map((id, i) => [id, i]))
  const keyed = [...parameter, ...geometry].map((w, i) => ({ w, i }))
  const r = (w: DfmWarning) => rank.get(w.operation) ?? operationIds.length
  keyed.sort((a, b) => r(a.w) - r(b.w) || a.i - b.i)
  return keyed.map((k) => k.w)
}

/** Why an evaluation failed, in results. */
export const EvaluationErrorSchema = AppErrorDataSchema

export const EvaluationStatusSchema = z
  .enum(EVALUATION_STATUSES)
  .describe(
    'done: geometry warnings included; pending: debouncing or running, parameter warnings only; failed: see error',
  )

/** The design.warning.list result for a part, given its parameter warnings. */
export function warningsWithEvaluation(
  doc: ProjectDoc,
  partId: string,
  parameter: readonly DfmWarning[],
  state: PartEvaluationState,
): {
  warnings: DfmWarning[]
  evaluation: EvaluationStatus
  error?: AppErrorData
} {
  const operations = doc.parts[partId]?.operations ?? []
  const ids = operations.map((o) => o.id)
  const geometry = namedMessages(
    operations,
    state.status === 'done' ? (state.evaluation?.warnings ?? []) : [],
  )
  return {
    warnings: mergeWarnings(parameter, geometry, ids),
    evaluation: state.status,
    ...(state.error === undefined ? {} : { error: state.error.toWireData() }),
  }
}

export const partEvaluate = defineCommand({
  kind: 'job',
  name: 'design.part.evaluate',
  summary:
    "Evaluate a part's geometry now; the job's outcome has its DFM warnings, as changes (joins a running evaluation; a newer edit of the part aborts it).",
  title: () => 'Evaluate part',
  machine: false,
  args: z.object({ partId: PartIdSchema }),
  result: z.object({
    evaluation: EvaluationStatusSchema,
    warnings: z.array(DfmWarningSchema),
    error: EvaluationErrorSchema.optional(),
  }),
  async run(doc, args, ctx) {
    const where = 'design.part.evaluate'
    const evaluations = ctx.services.evaluations
    if (evaluations === undefined)
      return fail('internal.unexpected', 'no evaluation service configured', { where })
    const loaded = loadEnabledPart(doc, args.partId, where)
    if (loaded.isErr()) return Err(loaded.unwrapErr())
    const state = await evaluations.evaluate(args.partId, ctx.signal)
    if (state.isErr()) return Err(state.unwrapErr())
    const { part, stock, units, features, dto } = loaded.unwrap()
    const library = ctx.services.library
    const tools = library === undefined ? [] : libraryTools(library)
    const parameter = partWarnings(
      part,
      stock,
      units,
      tools,
      doc.snapshots,
      ctx.services.region2d,
      features,
      dto.shapes,
    )

    if (parameter.isErr()) return Err(parameter.unwrapErr().withContext(where))
    return Ok(warningsWithEvaluation(doc, args.partId, parameter.unwrap(), state.unwrap()))
  },
})
