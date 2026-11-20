// Part evaluations for windows: the renderer mesh push and query (task 3.6). A window follows the
// evaluations of its bound project; each change is pushed once per status and input hash, with
// the mesh only when `done` (copied by Electron IPC, ≤ about 1 MB at the triangle budget).
// Window plumbing, not an agent capability: agents read `design.warning.list`.
// Doc: docs/architecture/workers.md#evaluation-status, docs/architecture/overview.md#ipc
import type { PartEvaluationView } from '../shared/preload-api'
import type { AppHost } from './host/app-host'

type EvaluationHost = Pick<AppHost, 'evaluation' | 'onEvaluation'>

/** The part's evaluation in the project's current document, or null (no such project or part). */
export function evaluationView(
  host: EvaluationHost,
  key: string,
  partId: string,
): PartEvaluationView | null {
  const state = host.evaluation(key, partId)
  if (state === undefined) return null
  const e = state.evaluation
  return {
    key,
    partId,
    status: state.status,
    ...(state.inputHash === undefined ? {} : { inputHash: state.inputHash }),
    ...(state.status === 'done' && e !== undefined
      ? {
          mesh: {
            positions: e.positions,
            indices: e.indices,
            triangleSurface: e.triangleSurface,
            surfaces: e.surfaces,
          },
        }
      : {}),
    ...(state.error === undefined ? {} : { error: state.error.toJSON() }),
  }
}

/** Pushes the project's evaluation changes through `send`, deduplicated. Returns the unsubscribe. */
export function followEvaluations(
  host: EvaluationHost,
  key: string,
  send: (view: PartEvaluationView) => void,
): () => void {
  const last = new Map<string, string>()
  return host.onEvaluation(key, (partId) => {
    const view = evaluationView(host, key, partId)
    if (view === null) {
      last.delete(partId)
      return
    }
    const tag = `${view.status}:${view.inputHash ?? ''}`
    if (last.get(partId) === tag) return
    last.set(partId, tag)
    send(view)
  })
}
