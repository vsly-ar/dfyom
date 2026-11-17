/**
 * Automatic part evaluation after design edits: per-part trailing debounce, abort on a newer
 * revision, a result store keyed by input hash with a small LRU, and the `design.part.evaluate`
 * job. Not a job itself (one job per edit would flood the action log); debug log only.
 * Doc: docs/architecture/workers.md#automatic-evaluation-after-design-edits
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
import type { PartEvaluation } from '../geometry/evaluate'
import type { DfmWarning, PartGeometryInput } from '../geometry/model'
import { hashJson } from '../plan/snapshot'
import type { ProjectDoc } from '../project/document'
import { geometryEvaluate } from '../workers/tasks'
import { loadPart, partGeometryInput, unknownPart } from './load'
import { PartIdSchema } from './part.dto'
import { DfmWarningSchema, libraryTools, partWarnings } from './warnings'

export const EVALUATION_STATUSES = ['done', 'pending', 'failed'] as const
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number]

/** A part's evaluation for one document: `done` / `failed` for its current input hash, else `pending`. */
export interface PartEvaluationState {
  readonly status: EvaluationStatus
  /** Hash of the part's geometry input in that document (absent when the input fails). */
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
  /** Start following a project: every part is dirty (evaluated at once, in document order). */
  attach(source: EvaluationSource): void
  /** Project closed: abort everything, drop all results. */
  close(): void
}

export interface SchedulerOptions {
  readonly workers: WorkerPort
  readonly timers?: Timers
  readonly clock?: Clock
  readonly log?: Logger
  /** Trailing debounce per part, no max wait (default 200 ms). */
  readonly debounceMs?: number
  /** Results kept per part, by input hash (default 8). */
  readonly lruSize?: number
}

export const EVALUATION_DEBOUNCE_MS = 200
export const EVALUATION_LRU_SIZE = 8

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

interface PartEntry {
  readonly id: string
  /** Clock time of the last change that altered the input (priority: most recent first). */
  lastEdit: number
  current: Computed | undefined
  timer: unknown
  /** Debounce over (or skipped): waiting for its turn. */
  due: boolean
  /** Asked for by `design.part.evaluate`: goes before automatic ones. */
  urgent: boolean
  attempt: number
  running: Request | undefined
  /** Revision of the newest accepted result. */
  storedRevision: number
  readonly lru: Map<string, AppResult<PartEvaluation>>
  waiters: Waiter[]
}

const WHERE = 'EvaluationScheduler'

const abortedErr = (message: string) => fail('op.aborted', message, { where: WHERE })

/** Part ids a patch may change the geometry input of (`undefined` = all parts). */
function touchedParts(patches: readonly Patch[], doc: ProjectDoc): Set<string> {
  const out = new Set<string>()
  for (const p of patches) {
    const [area, id] = p.path
    if (area === 'parts' && typeof id === 'string') out.add(id)
    // a whole-record replace, or a stock snapshot change: recompute every part (cheap)
    else if (area === 'parts' || area === 'snapshots' || p.path.length === 0)
      for (const partId of Object.keys(doc.parts)) out.add(partId)
  }
  return out
}

export function createEvaluationScheduler(opts: SchedulerOptions): EvaluationScheduler {
  const timers = opts.timers ?? systemTimers
  const clock = opts.clock ?? systemClock
  const log = (opts.log ?? noopLogger).child({ scope: 'evaluation' })
  const debounceMs = opts.debounceMs ?? EVALUATION_DEBOUNCE_MS
  const lruSize = opts.lruSize ?? EVALUATION_LRU_SIZE
  const parts = new Map<string, PartEntry>()
  /** Per immutable document: the computed input of each part. */
  const computedByDoc = new WeakMap<ProjectDoc, Map<string, Computed>>()
  let source: EvaluationSource | undefined
  let unsubscribe: (() => void) | undefined
  /** At most one evaluation requested at a time, so a newly due part can go first. */
  let inFlight: PartEntry | undefined

  function compute(doc: ProjectDoc, partId: string): Computed {
    let perDoc = computedByDoc.get(doc)
    if (perDoc === undefined) computedByDoc.set(doc, (perDoc = new Map()))
    const hit = perDoc.get(partId)
    if (hit !== undefined) return hit
    const input = partGeometryInput(doc, partId)
    const c: Computed = input.isOk()
      ? { ok: true, hash: hashJson(input.unwrap()), input: input.unwrap() }
      : { ok: false, error: input.unwrapErr() }
    perDoc.set(partId, c)
    return c
  }

  function entry(partId: string): PartEntry {
    let e = parts.get(partId)
    if (e === undefined) {
      e = {
        id: partId,
        lastEdit: 0,
        current: undefined,
        timer: undefined,
        due: false,
        urgent: false,
        attempt: 1,
        running: undefined,
        storedRevision: -1,
        lru: new Map(),
        waiters: [],
      }
      parts.set(partId, e)
    }
    return e
  }

  function stateOf(e: PartEntry | undefined, c: Computed): PartEvaluationState {
    if (!c.ok) return { status: 'failed', error: c.error }
    const r = e?.lru.get(c.hash)
    if (r === undefined) return { status: 'pending', inputHash: c.hash }
    return r.isOk()
      ? { status: 'done', inputHash: c.hash, evaluation: r.unwrap() }
      : { status: 'failed', inputHash: c.hash, error: r.unwrapErr() }
  }

  function resolveWaiters(
    e: PartEntry,
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

  function abortRunning(e: PartEntry, why: string): void {
    if (e.running === undefined) return
    log.debug({ partId: e.id, hash: e.running.hash, why }, 'evaluation aborted')
    e.running.controller.abort()
    e.running = undefined
  }

  function remove(partId: string): void {
    const e = parts.get(partId)
    if (e === undefined) return
    timers.clear(e.timer)
    abortRunning(e, 'part removed')
    resolveWaiters(
      e,
      () => true,
      () => abortedErr(`part ${partId} was removed`),
    )
    parts.delete(partId)
  }

  /** A commit may have changed the part's input. */
  function changed(doc: ProjectDoc, partId: string, debounce: boolean): void {
    if (!Object.hasOwn(doc.parts, partId)) return remove(partId)
    const e = entry(partId)
    const c = compute(doc, partId)
    const prev = e.current
    if (prev !== undefined && prev.ok && c.ok && prev.hash === c.hash) return // e.g. a rename
    e.current = c
    e.lastEdit = clock.now()
    e.attempt = 1
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
      () => abortedErr(`part ${partId} changed; evaluate again`),
    )
    if (e.lru.has(c.hash) && e.waiters.length > 0)
      resolveWaiters(
        e,
        () => true,
        () => Ok(stateOf(e, c)),
      )
    if (!debounce) {
      e.due = true
      return
    }
    e.timer = timers.set(() => {
      e.timer = undefined
      e.due = true
      schedule()
    }, debounceMs)
  }

  function next(): PartEntry | undefined {
    let best: PartEntry | undefined
    for (const e of parts.values()) {
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
      if (e.lru.has(c.hash)) {
        // undo/redo back to an evaluated input: instant, no worker run
        const r = e.lru.get(c.hash)!
        e.lru.delete(c.hash)
        e.lru.set(c.hash, r)
        resolveWaiters(
          e,
          (w) => w.hash === c.hash,
          () => Ok(stateOf(e, c)),
        )
        continue
      }
      start(e, c)
    }
  }

  function start(e: PartEntry, c: Extract<Computed, { ok: true }>): void {
    const req: Request = {
      hash: c.hash,
      revision: source!.revision,
      controller: new AbortController(),
      attempt: e.attempt,
    }
    e.running = req
    inFlight = e
    log.debug(
      { partId: e.id, hash: c.hash, revision: req.revision, attempt: req.attempt },
      'evaluation started',
    )
    void opts.workers
      .run(geometryEvaluate, c.input, { signal: req.controller.signal, progress: () => {} })
      .then((r) => finished(e, req, r))
  }

  function finished(e: PartEntry, req: Request, r: AppResult<PartEvaluation>): void {
    if (inFlight === e) inFlight = undefined
    if (e.running === req) e.running = undefined
    const alive = parts.get(e.id) === e
    if (
      !alive ||
      req.controller.signal.aborted ||
      (r.isErr() && r.unwrapErr().code === 'op.aborted')
    ) {
      schedule()
      return
    }
    const code = r.isErr() ? r.unwrapErr().code : undefined
    const current = e.current?.ok === true && e.current.hash === req.hash
    if ((code === 'internal.unexpected' || code === 'op.timeout') && req.attempt === 1 && current) {
      // a crash or timeout: once more on a fresh worker
      log.debug({ partId: e.id, code }, 'evaluation retried')
      e.attempt = 2
      e.due = true
      schedule()
      return
    }
    if (req.revision <= e.storedRevision) {
      log.debug({ partId: e.id, revision: req.revision }, 'out-of-order evaluation result dropped')
      schedule()
      return
    }
    e.storedRevision = req.revision
    e.lru.delete(req.hash)
    e.lru.set(req.hash, r)
    while (e.lru.size > lruSize) e.lru.delete(e.lru.keys().next().value!)
    log.debug(
      {
        partId: e.id,
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
    schedule()
  }

  function onCommit(patches: readonly Patch[] | undefined): void {
    if (source === undefined || patches === undefined || patches.length === 0) return
    const doc = source.doc
    for (const partId of touchedParts(patches, doc)) changed(doc, partId, true)
    // parts that vanished without a `parts/<id>` patch (whole-record replace)
    for (const partId of [...parts.keys()]) if (!Object.hasOwn(doc.parts, partId)) remove(partId)
    schedule()
  }

  return {
    attach(s) {
      unsubscribe?.()
      source = s
      unsubscribe = s.log.subscribe({ withPatches: true }, (e) =>
        onCommit('patches' in e ? e.patches : undefined),
      )
      for (const partId of Object.keys(s.doc.parts)) changed(s.doc, partId, false)
      schedule()
    },
    close() {
      unsubscribe?.()
      unsubscribe = undefined
      source = undefined
      for (const partId of [...parts.keys()]) remove(partId)
      inFlight = undefined
    },
    state(doc, partId) {
      return stateOf(parts.get(partId), compute(doc, partId))
    },
    evaluate(partId, signal) {
      if (source === undefined)
        return Promise.resolve(fail('internal.unexpected', 'no project attached', { where: WHERE }))
      const doc = source.doc
      if (!Object.hasOwn(doc.parts, partId))
        return Promise.resolve(unknownPart(partId, 'design.part.evaluate'))
      if (signal.aborted) return Promise.resolve(abortedErr('aborted'))
      const e = entry(partId)
      if (e.current === undefined) changed(doc, partId, false)
      const c = e.current!
      const now = stateOf(e, c)
      if (now.status !== 'pending') return Promise.resolve(Ok(now))
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
          resolve(abortedErr('design.part.evaluate was aborted'))
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
    },
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
  const ids = (doc.parts[partId]?.operations ?? []).map((o) => o.id)
  const geometry = state.status === 'done' ? (state.evaluation?.warnings ?? []) : []
  return {
    warnings: mergeWarnings(parameter, geometry, ids),
    evaluation: state.status,
    ...(state.error === undefined ? {} : { error: state.error.toJSON() }),
  }
}

export const partEvaluate = defineCommand({
  kind: 'job',
  name: 'design.part.evaluate',
  summary:
    "Evaluate a part's geometry now and wait for its DFM warnings (joins a running evaluation; a newer edit of the part aborts it).",
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
    const loaded = loadPart(doc, args.partId, where)
    if (loaded.isErr()) return Err(loaded.unwrapErr())
    const state = await evaluations.evaluate(args.partId, ctx.signal)
    if (state.isErr()) return Err(state.unwrapErr())
    const { part, stock, units } = loaded.unwrap()
    const library = ctx.services.library
    const tools = library === undefined ? [] : libraryTools(library)
    const parameter = partWarnings(part, stock, units, tools)
    if (parameter.isErr()) return Err(parameter.unwrapErr().withContext(where))
    return Ok(warningsWithEvaluation(doc, args.partId, parameter.unwrap(), state.unwrap()))
  },
})
