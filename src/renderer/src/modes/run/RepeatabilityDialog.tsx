// Homing repeatability (v0.5 RV8, Q224): the user fixes a target on the bed, jogs above it (the
// pad inside the dialog) and takes that position once; the test (`run.machine.repeatability`, a
// job) homes N times and probes the target after each; the spread per axis against 0.02 mm is kept
// with the date per library machine (app settings `homingRepeatability`). "Check for lost steps"
// probes once without homing against the test's means. Stop: the footer's Stop or "Stop test"
// (job.abort, a reset) at any time; a real machine's test is confirmed once.
// Doc: docs/modes/run-machine.md#homing-repeatability-rv8
import { useEffect, useId, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import {
  drift,
  REPEATABILITY_CYCLES,
  REPEATABILITY_PASS,
  type RepeatAxis,
  type TargetReading,
} from '../../../../core/run/homing-repeatability'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { RepeatabilityResult } from '../../../../shared/settings'
import { runMessages } from '../../messages/run'
import { useSettings, useShell } from '../../shell/ShellContext'
import {
  Button,
  ConfirmDialog,
  Dialog,
  ErrorMessage,
  Field,
  FieldInput,
  Icon,
  Progress,
} from '../../ui'
import { useLibraryItems } from '../plan/usePlan'
import { JogPad, useJogControls, useMachineJog } from './JogPad'
import { formatLength, isConnected, runGates } from './machine-state'
import { machineProbe } from './plan-info'
import { NO_PLAN, useRun, useRunStore, useRunUnits } from './run-store'
import { RunDialogFooter } from './RunStop'
import styles from './Run.module.css'

const m = runMessages.repeat
const AXES: readonly RepeatAxis[] = ['x', 'y', 'z']
/** A bit probing the corner: its Ø only offsets every reading alike (the spread is unchanged). */
const BIT_DIAMETER = 3

interface Outcome {
  readonly readings: TargetReading[]
  readonly axes: RepeatabilityResult['axes']
  readonly pass: boolean
  readonly worst: number
}

/** Mounted with the run dialogs; open while the run store's `repeatOpen` is set. */
export function RepeatabilityDialog({
  doc,
}: {
  doc: ProjectDoc | undefined
}): React.JSX.Element | null {
  const open = useRun((s) => s.repeatOpen)
  return open ? <RepeatabilityOpen doc={doc} /> : null
}

function RepeatabilityOpen({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element {
  const { bridge } = useShell()
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const machineId = useRun((s) => s.machineId)
  const units = useRunUnits(doc)
  const unit = runMessages.dro.units[units]
  const jog = useJogControls(doc)
  const key = useMachineJog(doc).key
  const machines = useLibraryItems('machine')
  const plan = planId === undefined || planId === NO_PLAN ? undefined : doc?.plans[planId]
  const probe = machineProbe(plan, machines, machineId)
  const results = useSettings((s) => s.settings.homingRepeatability)
  const update = useSettings((s) => s.update)
  const stored = key === undefined ? undefined : results[key]
  const [at, setAt] = useState<readonly [number, number, number] | undefined>(stored?.at)
  const [cyclesText, setCyclesText] = useState(String(REPEATABILITY_CYCLES))
  const [jobId, setJobId] = useState<string | undefined>(undefined)
  const [progress, setProgress] = useState<{ done: number; label?: string } | undefined>()
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const [stopped, setStopped] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [checked, setChecked] = useState<TargetReading | undefined>(undefined)
  const ids = { jog: useId(), why: useId() }
  const f = (mm: number) => formatLength(mm, units)

  const cycles = Number(cyclesText)
  const cyclesOk = Number.isInteger(cycles) && cycles >= 2 && cycles <= 20
  const connected = isConnected(status)
  const serial = connected && status.connection.target === 'serial'
  const gates = runGates(status, { planChosen: false })
  const busy = jobId !== undefined
  const why =
    key === undefined
      ? m.noMachine
      : !connected
        ? runMessages.why.notConnected
        : !status.homed
          ? m.homeFirst
          : status.spindle > 0
            ? m.spindleOn
            : status.state !== 'Idle' && !busy
              ? m.idleFirst
              : null

  // the job's cycle while it runs (progress ticks are polled, not pushed)
  useEffect(() => {
    if (jobId === undefined) return
    const timer = setInterval(() => {
      void bridge.call('job.get', { jobId }).then((r) => {
        const p = r.ok
          ? (r.value as { progress?: { done: number; label?: string } }).progress
          : undefined
        if (p !== undefined) setProgress(p)
      })
    }, 250)
    return () => clearInterval(timer)
  }, [bridge, jobId])

  const tipDiameter = probe.kind === 'zPlate' ? 0 : (probe.tipDiameter ?? BIT_DIAMETER)
  const probeArgs = {
    kind: probe.kind,
    tipDiameter,
    ...(probe.plateThickness === undefined ? {} : { plateThickness: probe.plateThickness }),
    ...(probe.wallOffset === undefined ? {} : { wallOffset: probe.wallOffset }),
  }

  const runJob = async (args: object): Promise<Outcome | undefined> => {
    setError(undefined)
    setStopped(false)
    const r = await bridge.call('run.machine.repeatability', args)
    if (!r.ok) {
      setError(r.error)
      return undefined
    }
    const id = (r.value as { jobId: string }).jobId
    setJobId(id)
    setProgress({ done: 0 })
    try {
      let w = await bridge.call('job.wait', { jobId: id, timeoutSeconds: 300 })
      while (w.ok && (w.value as { timedOut?: boolean }).timedOut === true)
        w = await bridge.call('job.wait', { jobId: id, timeoutSeconds: 300 })
      const outcome = w.ok
        ? (w.value as { outcome?: { ok: boolean; value?: unknown; error?: AppErrorData } }).outcome
        : undefined
      if (outcome?.ok === true) return outcome.value as Outcome
      if (outcome?.error !== undefined) {
        if (outcome.error.code === 'op.aborted' || outcome.error.code === 'machine.reset')
          setStopped(true)
        else setError(outcome.error)
      }
      return undefined
    } finally {
      setJobId(undefined)
      setProgress(undefined)
    }
  }

  const startTest = async () => {
    if (at === undefined || key === undefined) return
    setChecked(undefined)
    const r = await runJob({
      at,
      probe: probeArgs,
      cycles,
      ...(probe.plateSize === undefined ? {} : { plateSize: probe.plateSize }),
    })
    if (r === undefined) return
    const result: RepeatabilityResult = {
      date: new Date().toISOString(),
      at: [at[0], at[1], at[2]],
      probe: probe.kind,
      cycles,
      readings: r.readings,
      axes: r.axes,
      pass: r.pass,
    }
    update({ homingRepeatability: { [key]: result } })
  }
  const checkSteps = async () => {
    if (stored === undefined || key === undefined) return
    const r = await runJob({
      at: stored.at,
      probe: probeArgs,
      cycles: 1,
      home: false,
      ...(probe.plateSize === undefined ? {} : { plateSize: probe.plateSize }),
    })
    const reading = r?.readings[0]
    if (reading === undefined) return
    const means = Object.fromEntries(
      AXES.flatMap((a) => (stored.axes[a] === undefined ? [] : [[a, stored.axes[a].mean]])),
    )
    const d = drift(reading, means)
    setChecked(d)
    update({
      homingRepeatability: {
        [key]: { ...stored, check: { date: new Date().toISOString(), drift: d } },
      },
    })
  }
  const stop = () => {
    if (jobId !== undefined) void bridge.call('job.abort', { jobId })
  }
  const close = () => store.getState().setRepeatOpen(false)

  const shown = stored
  const date = (iso: string) => new Date(iso).toLocaleString()
  const driftShown = checked ?? stored?.check?.drift
  const driftBad = AXES.some((a) => Math.abs(driftShown?.[a] ?? 0) >= REPEATABILITY_PASS)
  const canStart = why === null && !busy && at !== undefined && cyclesOk

  return (
    <Dialog
      open
      placement="end"
      onOpenChange={(o) => (o || busy ? undefined : close())}
      title={m.title}
      description={m.description}
      hideDescription
      footer={
        <RunDialogFooter>
          {busy ? (
            <Button variant="danger" onClick={stop}>
              {m.stop}
            </Button>
          ) : (
            <Button onClick={close}>{m.close}</Button>
          )}
          <Button
            variant="primary"
            icon={<Icon name="home" />}
            disabled={!canStart}
            aria-describedby={ids.why}
            onClick={() => (serial ? setConfirm(true) : void startTest())}
          >
            {m.run}
          </Button>
        </RunDialogFooter>
      }
    >
      <div className={styles['xyZero']} data-repeatability="">
        <p className={styles['hint']}>{m.steps(m.target[probe.kind] ?? m.target['zPlate']!)}</p>
        <JogPad
          controls={jog}
          disabledReason={busy ? m.running(1, 1, 'probe') : gates.jog}
          reasonId={ids.jog}
        />
        <div className={styles['buttons']}>
          <Button
            size="sm"
            disabled={why !== null || busy}
            onClick={() => {
              const p = store.getState().status.mpos
              setAt([p[0], p[1], p[2]])
            }}
          >
            {m.useHere}
          </Button>
        </div>
        <p className={styles['hint']} data-start="">
          {at === undefined ? m.noStart : m.start(f(at[0]), f(at[1]), f(at[2]), unit)}
        </p>
        <Field
          label={m.cycles}
          messages={cyclesOk ? [] : [{ id: 'invalid', severity: 'error', text: '2 to 20' }]}
        >
          <FieldInput
            inputMode="numeric"
            value={cyclesText}
            disabled={busy}
            onChange={(e) => setCyclesText(e.target.value)}
          />
        </Field>
        {busy && progress !== undefined ? (
          <>
            <Progress
              label={m.progress}
              value={progress.done}
              max={cycles}
              valueText={m.running(
                Math.min(progress.done + 1, cycles),
                cycles,
                progress.label ?? 'home',
              )}
            />
            <p className={styles['hint']} role="status">
              {m.running(Math.min(progress.done + 1, cycles), cycles, progress.label ?? 'home')}
            </p>
          </>
        ) : null}
        <p id={ids.why} className={styles['why']} role="status">
          {stopped ? m.stopped : (why ?? '')}
        </p>
        {error === undefined ? null : <ErrorMessage error={error} />}
        {shown === undefined ? null : (
          <>
            <p className={styles['sectionLabel']}>{m.result}</p>
            <p className={styles['hint']}>{m.when(date(shown.date), shown.cycles)}</p>
            <table className={styles['settingsTable']} aria-label={m.result}>
              <thead>
                <tr>
                  <th scope="col">{m.columns.axis}</th>
                  <th scope="col">{m.columns.spread}</th>
                  <th scope="col">{m.columns.stdDev}</th>
                  <th scope="col">{m.columns.mean}</th>
                </tr>
              </thead>
              <tbody>
                {AXES.map((a) => {
                  const x = shown.axes[a]
                  return x === undefined ? null : (
                    <tr
                      key={a}
                      data-axis={a}
                      {...(x.spread >= REPEATABILITY_PASS ? { 'data-differs': '' } : {})}
                    >
                      <th scope="row">{a.toUpperCase()}</th>
                      <td className={styles['mono']}>{f(x.spread)}</td>
                      <td className={styles['mono']}>{f(x.stdDev)}</td>
                      <td className={styles['mono']}>{f(x.mean)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className={styles['hint']} data-pass={shown.pass ? 'pass' : 'fail'}>
              {(shown.pass ? m.pass : m.fail)(f(REPEATABILITY_PASS), unit)}
            </p>
            <p className={styles['hint']}>{m.checkHint}</p>
            <div className={styles['buttons']}>
              <Button size="sm" disabled={why !== null || busy} onClick={() => void checkSteps()}>
                {m.checkSteps}
              </Button>
            </div>
            {driftShown === undefined ? null : (
              <p className={styles['hint']} data-drift="">
                {m.drift}:{' '}
                {AXES.flatMap((a) =>
                  driftShown[a] === undefined
                    ? []
                    : [m.driftAxis(a.toUpperCase(), f(driftShown[a]), unit)],
                ).join(' · ')}
                {'. '}
                {driftBad ? m.driftBad : m.driftOk(f(REPEATABILITY_PASS), unit)}
              </p>
            )}
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={m.confirm.title}
        description={m.confirm.description(cycles)}
        confirmLabel={m.confirm.confirm}
        onConfirm={() => void startTest()}
      />
    </Dialog>
  )
}
