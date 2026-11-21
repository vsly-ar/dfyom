// The window's part evaluations (task 3.6): the status of each part of the bound project and its
// last good mesh, from main's push (`evaluation.onChange`) and a query on (re)bind. A pending or
// failed evaluation keeps the last mesh, so the viewport shows it outdated (ui.md decision 15).
// Shared by the design and plan scenes. Doc: docs/conventions/ui.md#evaluation-status-pending-outdated-failed,
// docs/architecture/workers.md#evaluation-status
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

export type EvaluationsState = ReadonlyMap<string, PartEvaluationEntry>

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
  /** Parts asked for since the last binding change. */
  let asked = new Set<string>()
  const listeners = new Set<() => void>()

  const set = (next: EvaluationsState) => {
    state = next
    for (const l of [...listeners]) l()
  }

  const apply = (view: PartEvaluationView) => {
    if (view.key !== key) return
    const prev = state.get(view.partId)
    const entry: PartEvaluationEntry = {
      status: view.status,
      ...(view.inputHash === undefined ? {} : { inputHash: view.inputHash }),
      mesh: view.mesh ?? prev?.mesh ?? null,
      ...(view.error === undefined ? {} : { error: view.error }),
    }
    const next = new Map(state)
    next.set(view.partId, entry)
    set(next)
  }

  /** Follows the replica: a new binding starts over; new parts are asked for once. */
  const sync = () => {
    const r = replica.getState()
    const nextKey = r.status === 'open' ? r.key : undefined
    if (nextKey !== key) {
      key = nextKey
      asked = new Set()
      set(EMPTY)
    }
    if (r.status !== 'open') return
    for (const partId of Object.keys(r.doc.parts)) {
      if (asked.has(partId)) continue
      asked.add(partId)
      const forKey = key
      void bridge.evaluation.get(partId).then((view) => {
        // a push may have arrived meanwhile: it is newer unless the answer is for another input
        if (view === null || forKey !== key) return
        const known = state.get(partId)
        if (known !== undefined && known.inputHash === view.inputHash && known.status !== 'pending')
          return
        apply(view)
      })
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    start() {
      const offPush = bridge.evaluation.onChange((view) => {
        asked.add(view.partId)
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
