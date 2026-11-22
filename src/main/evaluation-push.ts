// Part evaluations for windows: the renderer mesh push and query (task 3.6), and the evaluation of
// each plan's part for the plan's snapshot scene (task E3b). A window follows the evaluations of
// its bound project; each change is pushed once per subject, status and input hash, with the mesh
// only when `done` (copied by Electron IPC, ≤ about 1 MB at the triangle budget).
// Window plumbing, not an agent capability: agents read `design.warning.list`.
// Doc: docs/architecture/workers.md#evaluation-status, docs/architecture/overview.md#ipc,
// docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene
import type { PartEvaluationState } from '../core/design/evaluation'
import type { PartEvaluationView } from '../shared/preload-api'
import type { AppHost } from './host/app-host'

type EvaluationHost = Pick<
  AppHost,
  'evaluation' | 'onEvaluation' | 'planEvaluation' | 'onPlanEvaluation'
>

function viewOf(
  key: string,
  partId: string,
  state: PartEvaluationState,
  planId?: string,
): PartEvaluationView {
  const e = state.evaluation
  return {
    key,
    partId,
    ...(planId === undefined ? {} : { planId }),
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

/** The part's evaluation in the project's current document, or null (no such project or part). */
export function evaluationView(
  host: Pick<EvaluationHost, 'evaluation'>,
  key: string,
  partId: string,
): PartEvaluationView | null {
  const state = host.evaluation(key, partId)
  return state === undefined ? null : viewOf(key, partId, state)
}

/** The evaluation of the plan's part (snapshot scene), or null (no such project or plan). */
export function planEvaluationView(
  host: Pick<EvaluationHost, 'planEvaluation'>,
  key: string,
  planId: string,
): PartEvaluationView | null {
  const found = host.planEvaluation(key, planId)
  return found === undefined ? null : viewOf(key, found.partId, found.state, planId)
}

/**
 * Pushes the project's evaluation changes (design parts and plans' parts) through `send`,
 * deduplicated per subject. Returns the unsubscribe.
 */
export function followEvaluations(
  host: EvaluationHost,
  key: string,
  send: (view: PartEvaluationView) => void,
): () => void {
  const last = new Map<string, string>()
  const push = (subject: string, view: PartEvaluationView | null) => {
    if (view === null) {
      last.delete(subject)
      return
    }
    const tag = `${view.status}:${view.inputHash ?? ''}`
    if (last.get(subject) === tag) return
    last.set(subject, tag)
    send(view)
  }
  // subject keys as the scheduler's: ids never contain `:`
  const offParts = host.onEvaluation(key, (partId) =>
    push(`part:${partId}`, evaluationView(host, key, partId)),
  )
  const offPlans = host.onPlanEvaluation(key, (planId) =>
    push(`plan:${planId}`, planEvaluationView(host, key, planId)),
  )
  return () => {
    offParts()
    offPlans()
  }
}
