// Already-cut marks from Run (hardening DF135 C2): after a real run to the end of an unchanged
// program, the window that started it marks the run's finished design operations already cut
// (one `design.part.update { alreadyCut, cutByRun }`, a pending design change like a hand mark)
// and the run section says so with Undo; after a stop or an interruption, once no resume is
// pending, it offers the finished operations instead. The virtual machine marks nothing. The
// pre-flight's offer to clear the marks for a new blank when its setup is cut in full (Q199).
// Doc: docs/modes/cut-state.md#marking, #implementation-c2, #a-new-blank-q199
import { useEffect } from 'react'
import type { PartDTO } from '../../../../core/design/part.dto'
import type { PlanDTO } from '../../../../core/plan/plan.dto'
import type { ProjectDoc } from '../../../../core/project/document'
import { runCutMarks, runMarkUpdate } from '../../../../core/run/cut-marks'
import { planMessages } from '../../messages/plan'
import { runMessages } from '../../messages/run'
import { useCall } from '../../shell/hooks'
import { Button, Icon } from '../../ui'
import { itemName } from '../design/model'
import { useRun, useRunStore, type CutMarksState } from './run-store'
import styles from './Run.module.css'

const m = runMessages.cutMarks

/** The run section's design part of `planId`, as the design is now. */
function livePart(doc: ProjectDoc | undefined, planId: string | undefined): PartDTO | undefined {
  const plan = planId === undefined ? undefined : doc?.plans[planId]
  return plan === undefined ? undefined : doc?.parts[plan.design.part.id]
}

/**
 * Decides once per ended run what to do with its marks, and marks a real `done` run's operations
 * when this window started it (real runs start in a window only, so one window marks). Mounted
 * with the run dialogs, in every mode.
 */
export function useRunCutMarks(doc: ProjectDoc | undefined): void {
  const store = useRunStore()
  const call = useCall()
  const lastRun = useRun((s) => s.status.lastRun)
  const running = useRun((s) => s.status.job !== undefined)
  const startedHere = useRun((s) => s.startedHere)
  const state = useRun((s) => s.cutMarks)
  useEffect(() => {
    if (running || lastRun === undefined || doc === undefined) return
    // decided once; a pending resume is decided again once it is gone (Dismiss)
    if (state?.jobId === lastRun.jobId && state.kind !== 'waiting') return
    const plan = lastRun.planId === undefined ? undefined : doc.plans[lastRun.planId]
    const live = livePart(doc, lastRun.planId)
    const r = runCutMarks(lastRun, plan, live)
    const jobId = lastRun.jobId
    if (r.kind === 'none') {
      const kind =
        r.reason === 'resumePending'
          ? 'waiting'
          : r.reason === 'changed' && lastRun.real === true
            ? 'changed'
            : 'none'
      if (state?.jobId !== jobId || state.kind !== kind)
        store.getState().setCutMarks({ jobId, kind })
      return
    }
    if (r.kind === 'offer' || live === undefined) {
      store.getState().setCutMarks({
        jobId,
        kind: 'offer',
        partId: live?.id ?? '',
        planId: r.planId,
        units: r.units,
      })
      return
    }
    // automatic only in the window that started the run (others say nothing)
    if (startedHere !== jobId) {
      store.getState().setCutMarks({ jobId, kind: 'none' })
      return
    }
    const update = runMarkUpdate(live, r.units)
    store.getState().setCutMarks({
      jobId,
      kind: 'marked',
      partId: live.id,
      units: r.units,
      ...(update.recut === undefined ? {} : { recut: update.recut }),
    })
    void call('design.part.update', {
      partId: live.id,
      ...update,
      cutByRun: r.planId,
    }).then((reply) => {
      if (!reply.ok) store.getState().setCutMarks({ jobId, kind: 'none' })
    })
  }, [call, doc, lastRun, running, startedHere, state, store])
}

/** Names of `units` in `part`, for the notice. */
function names(part: PartDTO | undefined, units: readonly string[]): string[] {
  return units.map((id) => (part === undefined ? id : itemName(part, id)))
}

/** The run section's notice of the last run's marks (none while a run streams). */
export function CutMarksNote({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element | null {
  const state = useRun((s) => s.cutMarks)
  const running = useRun((s) => s.status.job !== undefined)
  const lastJob = useRun((s) => s.status.lastRun?.jobId)
  if (running || state === undefined || state.jobId !== lastJob) return null
  return <CutMarksView state={state} part={partOf(doc, state)} />
}

function partOf(doc: ProjectDoc | undefined, state: CutMarksState): PartDTO | undefined {
  return 'partId' in state ? doc?.parts[state.partId] : undefined
}

/** The notice itself (exported for the component test). */
export function CutMarksView({
  state,
  part,
}: {
  state: CutMarksState
  part: PartDTO | undefined
}): React.JSX.Element | null {
  const store = useRunStore()
  const call = useCall()
  if (state.kind === 'changed')
    return (
      <div className={styles['notice']} role="status" aria-label={m.region}>
        <Icon name="info" />
        <div>
          <p className={styles['why']}>{m.changed}</p>
        </div>
      </div>
    )
  if (state.kind !== 'marked' && state.kind !== 'offer') return null
  const list = names(part, state.units)
  // C4: Undo takes back the ids the run added; a recut unit keeps its new mark (without any it
  // would be cut in full again), Design's Undo takes that back
  const recut = state.kind === 'marked' ? (state.recut ?? []) : []
  const without = (part?.alreadyCut ?? []).filter(
    (id) => !state.units.includes(id) || recut.includes(id),
  )
  if (state.kind === 'marked')
    return (
      <div className={styles['notice']} role="status" aria-label={m.region}>
        <Icon name={state.undone === true ? 'info' : 'success'} />
        <div>
          <p className={styles['why']}>
            {state.undone === true ? m.undone : m.marked(state.units.length)}
          </p>
          {state.undone === true ? null : (
            <>
              <p className={styles['hint']}>{list.join(', ')}</p>
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={part === undefined}
                  onClick={() => {
                    if (part === undefined) return
                    void call('design.part.update', { partId: part.id, alreadyCut: without })
                    store.getState().setCutMarks({ ...state, undone: true })
                  }}
                >
                  {m.undo}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  return (
    <div className={styles['notice']} role="group" aria-label={m.region}>
      <Icon name="info" />
      <div>
        <p className={styles['why']}>{m.offer(state.units.length)}</p>
        <ul className={styles['cutList']}>
          {list.map((name, i) => (
            <li key={state.units[i]}>{name}</li>
          ))}
        </ul>
        <p className={styles['hint']}>{m.offerHint}</p>
        <div className={styles['cutActions']}>
          <Button
            size="sm"
            variant="primary"
            icon={<Icon name="check" />}
            disabled={part === undefined}
            onClick={() => {
              if (part === undefined) return
              const update = runMarkUpdate(part, state.units)
              void call('design.part.update', {
                partId: part.id,
                ...update,
                cutByRun: state.planId,
              })
              store.getState().setCutMarks({
                jobId: state.jobId,
                kind: 'marked',
                partId: part.id,
                units: state.units,
                ...(update.recut === undefined ? {} : { recut: update.recut }),
              })
            }}
          >
            {m.mark}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => store.getState().setCutMarks({ jobId: state.jobId, kind: 'closed' })}
          >
            {m.notNow}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Q199 (cut-state.md#a-new-blank-q199): the pre-flight's offer when every operation of the setup
 * is already cut (the plan's design copy). Clear marks clears the part's marks in Design (one undo
 * step); a draft plan then follows at once (`project.apply`), a plan that is not a draft keeps
 * its copy (a snapshot) until it is rebuilt in Plan, and says so.
 */
export function AllCutOffer({
  doc,
  plan,
  setupName,
}: {
  doc: ProjectDoc
  plan: PlanDTO
  setupName: string
}): React.JSX.Element {
  const call = useCall()
  const live = doc.parts[plan.design.part.id]
  const marks = live?.alreadyCut?.length ?? 0
  const draft = plan.status === 'draft'
  const p = runMessages.preflight
  const clear = async () => {
    if (live !== undefined && marks > 0) {
      const r = await call('design.part.update', { partId: live.id, alreadyCut: [] })
      if (!r.ok) return
    }
    if (draft) await call('project.apply', {})
  }
  return (
    <div className={styles['notice']} role="group" aria-label={m.region}>
      <Icon name="info" />
      <div>
        <p className={styles['why']}>{p.allCut(setupName)}</p>
        {draft ? null : (
          <p className={styles['hint']}>
            {marks > 0
              ? p.allCutSnapshot(plan.name, planMessages.statuses[plan.status])
              : p.allCutCleared(plan.name)}
          </p>
        )}
        {draft || marks > 0 ? (
          <div className={styles['cutActions']}>
            <Button size="sm" icon={<Icon name="undo" />} onClick={() => void clear()}>
              {p.clearMarks}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
