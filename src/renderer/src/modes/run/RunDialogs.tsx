// Run dialogs, mounted with the machine toolbar so they work in every mode: the pre-flight dialog
// before every run, the tool-change and program-pause dialogs (dismissable to the inspector), the
// setup-change prompt between setups (SetupChangeDialog, task E2), and
// the blocking failure dialog; tool-change waits and alarms are announced assertively. Each
// carries its own Stop (RunDialogFooter), reachable by keyboard and screen readers while modal.
// Doc: docs/conventions/ui.md#confirmations, #run-mode-safety-ui
import { useEffect, useId, useMemo, useRef } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { planMessages } from '../../messages/plan'
import { runMessages } from '../../messages/run'
import { Icon, Button, Dialog, DialogClose, ErrorMessage, Select } from '../../ui'
import { useReplica, useShell } from '../../shell/ShellContext'
import type { Interruption } from '../../../../core/run/interruption'
import type { RunStatus } from '../../../../core/run/service'
import { reasonText } from './RecoveryPanel'
import { JogPad, useJogControls } from './JogPad'
import { activeJob, formatLength, runGates, surfaceName } from './machine-state'
import { canResume, planRunInfo, resumeChanges, resumePoints } from './plan-info'
import { useRun, useRunStore, waitKey, type PreflightCheck } from './run-store'
import { WorkZeroButtons } from './RunNavigator'
import { AlarmPanel, inAlarm } from './AlarmPanel'
import { ProbeZButton, usePlateThickness } from './ProbeZButton'
import { TouchOffButton } from './TouchOffButton'
import { RunDialogFooter } from './RunStop'
import { SetupChangeDialog } from './SetupChangeDialog'
import { GoToDialog } from './GoToDialog'
import { StartAtSection, usePreflightStart } from './StartAt'
import { FilePreflightDialog } from './RunFile'
import styles from './Run.module.css'

export function RunDialogs(): React.JSX.Element {
  const replica = useReplica()
  const doc = replica.status === 'open' ? replica.doc : undefined
  const store = useRunStore()
  const file = useRun((s) => s.file)
  const running = useRun((s) => activeJob(s.status) !== undefined)
  // DF93: a window with a file that opens a project shows the project; the file is dropped
  const hasDoc = doc !== undefined
  useEffect(() => {
    if (hasDoc && !running && store.getState().file !== undefined) store.getState().closeFile()
  }, [hasDoc, running, store])
  return (
    <>
      {file?.state === 'ready' ? (
        <FilePreflightDialog file={file} />
      ) : doc ? (
        <PreflightDialog doc={doc} />
      ) : null}
      {doc ? <SetupChangeDialog doc={doc} /> : null}
      <WaitDialog doc={doc} />
      <GoToDialog doc={doc} />
      <FailureDialog doc={doc} />
      <Announcer doc={doc} />
    </>
  )
}

function PreflightDialog({ doc }: { doc: ProjectDoc }): React.JSX.Element {
  const store = useRunStore()
  const open = useRun((s) => s.preflightOpen)
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const setupId = useRun((s) => s.setupId)
  const timeScale = status.connection.timeScale
  const whyId = useId()
  const resumeId = useId()
  const resumeFrom = useRun((s) => s.resumeFrom)
  const m = runMessages.preflight
  const plan = planId === undefined ? undefined : doc.plans[planId]
  const info = plan ? planRunInfo(plan, setupId) : undefined
  // resume mode (M5): the setup's operation starts, the stopped one preselected
  const points = plan !== undefined && resumeFrom !== undefined ? resumePoints(plan, setupId) : []
  const resume = points.length > 0
  const stoppedIn = status.lastRun?.planOperationId
  const from = points.find((x) => x.planOperationId === resumeFrom) ?? points[0]
  // DF85: the plan may have been edited (back to Settled design, fixed, finalized) since the stop
  const changes = useMemo(
    () => (resume && plan !== undefined ? resumeChanges(status.lastRun, plan, setupId) : undefined),
    [resume, plan, status.lastRun, setupId],
  )
  const settingsCheck = useRun((s) => s.settingsCheck)
  // a real machine: finalized plans and matching settings only (run-machine.md#pre-flight-on-a-real-machine)
  const serial = status.connection.target === 'serial'
  const realGate =
    !serial || plan === undefined
      ? null
      : plan.status !== 'finalized' && plan.status !== 'inUse'
        ? m.notFinalized
        : settingsCheck !== undefined && !settingsCheck.matches
          ? m.settingsMismatch
          : null
  const machineGate = runGates(status, { planChosen: plan !== undefined }).start ?? realGate
  const units = doc.unitSystem
  const a = store.getState()
  // the soft-limit result (DF46): checked on open and again when the work zero changes; with a
  // start line (DF129 RC3) over the lead-in and the rest, with the lead-in's preview
  const checkKey = `${planId ?? ''}|${info?.setup.id ?? ''}|${status.workZero.join(',')}`
  const setupToCheck = info?.setup.id
  const canCheck = open && plan !== undefined && machineGate === null
  const start = usePreflightStart(checkKey, setupToCheck, canCheck)
  const { current } = start
  const passed = current?.state === 'done' && current.findings.length === 0
  const gate =
    machineGate ??
    (current?.state === 'done' && current.findings.length > 0 ? m.softLimitsFix : null)
  const startable = gate === null && passed && start.ready
  // "Start run" takes the focus once the check passes, unless the user moved it (ui.md)
  const startRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const active = document.activeElement
    if (startable && (active === cancelRef.current || active === document.body))
      startRef.current?.focus()
  }, [startable])
  return (
    <Dialog
      open={open}
      onOpenChange={a.setPreflightOpen}
      title={resume ? m.resumeTitle : m.title}
      description={resume ? m.resumeDescription : m.description}
      footer={
        <RunDialogFooter>
          <DialogClose>
            <Button ref={cancelRef} {...(startable ? {} : { autoFocus: true })}>
              {m.cancel}
            </Button>
          </DialogClose>
          <Button
            ref={startRef}
            variant="primary"
            icon={<Icon name="run" />}
            disabled={!startable}
            {...(startable
              ? { autoFocus: true }
              : gate === null
                ? {}
                : { 'aria-describedby': whyId })}
            onClick={() =>
              void a.startRun(
                info?.setup.id,
                resume ? from?.planOperationId : undefined,
                resume ? undefined : start.at,
              )
            }
          >
            {resume
              ? serial
                ? m.resumeMachine
                : m.resume
              : start.at !== undefined
                ? serial
                  ? runMessages.startAt.startMachineAtLine(start.at.fromLine)
                  : runMessages.startAt.startAtLine(start.at.fromLine)
                : serial
                  ? m.startMachine
                  : m.start}
          </Button>
        </RunDialogFooter>
      }
    >
      {resume ? (
        <>
          <div className={styles['row']}>
            <label htmlFor={resumeId} className={styles['rowLabel']}>
              {m.resumeAt}
            </label>
            <Select
              id={resumeId}
              options={points.map((x) => {
                const label = m.resumePoint(x.label, x.tool, x.toolName)
                return {
                  value: x.planOperationId,
                  label: x.planOperationId === stoppedIn ? m.stoppedHere(label) : label,
                }
              })}
              {...(from === undefined ? {} : { value: from.planOperationId })}
              onValueChange={(v) => a.setResumeFrom(v)}
            />
          </div>
          {changes !== undefined && (changes.changed || changes.removed || changes.reordered) ? (
            <div className={styles['notice']} data-tone="warning" role="note">
              <Icon name="warning" />
              <div>
                {changes.changed ? <p className={styles['why']}>{m.planChanged}</p> : null}
                {changes.removed ? <p className={styles['why']}>{m.stoppedRemoved}</p> : null}
                {changes.reordered && !changes.removed ? (
                  <p className={styles['why']}>{m.reordered}</p>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className={styles['notice']} role="note">
            <Icon name="info" />
            <div>
              <p className={styles['why']}>{m.resumeNote}</p>
            </div>
          </div>
        </>
      ) : null}
      {resume ? null : <StartAtSection current={current} units={units} />}
      {serial && !resume ? (
        <div className={styles['notice']} role="note">
          <Icon name="info" />
          <div>
            <p className={styles['why']}>{m.airCut}</p>
          </div>
        </div>
      ) : null}
      <dl className={styles['facts']}>
        <dt>{m.plan}</dt>
        <dd>{info?.name ?? '–'}</dd>
        {serial && plan !== undefined ? (
          <>
            <dt>{m.planStatus}</dt>
            <dd>{planMessages.statuses[plan.status]}</dd>
          </>
        ) : null}
        {info !== undefined && info.setups.length > 1 ? (
          <>
            <dt>{m.setup}</dt>
            <dd>
              {m.setupOf(
                info.setup.name,
                info.setups.findIndex((x) => x.id === info.setup.id) + 1,
                info.setups.length,
              )}
            </dd>
          </>
        ) : null}
        <dt>{m.machine}</dt>
        <dd>{info?.machine ?? '–'}</dd>
        <dt>{m.target}</dt>
        <dd>
          {status.connection.target === 'serial' && status.connection.port !== undefined
            ? m.serialTarget(status.connection.port.path, status.connection.port.baud)
            : m.virtualTarget(runMessages.timeScale(timeScale))}
        </dd>
        <dt>{m.workZero}</dt>
        <dd className={styles['mono']}>
          {status.workZero.map((v) => formatLength(v, units)).join(' · ')}{' '}
          {runMessages.dro.units[units]}
        </dd>
        <dt>{m.tools}</dt>
        <dd>
          {info === undefined || info.tools.length === 0 ? (
            m.noTools
          ) : (
            <ol className={styles['tools']}>
              {info.tools.map((t, i) => (
                <li key={`${i}-${t}`}>{t}</li>
              ))}
            </ol>
          )}
        </dd>
        <dt>{m.softLimits}</dt>
        <dd aria-live="polite">
          <SoftLimitResult check={current} units={units} />
        </dd>
      </dl>
      {gate === null ? null : (
        <p id={whyId} className={styles['why']}>
          {gate}
        </p>
      )}
    </Dialog>
  )
}

/** The pre-flight's soft-limit row: checking, inside the travel, the findings, or the failure. */
export function SoftLimitResult({
  check,
  units,
}: {
  check: Exclude<PreflightCheck, { state: 'idle' }> | undefined
  units: ProjectDoc['unitSystem']
}): React.JSX.Element {
  const m = runMessages.preflight
  if (check === undefined || check.state === 'checking')
    return <span className={styles['hint']}>{m.softLimitsChecking}</span>
  if (check.state === 'failed')
    return (
      <>
        {m.softLimitsFailed} <ErrorMessage error={check.error} />
      </>
    )
  if (check.findings.length === 0) return <>{m.softLimitsOk}</>
  const len = (v: number | string | undefined) => formatLength(Number(v), units)
  return (
    <ul className={styles['findings']}>
      {check.findings.map((f, i) => (
        <li key={i}>
          {m.softLimitsAxis(
            String(f.params['axis'] ?? '').toUpperCase(),
            len(f.params['min']),
            len(f.params['max']),
            len(f.params['travel']),
            runMessages.dro.units[units],
          )}
        </li>
      ))}
    </ul>
  )
}

/** Tool change or program pause: instructions, jog and Z zero inside; Continue is the primary. */
function WaitDialog({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element | null {
  const units = doc?.unitSystem ?? 'mm'
  const plate = usePlateThickness(doc)
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const dismissed = useRun((s) => s.dismissedWait)
  const jog = useJogControls(doc)
  const pending = useRun((s) => s.pending)
  const progress = useRun((s) => s.progress)
  // DF129 RC3: this window's run started at a line: its lead-in's tool wait
  const leadIn = useRun((s) => s.startedLeadIn)
  const ids = { jog: useId(), zero: useId() }
  const key = waitKey(status)
  const job = activeJob(status)
  const a = store.getState()
  if (key === undefined || job === undefined) return null
  const open = dismissed !== key
  const later = () => a.dismissWait(key)
  const continuing = pending.includes('run.job.continue')
  const gates = runGates(status, { planChosen: true })

  if (job.phase === 'toolChange' && job.toolChange) {
    const tc = job.toolChange
    const m = runMessages.toolChange
    return (
      <Dialog
        open={open}
        onOpenChange={(o) => (o ? a.dismissWait(undefined) : later())}
        title={m.title(tc.n)}
        description={m.description(tc.name)}
        footer={
          <RunDialogFooter>
            <Button variant="ghost" onClick={later}>
              {m.later}
            </Button>
            <Button
              variant="primary"
              icon={<Icon name="run" />}
              disabled={continuing}
              onClick={() => void a.continueWait()}
            >
              {m.continue}
            </Button>
          </RunDialogFooter>
        }
      >
        {/* DF129 RC3 (Q167): the tool wait of a start at a line's lead-in */}
        {leadIn?.jobId === job.jobId && job.line <= leadIn.lines ? (
          <div className={styles['notice']} role="note">
            <Icon name="info" />
            <div>
              <p className={styles['why']}>{runMessages.startAt.waitNote}</p>
            </div>
          </div>
        ) : null}
        {/* DF132 H3: the clamp under the collet nut that decides the stickout (tool-holder.md#run-mode) */}
        {tc.stickoutReason === undefined ? null : (
          <div className={styles['notice']} role="note">
            <Icon name="info" />
            <div>
              <p className={styles['why']}>{m.stickoutReason(tc.stickoutReason)}</p>
            </div>
          </div>
        )}
        <ol className={styles['steps']}>
          {m.steps(tc.name, tc.surface, tc.spot).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <JogPad controls={jog} disabledReason={gates.jog} reasonId={ids.jog} />
        {/* DF69: back over the surface's touch-off spot after jogging away */}
        <TouchOffButton doc={doc} toolChange={tc} gate={gates.jog} reasonId={ids.jog} />
        <WorkZeroButtons
          only="z"
          gate={gates.workZero}
          reasonId={ids.zero}
          onZero={(axes) => void a.setWorkZero(axes)}
        />
        <ProbeZButton
          thickness={plate}
          gate={gates.workZero}
          reasonId={ids.zero}
          units={units}
          busy={pending.includes('run.machine.probeZ')}
          hint={false}
          {...(tc.surface === undefined ? {} : { surface: surfaceName(tc.surface) })}
          onProbe={(t) => void a.probeZ(t)}
        />
        {/* a probe that missed: the alarm and its unlock right here (the navigator is behind) */}
        {inAlarm(status) ? (
          <>
            <AlarmPanel status={status} />
            {status.alarm?.code === 4 || status.alarm?.code === 5 ? (
              <div className={styles['buttons']}>
                <Button size="lg" onClick={() => void a.unlock()}>
                  {runMessages.navigator.unlock}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </Dialog>
    )
  }

  const m = runMessages.pause
  const message = pauseMessage(progress?.label)
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? a.dismissWait(undefined) : later())}
      title={m.title(job.pause ?? 0)}
      description={m.description(message)}
      footer={
        <RunDialogFooter>
          {/* the safe first focus: neither Stop nor Continue (no single-key continue) */}
          <Button variant="ghost" autoFocus onClick={later}>
            {m.later}
          </Button>
          <Button
            variant="primary"
            icon={<Icon name="run" />}
            disabled={continuing}
            onClick={() => void a.continueWait()}
          >
            {m.continue}
          </Button>
        </RunDialogFooter>
      }
    >
      {/* the gCode term, for who wants it (DF46) */}
      <p className={styles['hint']}>{m.details}</p>
    </Dialog>
  )
}

/** The M0 message: the progress label while the run waits (docs/modes/run-v0.1.md#progress). */
export function pauseMessage(label: string | undefined): string {
  return label === undefined || label === '' ? runMessages.state.paused : label
}

/** Data of a `machine.*` failure: GRBL's code, the 1-based line and GRBL's message. */
function failureData(error: AppErrorData): { code?: number; line?: number; text?: string } {
  for (const f of error.frames) {
    const d = f.data as { code?: unknown; line?: unknown; text?: unknown } | undefined
    if (d && (typeof d.code === 'number' || typeof d.line === 'number'))
      return {
        ...(typeof d.code === 'number' ? { code: d.code } : {}),
        ...(typeof d.line === 'number' ? { line: d.line } : {}),
        ...(typeof d.text === 'string' ? { text: d.text } : {}),
      }
  }
  return {}
}

/** Blocking dialog for a failed run (ui.md#errors: `machine.*` during a run). */
function FailureDialog({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element | null {
  const store = useRunStore()
  const ended = useRun((s) => s.ended)
  const open = useRun((s) => s.failureOpen)
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const setupId = useRun((s) => s.setupId)
  if (ended?.kind !== 'failed') return null
  // DF129 RC5: an interrupted run gets the short sheet pointing to the recovery panel
  const interruption =
    status.lastRun?.jobId === ended.jobId ? status.lastRun.interruption : undefined
  if (interruption !== undefined)
    return (
      <InterruptedSheet
        open={open}
        onClose={() => store.getState().closeFailure()}
        interruption={interruption}
        status={status}
      />
    )
  const plan = planId === undefined ? undefined : doc?.plans[planId]
  // M5: resume after the cause is fixed (the pre-flight gates still apply)
  const resumable = canResume(status.lastRun, plan, setupId)
  const m = runMessages.failure
  const { error } = ended
  const data = failureData(error)
  const alarm = error.code === 'machine.alarm'
  // a real connection lost mid-run: the machine may still move (run-machine.md#lost-connection-m2)
  const lost = error.code === 'machine.connection' && status.connection.lost?.target === 'serial'
  const lostPosition = alarm || !status.homed
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) store.getState().closeFailure()
      }}
      title={alarm ? m.alarmTitle(data.code) : lost ? m.lostTitle : m.title}
      footer={
        <RunDialogFooter>
          {resumable ? (
            <Button
              onClick={() => {
                store.getState().closeFailure()
                store.getState().openResume()
              }}
            >
              {runMessages.progress.resumeFrom}
            </Button>
          ) : null}
          <DialogClose>
            <Button autoFocus>{m.close}</Button>
          </DialogClose>
        </RunDialogFooter>
      }
    >
      <div role="alert" className={styles['failure']}>
        {lost ? <p>{m.lostText}</p> : null}
        {data.text ? <p>{data.text}</p> : null}
        <ErrorMessage error={error} />
        {data.line === undefined ? null : <p>{m.line(data.line)}</p>}
        {error.code === 'machine.error' || alarm ? <p>{m.didHold}</p> : null}
        <p>{lost ? m.lostNext : lostPosition ? m.nextHome : m.nextCheck}</p>
      </div>
    </Dialog>
  )
}

/**
 * DF129 RC5: replaces the failure dialog of an interrupted run: what happened in one line, the
 * safety line while a real machine may still be moving, and "Show the steps" (Run mode, where the
 * recovery panel is). Calm: an info title, no error styling but the safety line.
 */
function InterruptedSheet({
  open,
  onClose,
  interruption,
  status,
}: {
  open: boolean
  onClose: () => void
  interruption: Interruption
  status: RunStatus
}): React.JSX.Element {
  const { ui } = useShell()
  const m = runMessages.recovery
  const mayMove = status.connection.state !== 'open' && status.connection.lost?.target === 'serial'
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
      title={m.title}
      description={m.sheetDescription}
      footer={
        <RunDialogFooter>
          <DialogClose>
            <Button variant="ghost">{m.later}</Button>
          </DialogClose>
          <Button
            variant="primary"
            icon={<Icon name="arrow-right" />}
            autoFocus
            onClick={() => {
              ui.getState().setMode('run')
              onClose()
            }}
          >
            {m.showSteps}
          </Button>
        </RunDialogFooter>
      }
    >
      <p className={styles['why']}>{reasonText(interruption)}</p>
      {mayMove ? (
        <div className={styles['notice']} data-tone="danger" role="alert">
          <Icon name="warning" />
          <div>
            <p className={styles['why']}>{runMessages.failure.lostText}</p>
          </div>
        </div>
      ) : null}
    </Dialog>
  )
}

/** Assertive announcements: tool-change and pause waits, alarms (ui.md#accessibility). */
function Announcer({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element {
  const status = useRun((s) => s.status)
  const progress = useRun((s) => s.progress)
  const setupChange = useRun((s) => s.setupChange)
  const planId = useRun((s) => s.planId)
  const job = activeJob(status)
  const plan = planId === undefined ? undefined : doc?.plans[planId]
  const next = setupChange !== undefined && plan ? planRunInfo(plan, setupChange) : undefined
  const text =
    job?.phase === 'toolChange' && job.toolChange
      ? runMessages.toolChange.announce(job.toolChange.n, job.toolChange.name)
      : job?.phase === 'programPause'
        ? runMessages.pause.announce(pauseMessage(progress?.label))
        : status.alarm
          ? `${runMessages.state.alarm(status.alarm.code)}. ${status.alarm.text}`
          : next !== undefined && job === undefined
            ? runMessages.setupChange.announce(
                next.setups.findIndex((x) => x.id === next.setup.id) + 1,
                next.setup.name,
              )
            : ''
  return (
    <div aria-live="assertive" className={styles['srOnly']}>
      {text}
    </div>
  )
}
