// Calibration cut (v0.5 RV9, Q221/Q222): a dimension test or a feed ladder generated in core for
// the open plan's setup at a spot on the stock top (`run.calibration.check`: the placement, the
// workholding guard and, connected and homed, the soft limits and the work area). The checked
// program is previewed in the Run viewport; Run (`run.calibration.start`) makes every run check and
// waits at its tool change. The cut is kept per library machine with the date (app settings
// `calibration`): its footprint keeps later cuts out, its readings or chosen step give the
// suggestions (`$10x=` lines to copy, the library tool Ø with Undo, a preset value to enter).
// Doc: docs/modes/run-calibration.md
import { useEffect, useId, useMemo, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import {
  dimensionSuggestions,
  ladderSuggestion,
  type CalibrationSuggestion,
  type CalibrationTest,
  type DimensionReadings,
} from '../../../../core/run/calibration'
import { Quantity } from '../../../../core/quantity/quantity'
import type { LibraryItemDTO } from '../../../../core/library/library-item'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { CalibrationRecord } from '../../../../shared/settings'
import { commandInput, itemValues, type ToolDraft } from '../../library/form'
import { formatDuration } from '../../messages/plan'
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
  SegmentedControl,
  Select,
} from '../../ui'
import { useMachineJog } from './JogPad'
import { isConnected, runGates } from './machine-state'
import { useControllerSettings } from './MachineSettingsGroup'
import { NO_PLAN, useRun, useRunStore, useRunUnits } from './run-store'
import { RunDialogFooter } from './RunStop'
import styles from './Run.module.css'

const m = runMessages.calibration
const MM_PER_INCH = 25.4
const READINGS = ['pocketX', 'pocketY', 'bossX', 'bossY', 'slot', 'depth'] as const
type ReadingKey = (typeof READINGS)[number]

interface Range2 {
  readonly x: readonly [number, number]
  readonly y: readonly [number, number]
}

/** What `run.calibration.check` answers. */
interface Checked {
  readonly setupId: string
  readonly at: readonly [number, number]
  readonly toolId: string
  readonly tools: readonly { id: string; name: string; diameter: number }[]
  readonly footprint: Range2
  readonly depth: number
  readonly steps?: readonly { n: number; factor: number; feed: number; stepdown: number }[]
  readonly vary?: 'feed' | 'stepdown'
  readonly lines: readonly string[]
  readonly seconds: number
  readonly problems: readonly { rule: string; message: string; ref?: string }[]
  readonly findings: readonly unknown[]
  readonly travelChecked: boolean
}

/** Mounted with the run dialogs; open while the run store's `calibrationOpen` is set. */
export function CalibrationDialog({
  doc,
}: {
  doc: ProjectDoc | undefined
}): React.JSX.Element | null {
  const open = useRun((s) => s.calibrationOpen)
  const planId = useRun((s) => s.planId)
  return open && doc !== undefined && planId !== undefined && planId !== NO_PLAN ? (
    <CalibrationOpen doc={doc} planId={planId} />
  ) : null
}

function CalibrationOpen({ doc, planId }: { doc: ProjectDoc; planId: string }): React.JSX.Element {
  const { bridge } = useShell()
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const setupId = useRun((s) => s.setupId)
  const units = useRunUnits(doc)
  const unit = runMessages.dro.units[units]
  const key = useMachineJog(doc).key
  const controller = useControllerSettings()
  const all = useSettings((s) => s.settings.calibration)
  const update = useSettings((s) => s.update)
  const records = useMemo(() => (key === undefined ? [] : (all[key] ?? [])), [all, key])
  const ids = { why: useId() }
  const toUnit = (mm: number) => (units === 'inch' ? mm / MM_PER_INCH : mm)
  const toMm = (v: number) => (units === 'inch' ? v * MM_PER_INCH : v)
  const short = (mm: number) => String(Number(toUnit(mm).toFixed(units === 'inch' ? 4 : 2)))

  const [test, setTest] = useState<CalibrationTest>('dimension')
  const [toolId, setToolId] = useState<string | undefined>(undefined)
  const [spot, setSpot] = useState<{ x: string; y: string } | undefined>(undefined)
  const [sizeText, setSizeText] = useState('')
  const [depthText, setDepthText] = useState('')
  const [vary, setVary] = useState<'feed' | 'stepdown'>('feed')
  const [spreadText, setSpreadText] = useState('30')
  const [stepsText, setStepsText] = useState('5')
  const [checked, setChecked] = useState<Checked | undefined>(undefined)
  const [checkError, setCheckError] = useState<AppErrorData | undefined>(undefined)
  const [jobId, setJobId] = useState<string | undefined>(undefined)
  const [progress, setProgress] = useState<{ done: number; total?: number } | undefined>()
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const [stopped, setStopped] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const busy = jobId !== undefined

  const num = (t: string): number | undefined => {
    if (t.trim() === '') return undefined
    const v = Number(t)
    return Number.isFinite(v) ? v : Number.NaN
  }
  const size = num(sizeText)
  const depth = num(depthText)
  const spread = num(spreadText)
  const steps = num(stepsText)
  const atX = spot === undefined ? undefined : num(spot.x)
  const atY = spot === undefined ? undefined : num(spot.y)
  const bad = [size, depth, spread, steps, atX, atY].some((v) => Number.isNaN(v))
  const earlier = records.filter((r) => r.planId === planId).map((r) => r.footprint)

  const args = useMemo(
    () => ({
      planId,
      ...(setupId === undefined ? {} : { setupId }),
      ...(toolId === undefined ? {} : { toolId }),
      test,
      ...(atX === undefined || atY === undefined ? {} : { at: [toMm(atX), toMm(atY)] }),
      ...(test === 'dimension'
        ? {
            ...(size === undefined ? {} : { size: toMm(size) }),
          }
        : {
            vary,
            ...(spread === undefined ? {} : { spread }),
            ...(steps === undefined ? {} : { steps }),
          }),
      ...(depth === undefined ? {} : { depth: toMm(depth) }),
      ...(earlier.length === 0 ? {} : { avoid: earlier }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the numbers stand for their texts
    [planId, setupId, toolId, test, atX, atY, size, depth, vary, spread, steps, records, units],
  )
  const homed = isConnected(status) && status.homed
  // the check again on every change of the arguments, and once homed (the travel findings)
  useEffect(() => {
    if (bad || busy) return
    let live = true
    const timer = setTimeout(() => {
      void bridge.call('run.calibration.check', args).then((r) => {
        if (!live) return
        if (!r.ok) {
          setCheckError(r.error)
          setChecked(undefined)
          store.getState().setCalibrationPreview(undefined)
          return
        }
        const c = r.value as Checked
        setCheckError(undefined)
        setChecked(c)
        store.getState().setCalibrationPreview(c.lines)
        // a suggested spot fills the fields (the user moves it from there)
        if (!('at' in args)) setSpot({ x: short(c.at[0]), y: short(c.at[1]) })
      })
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- short() follows units, in args
  }, [bridge, args, bad, busy, homed, store])
  useEffect(() => () => store.getState().setCalibrationPreview(undefined), [store])

  // the job's line while it runs (progress ticks are polled, as the repeatability test's)
  useEffect(() => {
    if (jobId === undefined) return
    const timer = setInterval(() => {
      void bridge.call('job.get', { jobId }).then((r) => {
        const p = r.ok
          ? (r.value as { progress?: { done: number; total?: number } }).progress
          : undefined
        if (p !== undefined) setProgress(p)
      })
    }, 250)
    return () => clearInterval(timer)
  }, [bridge, jobId])

  const connected = isConnected(status)
  const serial = connected && status.connection.target === 'serial'
  const gates = runGates(status, { planChosen: true })
  const tool = checked?.tools.find((t) => t.id === checked.toolId)
  const why =
    key === undefined
      ? m.noMachine
      : bad
        ? m.invalid
        : !connected
          ? runMessages.why.notConnected
          : !status.homed
            ? m.homeFirst
            : (gates.start ??
              (checked === undefined ||
              checked.problems.length > 0 ||
              checked.findings.length > 0 ||
              !checked.travelChecked
                ? m.fixFirst
                : null))
  const canRun = why === null && !busy && checked !== undefined

  const run = async () => {
    if (checked === undefined || key === undefined || tool === undefined) return
    setError(undefined)
    setStopped(false)
    const startArgs = { ...args, toolId: checked.toolId, at: [...checked.at] }
    const r = await bridge.call('run.calibration.start', startArgs)
    if (!r.ok) {
      setError(r.error)
      return
    }
    const id = (r.value as { jobId: string }).jobId
    setJobId(id)
    setProgress({ done: 0, total: checked.lines.length })
    try {
      let w = await bridge.call('job.wait', { jobId: id, timeoutSeconds: 300 })
      while (w.ok && (w.value as { timedOut?: boolean }).timedOut === true)
        w = await bridge.call('job.wait', { jobId: id, timeoutSeconds: 300 })
      const outcome = w.ok
        ? (w.value as { outcome?: { ok: boolean; value?: unknown; error?: AppErrorData } }).outcome
        : undefined
      if (outcome?.ok === true) {
        const record: CalibrationRecord = {
          date: new Date().toISOString(),
          test,
          tool: { name: tool.name, diameter: tool.diameter },
          planId,
          setupId: checked.setupId,
          footprint: {
            x: [checked.footprint.x[0], checked.footprint.x[1]],
            y: [checked.footprint.y[0], checked.footprint.y[1]],
          },
          depth: checked.depth,
          ...(test === 'dimension' ? { size: size === undefined ? 15 : toMm(size) } : {}),
          ...(checked.vary === undefined ? {} : { vary: checked.vary }),
          ...(checked.steps === undefined ? {} : { steps: checked.steps.map((s) => ({ ...s })) }),
        }
        update({ calibration: { [key]: [...records, record].slice(-50) } })
        // the next cut goes elsewhere: suggest a new spot
        setSpot(undefined)
      } else if (outcome?.error !== undefined) {
        if (outcome.error.code === 'op.aborted' || outcome.error.code === 'machine.reset')
          setStopped(true)
        else setError(outcome.error)
      }
    } finally {
      setJobId(undefined)
      setProgress(undefined)
    }
  }
  const job = status.job
  const waiting =
    busy && job?.jobId === jobId && (job.phase === 'toolChange' || job.phase === 'programPause')
  const continueJob = () => {
    if (job === undefined || jobId === undefined) return
    void bridge.call(
      'run.job.continue',
      job.phase === 'toolChange'
        ? { jobId, toolChange: job.toolChange?.n }
        : { jobId, pause: job.pause },
    )
  }
  const stop = () => {
    if (jobId !== undefined) void bridge.call('job.abort', { jobId })
  }
  const close = () => store.getState().setCalibrationOpen(false)
  const last = [...records].reverse().find((r) => r.test === test)
  const sizeHint = test === 'dimension' ? '15' : ''

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
            icon={<Icon name="play" />}
            disabled={!canRun}
            aria-describedby={ids.why}
            onClick={() => (serial ? setConfirm(true) : void run())}
          >
            {m.run}
          </Button>
        </RunDialogFooter>
      }
    >
      <div className={styles['xyZero']} data-calibration="">
        <SegmentedControl
          label={m.test}
          options={(['dimension', 'feedLadder'] as const).map((v) => ({
            value: v,
            label: m.tests[v],
          }))}
          value={test}
          disabled={busy}
          onValueChange={(v) => {
            setTest(v)
            setSpot(undefined)
          }}
        />
        <p className={styles['hint']}>{m.testHint[test]}</p>
        {checked !== undefined && checked.tools.length > 1 ? (
          <Field label={m.tool}>
            <Select
              options={checked.tools.map((t) => ({ value: t.id, label: t.name }))}
              value={checked.toolId}
              disabled={busy}
              onValueChange={(v) => {
                setToolId(v)
                setSpot(undefined)
              }}
            />
          </Field>
        ) : tool === undefined ? null : (
          <p className={styles['hint']}>
            {m.tool}: {tool.name}
          </p>
        )}
        <div className={styles['buttons']}>
          <NumberField
            label={`${m.spotX} (${unit})`}
            value={spot?.x ?? ''}
            disabled={busy}
            onChange={(x) => setSpot({ x, y: spot?.y ?? '' })}
          />
          <NumberField
            label={`${m.spotY} (${unit})`}
            value={spot?.y ?? ''}
            disabled={busy}
            onChange={(y) => setSpot({ x: spot?.x ?? '', y })}
          />
        </div>
        <div className={styles['buttons']}>
          <Button size="sm" disabled={busy} onClick={() => setSpot(undefined)}>
            {m.suggestSpot}
          </Button>
        </div>
        <div className={styles['buttons']}>
          {test === 'dimension' ? (
            <NumberField
              label={`${m.size} (${unit})`}
              value={sizeText}
              placeholder={sizeHint}
              disabled={busy}
              onChange={setSizeText}
            />
          ) : (
            <>
              <NumberField
                label={m.spread}
                value={spreadText}
                disabled={busy}
                onChange={setSpreadText}
              />
              <NumberField
                label={m.steps}
                value={stepsText}
                disabled={busy}
                onChange={setStepsText}
              />
            </>
          )}
          <NumberField
            label={`${m.depth} (${unit})`}
            value={depthText}
            placeholder={checked === undefined ? '' : short(checked.depth)}
            disabled={busy}
            onChange={setDepthText}
          />
        </div>
        {test === 'feedLadder' ? (
          <SegmentedControl
            label={m.vary}
            size="sm"
            options={(['feed', 'stepdown'] as const).map((v) => ({ value: v, label: m.varies[v] }))}
            value={vary}
            disabled={busy}
            onValueChange={setVary}
          />
        ) : null}
        {checked === undefined ? null : (
          <div data-check="">
            <p className={styles['hint']}>
              {m.program(checked.lines.length, formatDuration(checked.seconds))} {m.previewed}
            </p>
            {checked.problems.map((p, i) => (
              <p key={i} className={styles['why']} data-problem={p.rule}>
                {p.rule === 'operation'
                  ? m.problems.operation(p.message)
                  : p.rule === 'workholding'
                    ? p.message
                    : (m.problems[p.rule as 'outsideStock' | 'earlierCut'] ?? p.message)}
              </p>
            ))}
            {checked.findings.length > 0 ? (
              <p className={styles['why']} data-problem="travel">
                {m.finding}
              </p>
            ) : null}
            {checked.travelChecked ? null : <p className={styles['hint']}>{m.travelNotChecked}</p>}
          </div>
        )}
        {checkError === undefined ? null : <ErrorMessage error={checkError} />}
        {busy && progress !== undefined ? (
          <>
            <Progress
              label={m.progress}
              value={progress.done}
              max={progress.total ?? checked?.lines.length ?? 1}
              valueText={m.running(progress.done, progress.total ?? 0)}
            />
            {waiting ? (
              <div className={styles['buttons']}>
                <p className={styles['hint']} role="status">
                  {job?.phase === 'toolChange' ? m.waitTool : m.waitPause}
                </p>
                <Button size="sm" onClick={continueJob}>
                  {m.continue}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
        <p id={ids.why} className={styles['why']} role="status">
          {stopped ? m.stopped : (why ?? '')}
        </p>
        {error === undefined ? null : <ErrorMessage error={error} />}
        {last === undefined || key === undefined ? (
          <p className={styles['hint']}>{m.none}</p>
        ) : (
          <Results
            key={last.date}
            record={last}
            index={records.lastIndexOf(last)}
            records={records}
            machineKey={key}
            units={units}
            controller={controller}
            toolLibraryId={libraryToolId(doc, planId, last, checked)}
            onSave={(r) => update({ calibration: { [key]: r } })}
          />
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={m.confirm.title}
        description={m.confirm.description}
        confirmLabel={m.confirm.confirm}
        onConfirm={() => void run()}
      />
    </Dialog>
  )
}

/** The library tool of the cut's tool copy (by name among the plan's tool snapshots). */
function libraryToolId(
  doc: ProjectDoc,
  planId: string,
  record: CalibrationRecord,
  checked: Checked | undefined,
): string | undefined {
  const plan = doc.plans[planId]
  const copy = checked?.tools.find((t) => t.name === record.tool.name)
  const snap = plan?.snapshots.find(
    (s) => s.kind === 'tool' && (s.id === copy?.id || s.values.name === record.tool.name),
  )
  return snap?.libraryItemId
}

function NumberField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  placeholder?: string
}): React.JSX.Element {
  const ok = value.trim() === '' || Number.isFinite(Number(value))
  return (
    <Field
      label={label}
      messages={ok ? [] : [{ id: 'invalid', severity: 'error', text: m.invalid }]}
    >
      <FieldInput
        inputMode="decimal"
        value={value}
        disabled={disabled}
        {...(placeholder === undefined || placeholder === '' ? {} : { placeholder })}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  )
}

/** The last cut of the test: what to measure or pick, the suggestions, Save. */
function Results({
  record,
  index,
  records,
  units,
  controller,
  toolLibraryId,
  onSave,
}: {
  record: CalibrationRecord
  index: number
  records: readonly CalibrationRecord[]
  machineKey: string
  units: 'mm' | 'inch'
  controller: Readonly<Record<string, number>> | undefined
  toolLibraryId: string | undefined
  onSave: (records: CalibrationRecord[]) => void
}): React.JSX.Element {
  const { bridge } = useShell()
  const unit = runMessages.dro.units[units]
  const toUnit = (mm: number) => (units === 'inch' ? mm / MM_PER_INCH : mm)
  const toMm = (v: number) => (units === 'inch' ? v * MM_PER_INCH : v)
  const short = (mm: number) => String(Number(toUnit(mm).toFixed(units === 'inch' ? 4 : 3)))
  const [texts, setTexts] = useState<Partial<Record<ReadingKey, string>>>(
    () =>
      Object.fromEntries(
        Object.entries(record.readings ?? {}).map(([k, v]) => [k, short(v)]),
      ) as Partial<Record<ReadingKey, string>>,
  )
  const [step, setStep] = useState<number | undefined>(record.step)
  const [announce, setAnnounce] = useState('')
  const [applied, setApplied] = useState<{ before: string; after: number } | undefined>()
  const [applyError, setApplyError] = useState<AppErrorData | undefined>(undefined)

  const readings: DimensionReadings = Object.fromEntries(
    READINGS.flatMap((k) => {
      const t = texts[k]
      const v = t === undefined || t.trim() === '' ? Number.NaN : Number(t)
      return Number.isFinite(v) && v > 0 ? [[k, toMm(v)]] : []
    }),
  )
  const suggestions: CalibrationSuggestion[] =
    record.test === 'dimension' && Object.keys(readings).length > 0
      ? dimensionSuggestions(
          { size: record.size ?? 15, depth: record.depth, diameter: record.tool.diameter },
          readings,
          {
            ...(controller?.['100'] === undefined ? {} : { x: controller['100'] }),
            ...(controller?.['101'] === undefined ? {} : { y: controller['101'] }),
          },
        )
      : []
  const ladder =
    record.test === 'feedLadder' && step !== undefined
      ? ladderSuggestion(
          {
            ...(record.steps === undefined ? {} : { steps: record.steps }),
            ...(record.vary === undefined ? {} : { vary: record.vary }),
          },
          step,
        )
      : undefined

  const lengthText = (mm: number) => short(mm)
  const textOf = (s: CalibrationSuggestion): string => {
    switch (s.kind) {
      case 'ok':
        return m.suggest.ok
      case 'toolDiameter':
        return m.suggest.toolDiameter(lengthText(s.diameter), lengthText(s.delta), unit)
      case 'stepsPerMm':
        return m.suggest.stepsPerMm(s.axis.toUpperCase(), (s.scale * 100).toFixed(2))
      case 'backlash':
        return m.suggest.backlash(s.axis.toUpperCase(), lengthText(s.difference), unit)
      case 'depth':
        return m.suggest.depth(lengthText(s.error), unit)
    }
  }
  const ladderText =
    ladder === undefined
      ? undefined
      : m.suggest.ladder(
          m.varies[ladder.vary].toLowerCase(),
          ladder.vary === 'feed'
            ? `${Math.round(units === 'inch' ? ladder.value / MM_PER_INCH : ladder.value)} ${unit}/min`
            : `${short(ladder.value)} ${unit}`,
          ladder.percent,
        )
  const summary = [...suggestions.map(textOf), ...(ladderText === undefined ? [] : [ladderText])]
    .join(' ')
    .slice(0, 500)

  const save = () => {
    const next = [...records]
    next[index] = {
      ...record,
      ...(record.test === 'dimension' ? { readings: { ...readings } } : {}),
      ...(step === undefined ? {} : { step }),
      ...(summary === '' ? {} : { summary }),
    }
    onSave(next)
    setAnnounce(m.saved)
  }
  const copy = (line: string) =>
    void (navigator.clipboard?.writeText(line) ?? Promise.reject(new Error('no clipboard')))
      .then(() => setAnnounce(m.copied(line)))
      .catch(() => setAnnounce(line))

  /** Writes the library tool's Ø (`library.tool.update`, the item's current revision). */
  const writeDiameter = async (source: string): Promise<string | undefined> => {
    if (toolLibraryId === undefined) return undefined
    const got = await bridge.call('library.tool.get', { id: toolLibraryId })
    if (!got.ok) {
      setApplyError(got.error)
      return undefined
    }
    const item = got.value as LibraryItemDTO
    const values = itemValues(item) as ToolDraft
    const parsed = Quantity.parse(source, { kind: 'length', defaultUnit: 'mm' })
    if (parsed.isErr()) return undefined
    const input = commandInput(
      { ...values, diameter: parsed.unwrap().toDTO() as ToolDraft['diameter'] },
      { units, base: item },
    )
    const r = await bridge.call('library.tool.update', {
      ...input,
      id: item.id,
      revision: item.revision,
    })
    if (!r.ok) {
      setApplyError(r.error)
      return undefined
    }
    setApplyError(undefined)
    return values.diameter.source.includes(' ')
      ? values.diameter.source
      : `${values.diameter.source} ${values.diameter.defaultUnit}`
  }
  const apply = async (diameter: number) => {
    const before = await writeDiameter(`${diameter.toFixed(3)} mm`)
    if (before === undefined) return
    setApplied({ before, after: diameter })
    setAnnounce(m.applied(short(diameter), unit))
  }
  const undo = async () => {
    if (applied === undefined) return
    if ((await writeDiameter(applied.before)) === undefined) return
    setApplied(undefined)
    setAnnounce(m.undone)
  }

  return (
    <div data-results="">
      <p className={styles['sectionLabel']}>{m.readings}</p>
      <p className={styles['hint']}>
        {m.last(new Date(record.date).toLocaleString(), record.tool.name)}
      </p>
      {record.test === 'dimension' ? (
        <>
          <p className={styles['hint']}>
            {m.nominal(short(record.size ?? 15), short(record.depth), unit)}
          </p>
          <div className={styles['buttons']}>
            {READINGS.map((k) => (
              <NumberField
                key={k}
                label={`${m.reading[k]} (${unit})`}
                value={texts[k] ?? ''}
                onChange={(v) => setTexts({ ...texts, [k]: v })}
              />
            ))}
          </div>
        </>
      ) : (
        <Field label={m.pick}>
          <Select
            options={(record.steps ?? []).map((s) => ({
              value: String(s.n),
              label: m.stepLabel(
                s.n,
                record.vary === 'stepdown'
                  ? `${short(s.stepdown)} ${unit}`
                  : `${Math.round(units === 'inch' ? s.feed / MM_PER_INCH : s.feed)} ${unit}/min`,
                Math.round((s.factor - 1) * 100),
              ),
            }))}
            {...(step === undefined ? {} : { value: String(step) })}
            placeholder={m.pick}
            onValueChange={(v) => setStep(Number(v))}
          />
        </Field>
      )}
      {suggestions.length > 0 || ladderText !== undefined ? (
        <div data-suggestions="">
          <p className={styles['sectionLabel']}>{m.suggestions}</p>
          {suggestions.map((s, i) => (
            <div key={i} data-suggestion={s.kind}>
              <p className={styles['hint']}>{textOf(s)}</p>
              {s.kind === 'stepsPerMm' ? (
                s.line === undefined ? (
                  <p className={styles['hint']}>{m.suggest.stepsNoLine}</p>
                ) : (
                  <div className={styles['buttons']}>
                    <code className={styles['mono']}>{s.line}</code>
                    <Button size="sm" onClick={() => copy(s.line!)}>
                      {m.copy}
                    </Button>
                  </div>
                )
              ) : null}
              {s.kind === 'toolDiameter' ? (
                toolLibraryId === undefined ? (
                  <p className={styles['hint']}>{m.noLibraryTool}</p>
                ) : (
                  <div className={styles['buttons']}>
                    {applied === undefined ? (
                      <Button size="sm" onClick={() => void apply(s.diameter)}>
                        {m.applyDiameter(short(s.diameter), unit)}
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => void undo()}>
                        {m.undo}
                      </Button>
                    )}
                  </div>
                )
              ) : null}
            </div>
          ))}
          {ladderText === undefined ? null : (
            <div data-suggestion="ladder">
              <p className={styles['hint']}>{ladderText}</p>
              <p className={styles['hint']}>{m.suggest.ladderHint}</p>
            </div>
          )}
        </div>
      ) : null}
      {applyError === undefined ? null : <ErrorMessage error={applyError} />}
      <div className={styles['buttons']}>
        <Button
          size="sm"
          disabled={record.test === 'dimension' ? Object.keys(readings).length === 0 : !step}
          onClick={save}
        >
          {m.save}
        </Button>
      </div>
      <p className={styles['hint']} role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  )
}
