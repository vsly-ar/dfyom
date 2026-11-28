// Work area (v0.5 RV7, Q223): after homing the user jogs (the pad inside the dialog) to the last
// safe point of each end and marks it; every mark, clear and margin change writes the library
// machine through `run.workArea.set`, and the open connection follows at once (jogs, Go to, "→0",
// probing and the run's soft-limit check stop at the marks less the margin). The marks are compared
// with `$130–$132`: a `$13n=` line to copy, never written (Q219). Nothing here moves the machine
// except the jog pad. Doc: docs/modes/run.md#work-area-rv7
import { useId, useMemo, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import {
  markProblem,
  travelSuggestions,
  withMark,
  workAreaBounds,
  WORK_AREA_AXES,
  type WorkAreaAxis,
  type WorkAreaMarks,
} from '../../../../core/run/work-area'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { runMessages } from '../../messages/run'
import { useShell } from '../../shell/ShellContext'
import { Button, Dialog, ErrorMessage, Field, FieldInput, Icon } from '../../ui'
import { useLibraryItems } from '../plan/usePlan'
import { parseGoToField } from './GoToDialog'
import { JogPad, useJogControls, useMachineJog } from './JogPad'
import { formatLength, isConnected, runGates } from './machine-state'
import { workAreaOfValues } from './plan-info'
import { useRun, useRunStore, useRunUnits } from './run-store'
import { RunDialogFooter } from './RunStop'
import styles from './Run.module.css'

const m = runMessages.workArea
const SIDES = ['min', 'max'] as const

/** Mounted with the run dialogs; open while the run store's `workAreaOpen` is set. */
export function WorkAreaDialog({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element | null {
  const open = useRun((s) => s.workAreaOpen)
  return open ? <WorkAreaOpen doc={doc} /> : null
}

function WorkAreaOpen({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element {
  const { bridge } = useShell()
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const units = useRunUnits(doc)
  const unit = runMessages.dro.units[units]
  const jog = useJogControls(doc)
  const key = useMachineJog(doc).key
  // read again after each write (the window's library broadcast may come later)
  const [writes, setWrites] = useState(0)
  const machines = useLibraryItems('machine', writes)
  const item = machines?.find((x) => x.id === key) as
    { id: string; revision: number; [field: string]: unknown } | undefined
  const stored = useMemo(() => workAreaOfValues(item), [item])
  // the field shows the stored margin until edited, and again after the edit is saved
  const [marginEdit, setMarginEdit] = useState<string | undefined>(undefined)
  const marginText = marginEdit ?? formatLength(stored.margin, units)
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const [announce, setAnnounce] = useState('')
  const [saving, setSaving] = useState(false)
  const ids = { jog: useId(), why: useId() }
  const f = (mm: number) => formatLength(mm, units)

  const env = isConnected(status) ? status.envelope : undefined
  const gates = runGates(status, { planChosen: false })
  const why =
    item === undefined
      ? m.noMachine
      : !isConnected(status)
        ? runMessages.why.notConnected
        : !status.homed
          ? m.homeFirst
          : status.state !== 'Idle'
            ? m.idleFirst
            : null

  const write = async (
    args: { marks?: WorkAreaMarks | null; margin?: number },
    what: string,
  ): Promise<boolean> => {
    if (item === undefined) return false
    setSaving(true)
    const r = await bridge.call('run.workArea.set', {
      machineId: item.id,
      revision: item.revision,
      ...args,
    })
    setSaving(false)
    if (r.ok) {
      setError(undefined)
      setWrites((n) => n + 1)
      setAnnounce(what)
    } else setError(r.error)
    return r.ok
  }
  const mark = (axis: WorkAreaAxis, side: 'min' | 'max') => {
    const i = WORK_AREA_AXES.indexOf(axis)
    const at = store.getState().status.mpos[i]!
    if (markProblem(stored.marks, axis, side, at) !== undefined) {
      setAnnounce(m.crossed(axis.toUpperCase()))
      return
    }
    void write(
      { marks: withMark(stored.marks, axis, side, at) },
      m.saved(m.mark(axis.toUpperCase(), side).replace(/^Mark /, '')),
    )
  }
  const clearSide = (axis: WorkAreaAxis, side: 'min' | 'max') => {
    void write(
      { marks: withMark(stored.marks, axis, side, undefined) },
      m.saved(m.clearSide(axis.toUpperCase(), side)),
    )
  }
  const margin = parseGoToField(marginText, units)
  const commitMargin = () => {
    if (margin === undefined || margin < 0 || margin > 100) return
    if (Math.abs(margin - stored.margin) < 1e-6) return setMarginEdit(undefined)
    void write({ margin }, m.saved(m.margin)).then((ok) =>
      ok ? setMarginEdit(undefined) : undefined,
    )
  }
  const copy = (line: string) =>
    void (navigator.clipboard?.writeText(line) ?? Promise.reject(new Error('no clipboard')))
      .then(() => setAnnounce(m.copied(line)))
      .catch(() => setAnnounce(m.copyFailed))

  const suggestions = env === undefined ? [] : travelSuggestions(env, stored.marks)
  const bounds =
    env === undefined
      ? undefined
      : workAreaBounds(env.travel, { marks: stored.marks, margin: stored.margin })
  const tooWide = WORK_AREA_AXES.filter(
    (a, i) => bounds !== undefined && bounds.min[i]! > bounds.max[i]! + 1e-9,
  )
  const anyMark = WORK_AREA_AXES.some(
    (a) => stored.marks[a]?.min !== undefined || stored.marks[a]?.max !== undefined,
  )
  const close = () => store.getState().setWorkAreaOpen(false)

  return (
    <Dialog
      open
      placement="end"
      onOpenChange={(o) => (o ? undefined : close())}
      title={m.title}
      description={m.description}
      hideDescription
      footer={
        <RunDialogFooter>
          <Button onClick={close}>{m.close}</Button>
        </RunDialogFooter>
      }
    >
      <div className={styles['xyZero']} data-work-area="">
        <p className={styles['hint']}>{m.steps}</p>
        <JogPad controls={jog} disabledReason={gates.jog} reasonId={ids.jog} />
        <table className={styles['settingsTable']} aria-label={m.table}>
          <thead>
            <tr>
              <th scope="col">{m.columns.axis}</th>
              <th scope="col">{m.columns.min}</th>
              <th scope="col">{m.columns.max}</th>
            </tr>
          </thead>
          <tbody>
            {WORK_AREA_AXES.map((a, i) => (
              <tr key={a} data-axis={a}>
                <th scope="row">
                  {a.toUpperCase()}
                  {env === undefined ? null : (
                    <span className={styles['settingName']}>
                      {' '}
                      {m.columns.travel} {f(-env.travel[i]!)} … {f(0)} {unit}
                    </span>
                  )}
                </th>
                {SIDES.map((side) => {
                  const v = stored.marks[a]?.[side]
                  return (
                    <td key={side}>
                      <span className={styles['mono']} data-mark={`${a}-${side}`}>
                        {v === undefined ? m.unmarked : `${f(v)} ${unit}`}
                      </span>
                      <div className={styles['buttons']}>
                        <Button
                          size="sm"
                          disabled={why !== null || saving}
                          aria-describedby={why === null ? undefined : ids.why}
                          onClick={() => mark(a, side)}
                        >
                          {m.mark(a.toUpperCase(), side)}
                        </Button>
                        {v === undefined ? null : (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={saving || item === undefined}
                            aria-label={m.clearSide(a.toUpperCase(), side)}
                            icon={<Icon name="close" />}
                            onClick={() => clearSide(a, side)}
                          />
                        )}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <Field
          label={m.margin}
          info={m.marginHint}
          messages={
            margin === undefined || margin < 0 || margin > 100
              ? [{ id: 'invalid', severity: 'error', text: runMessages.goTo.invalid }]
              : tooWide.map((a) => ({
                  id: `wide-${a}`,
                  severity: 'soft' as const,
                  text: m.marginTooWide(a.toUpperCase()),
                }))
          }
        >
          <FieldInput
            unit={unit}
            inputMode="decimal"
            value={marginText}
            disabled={item === undefined || saving}
            onChange={(e) => setMarginEdit(e.target.value)}
            onBlur={commitMargin}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitMargin()
            }}
          />
        </Field>
        {suggestions.map((s) => (
          <div key={s.axis} className={styles['notice']} data-suggestion={s.setting}>
            <Icon name="info" />
            <div>
              <p className={styles['hint']}>
                {(s.kind === 'raise' ? m.raise : m.lower)(
                  s.axis.toUpperCase(),
                  f(s.reach),
                  f(s.travel),
                  s.setting,
                  unit,
                )}
              </p>
              <div className={styles['buttons']}>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Icon name="copy" />}
                  aria-label={m.copy(s.line)}
                  onClick={() => copy(s.line)}
                >
                  <span className={styles['mono']}>{s.line}</span>
                </Button>
              </div>
            </div>
          </div>
        ))}
        <p className={styles['hint']}>{m.clearHint}</p>
        <div className={styles['buttons']}>
          <Button
            size="sm"
            disabled={!anyMark || saving || item === undefined}
            onClick={() => void write({ marks: null }, m.cleared)}
          >
            {m.clear}
          </Button>
        </div>
        <p id={ids.why} className={styles['why']} role="status">
          {why ?? ''}
        </p>
        {error === undefined ? null : <ErrorMessage error={error} />}
        <p role="status" className={styles['srOnly']}>
          {announce}
        </p>
      </div>
    </Dialog>
  )
}
