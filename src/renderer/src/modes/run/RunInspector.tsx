// Run mode inspector (ui.md#app-shell: "In run mode: DRO, run progress, run controls"): the DRO,
// the run's progress (whose run it is (M7), lines done/total, section label, elapsed), "Start run"
// (through the pre-flight dialog) and "Resume from…" after a stopped or failed run (M5), the wait
// the run is at, how the last run ended, the overrides (M6) and "Reset (immediate)".
// Feed hold, resume and Stop live in the main toolbar (MachineToolbar). Without a project (DF80) the
// run section is the "Open a project to run a plan" empty state; the DRO, overrides and Reset stay.
// There, "Run gCode file…" and the recent files open an external gCode file, whose card and
// "Start run" then take the run section (DF93). Run and Overrides are `InspectorGroup`s (the
// inspectors' group header style, DF110 S6); Reset has no title, only the rule above it.
// DF129 RC6: the Position header's menu, "The machine lost power…" while idle (Q171).
// Doc: docs/modes/run.md#run-without-a-project-df80, #run-an-external-g-code-file-df93
// Doc: docs/conventions/ui.md#run-mode-safety-ui, #jobs-and-progress,
// docs/conventions/inspector-layout.md#group-header-style
import { useId, useRef, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import { runMessages } from '../../messages/run'
import {
  Icon,
  IconButton,
  Button,
  ConfirmDialog,
  EmptyState,
  InspectorGroup,
  Menu,
  PanelHeader,
  Progress,
} from '../../ui'
import { useShell } from '../../shell/ShellContext'
import { AlignmentPanel } from './AlignmentPanel'
import { Dro } from './Dro'
import { OverridesSection, useMachineOverrideLimits } from './OverridesSection'
import { canResume, planRunInfo } from './plan-info'
import { pauseMessage } from './RunDialogs'
import { RecoveryPanel } from './RecoveryPanel'
import { RunFileSection } from './RunFile'
import { activeJob, goToOpenGate, isConnected, runGates } from './machine-state'
import { useRun, useRunStore, useRunUnits, waitKey, type RunEnd } from './run-store'
import styles from './Run.module.css'

const m = runMessages.progress

/** The run section's empty-state icon: a program sheet with the run arrow in the accent. */
const RunIcon = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    <path data-accent="" d="M6.5 5.5v5l4-2.5z" />
  </svg>
)

/**
 * DF129 RC6 (Q171): the Position header's menu, "The machine lost power…" while connected, homed
 * and idle: confirmed, then the position counts as lost (home before moving). The dialog opens
 * once the menu has closed, as the jog section's Go to (RunNavigator's JogMenu).
 */
function PositionMenu({
  gate,
  onPowerLost,
}: {
  gate: string | null
  onPowerLost: () => void
}): React.JSX.Element {
  const r = runMessages.recovery
  const chosen = useRef(false)
  const [ask, setAsk] = useState(false)
  return (
    <>
      <Menu
        label={r.positionMenu}
        align="end"
        onCloseAutoFocus={(e) => {
          if (!chosen.current) return
          chosen.current = false
          e.preventDefault()
          setAsk(true)
        }}
        items={[
          {
            label: r.powerLostItem,
            description: r.powerLostItemHint,
            disabledReason: gate ?? undefined,
            onSelect: () => {
              chosen.current = true
            },
          },
        ]}
      >
        <IconButton label={r.positionMenu} icon={<Icon name="more" />} />
      </Menu>
      <ConfirmDialog
        open={ask}
        onOpenChange={setAsk}
        destructive={false}
        title={r.powerLostTitle}
        description={r.powerLostDescription}
        confirmLabel={r.powerLostConfirm}
        onConfirm={onPowerLost}
      />
    </>
  )
}

/** `doc` undefined: no project (DF80). */
export function RunInspector({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element {
  const { files } = useShell()
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const progress = useRun((s) => s.progress)
  const ended = useRun((s) => s.ended)
  const jobId = useRun((s) => s.jobId)
  const pending = useRun((s) => s.pending)
  const setupChange = useRun((s) => s.setupChange)
  const setupId = useRun((s) => s.setupId)
  const startedHere = useRun((s) => s.startedHere)
  const file = useRun((s) => s.file)
  const startWhy = useId()
  const idleId = useId()
  const resetWhy = useId()
  const a = store.getState()

  const job = activeJob(status)
  // DF93: a loaded gCode file is what Start runs
  const fileReady = file?.state === 'ready' && file.prepared.refusalCount === 0
  const gates = runGates(status, {
    planChosen:
      file !== undefined
        ? fileReady
        : doc !== undefined && planId !== undefined && planId in doc.plans,
  })
  const wait = waitKey(status)
  const repeatsConnect = gates.start === runMessages.why.notConnected
  const showProgress = job !== undefined || (jobId !== undefined && progress !== undefined)
  const plan = planId === undefined || doc === undefined ? undefined : doc.plans[planId]
  const units = useRunUnits(doc)
  const overrideMachine = useMachineOverrideLimits(doc)
  const resumable =
    file === undefined && setupChange === undefined && canResume(status.lastRun, plan, setupId)
  // DF129 RC5: an interrupted run's record replaces "Start run" with the recovery panel
  const recovering = status.lastRun?.interruption !== undefined && job === undefined
  const startable = !recovering && job === undefined && (file !== undefined || doc !== undefined)
  const powerLostOffered =
    !recovering &&
    job === undefined &&
    (ended?.kind === 'stopped' || ended?.kind === 'failed') &&
    isConnected(status)
  const powerWhy = useId()

  return (
    <>
      <PanelHeader
        title={runMessages.dro.title}
        actions={
          <PositionMenu
            gate={
              isConnected(status) && status.homed && job === undefined && status.state === 'Idle'
                ? null
                : runMessages.recovery.powerLostNotNow
            }
            onPowerLost={() => void a.recovery('powerLost')}
          />
        }
      />
      <div className={styles['panel']}>
        <Dro
          status={status}
          units={units}
          zero={{ gate: gates.workZero, onZero: (axis) => void a.setWorkZero([axis]) }}
          goTo={{ gate: goToOpenGate(status), onGoTo: a.openGoTo }}
        />
        {/* DF78 (Q107): the alignment step docked beside the DRO */}
        {doc === undefined ? null : <AlignmentPanel doc={doc} />}

        <InspectorGroup title={m.title}>
          {job?.plan ? (
            <p className={styles['runOf']}>
              {m.runOf(job.plan.planName, job.plan.setup, job.plan.setups, job.plan.setupName)}
              {startedHere === job.jobId ? null : (
                <span className={styles['hint']}> {m.startedElsewhere}</span>
              )}
            </p>
          ) : null}
          {/* the loaded file's card names it already */}
          {job?.file && job.file.path !== file?.path ? (
            <p className={styles['runOf']} title={job.file.path}>
              {runMessages.file.runOf(job.file.name)}
              {startedHere === job.jobId ? null : (
                <span className={styles['hint']}> {m.startedElsewhere}</span>
              )}
            </p>
          ) : null}
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
          {job === undefined && ended && !recovering ? <EndNote ended={ended} /> : null}
          {/* DF129 RC5: the recovery panel in place of "Start run" after an interrupted run */}
          {recovering ? <RecoveryPanel doc={doc} /> : null}
          {/* Q171: after a Stop or a failure, the machine's power may have gone unseen */}
          {powerLostOffered ? (
            <div className={styles['powerLost']}>
              <Button
                size="sm"
                variant="ghost"
                aria-describedby={powerWhy}
                onClick={() => void a.recovery('powerLost')}
              >
                {runMessages.recovery.powerLost}
              </Button>
              <p id={powerWhy} className={styles['hint']}>
                {runMessages.recovery.powerLostHint}
              </p>
            </div>
          ) : null}
          {job === undefined && doc === undefined && file === undefined ? (
            <EmptyState
              icon={RunIcon}
              title={m.noProject.title}
              description={m.noProject.description}
              headingLevel={4}
              action={{
                label: m.noProject.action,
                icon: <Icon name="open" />,
                onClick: () => void files.getState().open(),
              }}
            />
          ) : null}
          {doc === undefined ? <RunFileSection idle={job === undefined} /> : null}
          {job === undefined && !ended && (doc !== undefined || fileReady) ? (
            <p id={idleId} className={styles['hint']}>
              {m.idle}
            </p>
          ) : null}

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

          {file === undefined &&
          job === undefined &&
          setupChange !== undefined &&
          planId !== undefined &&
          doc ? (
            <SetupChangeNote doc={doc} planId={planId} setupId={setupChange} />
          ) : null}

          {startable ? (
            <>
              <Button
                size="lg"
                variant="primary"
                icon={<Icon name="run" />}
                disabled={gates.start !== null || pending.includes('run.job.start')}
                {...(gates.start === null
                  ? {}
                  : { 'aria-describedby': repeatsConnect && !ended ? idleId : startWhy })}
                onClick={() =>
                  // between setups, Start goes through the setup-change prompt (task E2)
                  setupChange === undefined || file !== undefined
                    ? a.setPreflightOpen(true)
                    : a.setSetupChangeOpen(true)
                }
              >
                {m.startRun}
              </Button>
              {resumable ? (
                <Button
                  size="lg"
                  icon={<Icon name="run" />}
                  disabled={gates.start !== null || pending.includes('run.job.start')}
                  {...(gates.start === null
                    ? {}
                    : { 'aria-describedby': repeatsConnect && !ended ? idleId : startWhy })}
                  onClick={() => a.openResume()}
                >
                  {m.resumeFrom}
                </Button>
              ) : null}
              {/* "Connect … first" shows once, in the navigator; "No run yet. Connect, …" says it
                  here (DF46) */}
              {gates.start === null || (repeatsConnect && !ended) ? null : (
                <p id={startWhy} className={styles['why']}>
                  {gates.start}
                </p>
              )}
            </>
          ) : null}
        </InspectorGroup>

        {isConnected(status) ? (
          <OverridesSection
            status={status}
            onChange={(c) => a.override(c)}
            machine={overrideMachine}
            units={units}
          />
        ) : null}

        {isConnected(status) ? (
          // no title: the button names it; the rule of a following group (DF110)
          <section className={styles['resetSection']} aria-label={runMessages.controls.reset}>
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
