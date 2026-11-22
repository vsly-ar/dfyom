// The window's part evaluations (task 3.6): the status of each part of the bound project and its
// last good mesh, from main's push (`evaluation.onChange`) and a query on (re)bind. A pending or
// failed evaluation keeps the last mesh, so the viewport shows it outdated (ui.md decision 15).
// Also each plan's part (its snapshot with plan-only edits, task E3b), under `planSubject(planId)`.
// Shared by the design and plan scenes. Doc: docs/conventions/ui.md#evaluation-status-pending-outdated-failed,
// docs/architecture/workers.md#evaluation-status, docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene
import type { EvaluationStatus } from '../../../core/design/evaluation'
import type { AppErrorData } from '../../../shared/errors/app-error'
import type { EvaluationMesh, PartEvaluationView, PreloadApi } from '../../../shared/preload-api'
import type { Replica } from './replica'

export interface PartEvaluationEntry {
  readonly status: EvaluationStatus
  readonly inputHash?: string
  /** The last mesh of a done evaluation (possibly of an older input); null before the first. */
  readonly mesh: EvaluationMesh | null
  readonly error?: AppErrorData
}

/** Entries by subject: a design part by its id, a plan's part by `planSubject(planId)`. */
export type EvaluationsState = ReadonlyMap<string, PartEvaluationEntry>

/** The state key of a plan's part (ids never contain `:`, so it cannot clash with a part id). */
export const planSubject = (planId: string): string => `plan:${planId}`

const subjectOf = (view: PartEvaluationView): string =>
  view.planId === undefined ? view.partId : planSubject(view.planId)

export interface Evaluations {
  getState(): EvaluationsState
  subscribe(listener: () => void): () => void
  /** Follows the bridge and the replica's binding; returns the stop function. */
  start(): () => void
}

const EMPTY: EvaluationsState = new Map()

export function createEvaluations(
  bridge: Pick<PreloadApi, 'evaluation'>,
  replica: Pick<Replica, 'getState' | 'subscribe'>,
): Evaluations {
  let state: EvaluationsState = EMPTY
  let key: string | undefined
  /** Subjects asked for since the last binding change. */
  let asked = new Set<string>()
  const listeners = new Set<() => void>()

  const set = (next: EvaluationsState) => {
    state = next
    for (const l of [...listeners]) l()
  }

  const apply = (view: PartEvaluationView) => {
    if (view.key !== key) return
    const subject = subjectOf(view)
    const prev = state.get(subject)
    const entry: PartEvaluationEntry = {
      status: view.status,
      ...(view.inputHash === undefined ? {} : { inputHash: view.inputHash }),
      mesh: view.mesh ?? prev?.mesh ?? null,
      ...(view.error === undefined ? {} : { error: view.error }),
    }
    const next = new Map(state)
    next.set(subject, entry)
    set(next)
  }

  /** Asks main once for a subject; a push that arrived meanwhile is newer unless for another input. */
  const ask = (subject: string, get: () => Promise<PartEvaluationView | null>) => {
    if (asked.has(subject)) return
    asked.add(subject)
    const forKey = key
    void get().then((view) => {
      if (view === null || forKey !== key) return
      const known = state.get(subject)
      if (known !== undefined && known.inputHash === view.inputHash && known.status !== 'pending')
        return
      apply(view)
    })
  }

  /** Follows the replica: a new binding starts over; new parts and plans are asked for once. */
  const sync = () => {
    const r = replica.getState()
    const nextKey = r.status === 'open' ? r.key : undefined
    if (nextKey !== key) {
      key = nextKey
      asked = new Set()
      set(EMPTY)
    }
    if (r.status !== 'open') return
    for (const partId of Object.keys(r.doc.parts)) ask(partId, () => bridge.evaluation.get(partId))
    for (const planId of Object.keys(r.doc.plans))
      ask(planSubject(planId), () => bridge.evaluation.getPlan(planId))
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    start() {
      const offPush = bridge.evaluation.onChange((view) => {
        asked.add(subjectOf(view))
        apply(view)
      })
      const offReplica = replica.subscribe(sync)
      sync()
      return () => {
        offPush()
        offReplica()
      }
    },
  }
}
