// Run dialogs, mounted with the machine toolbar so they work in every mode: the pre-flight dialog
// before every run, the tool-change and program-pause dialogs (dismissable to the inspector), the
// setup-change prompt between setups (SetupChangeDialog, task E2), and
// the blocking failure dialog; tool-change waits and alarms are announced assertively. Each
// carries its own Stop (RunDialogFooter), reachable by keyboard and screen readers while modal.
// Doc: docs/conventions/ui.md#confirmations, #run-mode-safety-ui
import { useId } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { planMessages } from '../../messages/plan'
import { runMessages } from '../../messages/run'
import { Icon, Button, Dialog, DialogClose, ErrorMessage } from '../../ui'
import { useReplica } from '../../shell/ShellContext'
import { JogPad, useJogMode } from './JogPad'
import { activeJob, formatLength, runGates } from './machine-state'
import { planRunInfo } from './plan-info'
import { useRun, useRunStore, waitKey } from './run-store'
import { WorkZeroButtons } from './RunNavigator'
import { AlarmPanel, inAlarm } from './AlarmPanel'
import { ProbeZButton, usePlateThickness } from './ProbeZButton'
import { RunDialogFooter } from './RunStop'
import { SetupChangeDialog } from './SetupChangeDialog'
import styles from './Run.module.css'

export function RunDialogs(): React.JSX.Element {
  const replica = useReplica()
  const doc = replica.status === 'open' ? replica.doc : undefined
  return (
    <>
      {doc ? <PreflightDialog doc={doc} /> : null}
      {doc ? <SetupChangeDialog doc={doc} /> : null}
      <WaitDialog doc={doc} />
      <FailureDialog />
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
  const m = runMessages.preflight
  const plan = planId === undefined ? undefined : doc.plans[planId]
  const info = plan ? planRunInfo(plan, setupId) : undefined
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
  const gate = runGates(status, { planChosen: plan !== undefined }).start ?? realGate
  const units = doc.unitSystem
  const a = store.getState()
  return (
    <Dialog
      open={open}
      onOpenChange={a.setPreflightOpen}
      title={m.title}
      description={m.description}
      footer={
        <RunDialogFooter>
          <DialogClose>
            <Button {...(gate === null ? {} : { autoFocus: true })}>{m.cancel}</Button>
          </DialogClose>
          <Button
            variant="primary"
            icon={<Icon name="run" />}
            disabled={gate !== null}
            {...(gate === null ? { autoFocus: true } : { 'aria-describedby': whyId })}
            onClick={() => void a.startRun(info?.setup.id)}
          >
            {serial ? m.startMachine : m.start}
          </Button>
        </RunDialogFooter>
      }
    >
      {serial ? (
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
        <dd>{m.softLimitsText}</dd>
      </dl>
      {gate === null ? null : (
        <p id={whyId} className={styles['why']}>
          {gate}
        </p>
      )}
    </Dialog>
  )
}

/** Tool change or program pause: instructions, jog and Z zero inside; Continue is the primary. */
function WaitDialog({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element | null {
  const units = doc?.unitSystem ?? 'mm'
  const plate = usePlateThickness(doc)
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const dismissed = useRun((s) => s.dismissedWait)
  const jogStep = useRun((s) => s.jogStep)
  const jogMode = useJogMode()
  const pending = useRun((s) => s.pending)
  const progress = useRun((s) => s.progress)
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
        <ol className={styles['steps']}>
          {m.steps(tc.name).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <JogPad
          {...jogMode}
          units={units}
          step={jogStep}
          onStep={a.setJogStep}
          onJog={(axis, mm, feed) => void a.jog(axis, mm, feed)}
          onCancel={() => void a.jogCancel()}
          disabledReason={gates.jog}
          reasonId={ids.jog}
        />
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
    />
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
function FailureDialog(): React.JSX.Element | null {
  const store = useRunStore()
  const ended = useRun((s) => s.ended)
  const open = useRun((s) => s.failureOpen)
  const status = useRun((s) => s.status)
  if (ended?.kind !== 'failed') return null
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
