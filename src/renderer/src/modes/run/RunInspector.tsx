// Run mode inspector (ui.md#app-shell: "In run mode: DRO, run progress, run controls"): the DRO,
// the run's progress (lines done/total, section label, elapsed), "Start run" (through the
// pre-flight dialog), the wait the run is at, how the last run ended, the overrides (M6) and
// "Reset (immediate)".
// Feed hold, resume and Stop live in the main toolbar (MachineToolbar).
// Doc: docs/conventions/ui.md#run-mode-safety-ui, #jobs-and-progress
import { useId } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import { runMessages } from '../../messages/run'
import { Icon, Button, PanelHeader, Progress } from '../../ui'
import { Dro } from './Dro'
import { OverridesSection } from './OverridesSection'
import { planRunInfo } from './plan-info'
import { pauseMessage } from './RunDialogs'
import { activeJob, isConnected, runGates } from './machine-state'
import { useRun, useRunStore, waitKey, type RunEnd } from './run-store'
import styles from './Run.module.css'

const m = runMessages.progress

export function RunInspector({ doc }: { doc: ProjectDoc }): React.JSX.Element {
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const progress = useRun((s) => s.progress)
  const ended = useRun((s) => s.ended)
  const jobId = useRun((s) => s.jobId)
  const pending = useRun((s) => s.pending)
  const setupChange = useRun((s) => s.setupChange)
  const startWhy = useId()
  const resetWhy = useId()
  const a = store.getState()

  const job = activeJob(status)
  const gates = runGates(status, { planChosen: planId !== undefined && planId in doc.plans })
  const wait = waitKey(status)
  const showProgress = job !== undefined || (jobId !== undefined && progress !== undefined)

  return (
    <>
      <PanelHeader title={runMessages.dro.title} />
      <div className={styles['panel']}>
        <Dro status={status} units={doc.unitSystem} />

        <section className={styles['section']} aria-label={m.title}>
          <h3 className={styles['sectionTitle']}>{m.title}</h3>
          {showProgress ? (
            <RunProgressView
              done={progress?.done ?? 0}
              total={progress?.total}
              label={progress?.label}
              elapsed={
                job?.elapsedSeconds ??
                (ended?.kind === 'done' ? ended.summary.elapsedSeconds : undefined)
              }
            />
          ) : null}
          {job === undefined && ended ? <EndNote ended={ended} /> : null}
          {job === undefined && !ended ? <p className={styles['hint']}>{m.idle}</p> : null}

          {wait !== undefined && job ? (
            <div className={styles['wait']} data-kind={job.phase}>
              <span>
                {job.phase === 'toolChange' && job.toolChange
                  ? m.waitingToolChange(job.toolChange.n, job.toolChange.name)
                  : m.waitingPause(pauseMessage(progress?.label))}
              </span>
              <Button size="sm" onClick={() => a.dismissWait(undefined)}>
                {m.openWait}
              </Button>
            </div>
          ) : null}

          {job === undefined && setupChange !== undefined && planId !== undefined ? (
            <SetupChangeNote doc={doc} planId={planId} setupId={setupChange} />
          ) : null}

          {job === undefined ? (
            <>
              <Button
                size="lg"
                variant="primary"
                icon={<Icon name="run" />}
                disabled={gates.start !== null || pending.includes('run.job.start')}
                {...(gates.start === null ? {} : { 'aria-describedby': startWhy })}
                onClick={() =>
                  // between setups, Start goes through the setup-change prompt (task E2)
                  setupChange === undefined ? a.setPreflightOpen(true) : a.setSetupChangeOpen(true)
                }
              >
                {m.startRun}
              </Button>
              {gates.start === null ? null : (
                <p id={startWhy} className={styles['why']}>
                  {gates.start}
                </p>
              )}
            </>
          ) : null}
        </section>

        {isConnected(status) ? (
          <OverridesSection status={status} onChange={(c) => void a.override(c)} />
        ) : null}

        {isConnected(status) ? (
          <section className={styles['section']} aria-label={runMessages.controls.reset}>
            <Button
              size="lg"
              variant="danger"
              icon={<Icon name="rotate-ccw" />}
              aria-describedby={resetWhy}
              onClick={() => void a.reset()}
            >
              {runMessages.controls.reset}
            </Button>
            <p id={resetWhy} className={styles['hint']}>
              {runMessages.controls.resetHint}
            </p>
          </section>
        ) : null}
      </div>
    </>
  )
}

/** Lines done/total, the section label and the elapsed time (ui.md#run-mode-safety-ui). */
export function RunProgressView({
  done,
  total,
  label,
  elapsed,
}: {
  done: number
  total: number | undefined
  label: string | undefined
  elapsed: number | undefined
}): React.JSX.Element {
  const text = total === undefined ? undefined : m.linesText(done, total)
  return (
    <div className={styles['progress']}>
      <Progress
        label={m.label}
        value={total === undefined ? null : done}
        max={total ?? 100}
        {...(text === undefined ? {} : { valueText: text })}
      />
      <div className={styles['progressLine']}>
        <span className={styles['mono']}>{total === undefined ? '' : m.lines(done, total)}</span>
        {elapsed === undefined ? null : (
          <span className={styles['mono']}>
            <span className={styles['srOnly']}>{m.elapsedLabel} </span>
            {m.elapsed(elapsed)}
          </span>
        )}
      </div>
      {label ? <p className={styles['sectionLabel']}>{label}</p> : null}
    </div>
  )
}

/** The setup change the run waits for between setups, with "Show instructions" (task E2). */
function SetupChangeNote({
  doc,
  planId,
  setupId,
}: {
  doc: ProjectDoc
  planId: string
  setupId: string
}): React.JSX.Element | null {
  const store = useRunStore()
  const plan = doc.plans[planId]
  if (plan === undefined) return null
  const info = planRunInfo(plan, setupId)
  const n = info.setups.findIndex((x) => x.id === info.setup.id) + 1
  return (
    <div className={styles['wait']} data-kind="setupChange">
      <span>{m.waitingSetupChange(n, info.setup.name)}</span>
      <Button size="sm" onClick={() => store.getState().setSetupChangeOpen(true)}>
        {m.openWait}
      </Button>
    </div>
  )
}

function EndNote({ ended }: { ended: RunEnd }): React.JSX.Element {
  const text =
    ended.kind === 'done'
      ? m.done(ended.summary.lines, m.elapsed(ended.summary.elapsedSeconds))
      : ended.kind === 'stopped'
        ? m.stopped
        : m.failed
  return (
    <p className={styles['endNote']} data-kind={ended.kind} role="status">
      {text}
    </p>
  )
}
