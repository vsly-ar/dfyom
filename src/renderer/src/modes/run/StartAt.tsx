// The pre-flight's "Start at" (DF129 RC3, Q168): Beginning, the program's resume points (operation
// and pass starts, grouped by operation) or "Choose a line…" (any line, Q169), and for a start
// line the preview `run.job.check { fromLine }` returns: the lines skipped, the tool wait every
// lead-in makes (Q167, shown first and plainly), the findings of the line (in material, a ramp
// or helix with "Start at its first line", G91), and the lead-in's steps with its gCode behind a
// disclosure. `usePreflightStart` runs the check for both pre-flights (plan and file);
// `useStartPreview` gives the gCode panel and the 3D view the program and its start line.
// Doc: docs/modes/run-recovery.md#implementation-rc3, docs/conventions/ui.md#run-mode-safety-ui
import { useEffect, useId, useMemo, useState } from 'react'
import type { UnitSystem } from '../../../../core/project/document'
import { resumePoints, scanProgram, type ResumePoint } from '../../../../core/run/recovery'
import { runMessages } from '../../messages/run'
import { Button, ErrorMessage, FieldInput, Icon, Select } from '../../ui'
import { formatLength } from './machine-state'
import {
  startLineOf,
  useRun,
  useRunStore,
  type PreflightCheck,
  type ResumePreviewView,
  type StartAt,
} from './run-store'
import { leadInSteps, startAtOptions, stepText, type StartAtValue } from './start-at'
import styles from './Run.module.css'

const m = runMessages.startAt

/** The program "Start at" offers: a loaded file's own lines, else the plan's from the check. */
export function useStartProgram():
  | {
      readonly lines: readonly string[]
      readonly sections: readonly { readonly fromLine: number; readonly label: string }[]
      readonly points: readonly ResumePoint[]
    }
  | undefined {
  const file = useRun((s) => s.file)
  const planProgram = useRun((s) => s.startProgram)
  const open = useRun((s) => s.preflightOpen)
  const prepared = file?.state === 'ready' ? file.prepared : undefined
  // a file's resume points, found here (its lines are in the window already)
  const filePoints = useMemo(
    () => (prepared === undefined || !open ? undefined : resumePoints(scanProgram(prepared.lines))),
    [prepared, open],
  )
  if (prepared !== undefined)
    return filePoints === undefined
      ? undefined
      : { lines: prepared.lines, sections: prepared.sections, points: filePoints }
  return planProgram
}

/**
 * The pre-flight's check with its start line (`baseKey`: what else the check depends on):
 * runs `run.job.check` (with `fromLine` for a start line) while `canCheck`; `at` is what
 * `run.job.start` takes once the preview is in; `ready` is false while a chosen line waits for it.
 */
export function usePreflightStart(
  baseKey: string,
  setupId: string | undefined,
  canCheck: boolean,
): {
  readonly current: Exclude<PreflightCheck, { state: 'idle' }> | undefined
  readonly startAt: StartAt
  readonly line: number | undefined
  readonly preview: ResumePreviewView | undefined
  readonly at:
    { readonly fromLine: number; readonly programHash: string; readonly leadIn: number } | undefined
  readonly ready: boolean
} {
  const store = useRunStore()
  const check = useRun((s) => s.preflightCheck)
  const startAt = useRun((s) => s.startAt)
  const line = startLineOf(startAt)
  const key = `${baseKey}|${line ?? ''}`
  useEffect(() => {
    if (canCheck) void store.getState().checkRun(setupId, key, line)
  }, [canCheck, key, setupId, line, store])
  const current = check.state !== 'idle' && check.key === key ? check : undefined
  const preview = current?.state === 'done' ? current.resume : undefined
  const at =
    line !== undefined && preview !== undefined
      ? {
          fromLine: preview.fromLine,
          programHash: preview.programHash,
          leadIn: preview.leadIn.length,
        }
      : undefined
  const ready = startAt.kind === 'beginning' || at !== undefined
  return { current, startAt, line, preview, at, ready }
}

/** "Start at" and, for a start line, its preview (inside the pre-flight dialog). */
export function StartAtSection({
  current,
  units,
}: {
  current: Exclude<PreflightCheck, { state: 'idle' }> | undefined
  units: UnitSystem
}): React.JSX.Element | null {
  const store = useRunStore()
  const startAt = useRun((s) => s.startAt)
  const program = useStartProgram()
  const selectId = useId()
  const lineId = useId()
  const hintId = useId()
  const a = store.getState()
  const points = useMemo(() => program?.points ?? [], [program])
  const options = useMemo(() => startAtOptions(points), [points])
  if (program === undefined)
    return current?.state === 'checking' ? <p className={styles['hint']}>{m.loading}</p> : null
  const total = program.lines.length
  const value: StartAtValue =
    startAt.kind === 'beginning'
      ? 'beginning'
      : startAt.kind === 'line'
        ? 'line'
        : `p:${startAt.line}`
  const choose = (v: StartAtValue) => {
    if (v === 'beginning') a.setStartAt({ kind: 'beginning' })
    else if (v === 'line') a.setStartAt({ kind: 'line', line: startLineOf(startAt) })
    else a.setStartAt({ kind: 'point', line: Number(v.slice(2)) })
  }
  /** A line from a finding's or a hint's button: a resume point when it is one. */
  const goTo = (n: number) =>
    a.setStartAt(
      points.some((p) => p.line === n) ? { kind: 'point', line: n } : { kind: 'line', line: n },
    )
  return (
    <section className={styles['startAt']} aria-labelledby={selectId}>
      <div className={styles['startAtFields']}>
        <label id={selectId} htmlFor={`${selectId}-select`} className={styles['rowLabel']}>
          {m.label}
        </label>
        <Select id={`${selectId}-select`} options={options} value={value} onValueChange={choose} />
        {startAt.kind === 'line' ? (
          <LineField
            // a line set from a button shows in the field
            key={startAt.line ?? ''}
            id={lineId}
            hintId={hintId}
            total={total}
            line={startAt.line}
            onLine={(n) => a.setStartAt({ kind: 'line', line: n })}
          />
        ) : null}
      </div>
      {points.length === 0 && startAt.kind === 'beginning' ? (
        <p className={styles['hint']}>{m.noPoints}</p>
      ) : null}
      {startAt.kind === 'point' && startAt.snappedFrom !== undefined ? (
        <div className={styles['notice']} role="note">
          <Icon name="info" />
          <div>
            <p className={styles['why']}>{m.snapped(startAt.snappedFrom, startAt.line)}</p>
            <div className={styles['buttons']}>
              <Button
                size="sm"
                onClick={() => a.setStartAt({ kind: 'line', line: startAt.snappedFrom })}
              >
                {m.useAnyway(startAt.snappedFrom)}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {startLineOf(startAt) === undefined ? null : (
        <StartPreview
          current={current}
          units={units}
          asked={startAt.kind === 'line' ? startAt.line : undefined}
          onLine={goTo}
        />
      )}
    </section>
  )
}

/** "Choose a line…"'s number field: checked on Enter or when it loses the focus. */
function LineField({
  id,
  hintId,
  total,
  line,
  onLine,
}: {
  id: string
  hintId: string
  total: number
  line: number | undefined
  onLine(n: number): void
}): React.JSX.Element {
  const [text, setText] = useState(line === undefined ? '' : String(line))
  const n = Number(text.replace(/[,\s]/g, ''))
  const valid = text.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= total
  const commit = () => {
    if (valid && n !== line) onLine(n)
  }
  return (
    <>
      <label htmlFor={id} className={styles['rowLabel']}>
        {m.lineField}
      </label>
      <div className={styles['lineField']}>
        <FieldInput
          id={id}
          inputMode="numeric"
          value={text}
          aria-describedby={hintId}
          aria-invalid={text.trim() !== '' && !valid}
          onChange={(e) => setText(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            commit()
          }}
        />
      </div>
      <p id={hintId} className={`${styles['hint']} ${styles['startAtHint']}`}>
        {m.lineHint(total)}
      </p>
    </>
  )
}

/** The checked start: skipped lines, the tool wait, the findings, the lead-in's steps. */
function StartPreview({
  current,
  units,
  asked,
  onLine,
}: {
  current: Exclude<PreflightCheck, { state: 'idle' }> | undefined
  units: UnitSystem
  /** The line typed behind "Choose a line…" (its resume-point hint). */
  asked: number | undefined
  onLine(n: number): void
}): React.JSX.Element {
  if (current === undefined || current.state === 'checking')
    return (
      <p className={styles['hint']} aria-live="polite">
        {m.checking}
      </p>
    )
  if (current.state === 'failed')
    return (
      <div className={styles['notice']} data-tone="danger" role="note">
        <Icon name="warning" />
        <div>
          <p className={styles['why']}>{m.failed}</p>
          <ErrorMessage error={current.error} />
        </div>
      </div>
    )
  const preview = current.resume
  if (preview === undefined) return <></>
  const { steps, unit } = leadInSteps(preview.leadIn)
  const wait = steps.find((s) => s.kind === 'toolWait')
  const len = (mm: number) => formatLength(mm, units)
  const warnings = preview.findings.flatMap((f): { key: string; text: string; from?: number }[] =>
    f.rule === 'inMaterial'
      ? [{ key: 'inMaterial', text: m.findings.inMaterial(len(f.z), runMessages.dro.units[units]) }]
      : f.rule === 'ramp'
        ? [{ key: 'ramp', text: m.findings.ramp(f.helix, f.from), from: f.from }]
        : f.rule === 'incremental'
          ? [{ key: 'incremental', text: m.findings.incremental }]
          : [],
  )
  // a typed line that is not a resume point: the nearest ones, a click away
  const notAPoint = asked !== undefined && preview.before !== preview.fromLine
  return (
    <div className={styles['startPreview']} aria-live="polite">
      <p className={styles['hint']}>{m.skipped(preview.fromLine)}</p>
      {wait?.kind === 'toolWait' ? (
        <div className={styles['toolWait']} role="note">
          <Icon name="flat-end-mill" />
          <div>
            <p className={styles['toolWaitTitle']}>{m.toolWaitTitle(wait.n, wait.name)}</p>
            <p className={styles['why']}>{m.toolWaitText}</p>
          </div>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className={styles['notice']} data-tone="warning" role="note">
          <Icon name="warning" />
          <div>
            {warnings.map((w) => (
              <p key={w.key} className={styles['why']}>
                {w.text}
              </p>
            ))}
            {warnings.flatMap(({ key, from }) =>
              from === undefined
                ? []
                : [
                    <div key={`${key}-action`} className={styles['buttons']}>
                      <Button size="sm" onClick={() => onLine(from)}>
                        {m.findings.rampAction(from)}
                      </Button>
                    </div>,
                  ],
            )}
          </div>
        </div>
      ) : null}
      {notAPoint ? (
        <div className={styles['notice']} role="note">
          <Icon name="info" />
          <div>
            <p className={styles['why']}>{m.notAPoint(preview.fromLine)}</p>
            <div className={styles['buttons']}>
              {preview.before === undefined ? null : (
                <Button size="sm" onClick={() => onLine(preview.before!)}>
                  {m.usePoint(preview.before, 'before')}
                </Button>
              )}
              {preview.after === undefined ? null : (
                <Button size="sm" onClick={() => onLine(preview.after!)}>
                  {m.usePoint(preview.after, 'after')}
                </Button>
              )}
            </div>
          </div>
        </div>
      ) : null}
      <section className={styles['leadIn']} aria-label={m.leadIn}>
        <h3 className={styles['leadInTitle']}>{m.leadIn}</h3>
        <p className={styles['hint']}>{m.leadInIntro}</p>
        <ol className={styles['leadInSteps']}>
          {steps.map((s, i) => (
            <li key={i} data-kind={s.kind}>
              {stepText(s, unit)}
            </li>
          ))}
          <li data-kind="program">{m.steps.program(preview.fromLine)}</li>
        </ol>
        <details className={styles['leadInCode']}>
          <summary>{m.leadInCode}</summary>
          <pre className={styles['mono']}>{preview.leadIn.join('\n')}</pre>
        </details>
      </section>
    </div>
  )
}

/**
 * DF129 RC3: the program and start line the gCode panel and the 3D view show while the pre-flight
 * has a start line and no run streams; undefined otherwise.
 */
export function useStartPreview():
  | {
      readonly lines: readonly string[]
      readonly sections: readonly { readonly fromLine: number; readonly label: string }[]
      readonly start: number
    }
  | undefined {
  const open = useRun((s) => s.preflightOpen)
  const running = useRun((s) => s.status.job !== undefined)
  const startAt = useRun((s) => s.startAt)
  const check = useRun((s) => s.preflightCheck)
  const file = useRun((s) => s.file)
  const planProgram = useRun((s) => s.startProgram)
  const line = startLineOf(startAt)
  if (!open || running || line === undefined) return undefined
  const program =
    file?.state === 'ready'
      ? { lines: file.prepared.lines, sections: file.prepared.sections }
      : planProgram
  if (program === undefined) return undefined
  // the checked start (a tool-change marker passed over) once the check of this line is in
  const resume = check.state === 'done' && check.key.endsWith(`|${line}`) ? check.resume : undefined
  return { lines: program.lines, sections: program.sections, start: resume?.fromLine ?? line }
}
