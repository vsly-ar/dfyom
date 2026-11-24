// The alignment step (hardening DF78, alignment phase 1), docked in the Run inspector's alignment
// panel (Q107, assumed; AlignmentPanel.tsx) so the DRO and the jog pad stay in view: "Start
// alignment" (confirmed once per step), the entries (the work zero, then the setup's points) with
// their WCS X/Y, the current one and a check each, Previous / Next (the pointer's jogs), "Set zero
// here" at the zero, "Zero on this point" at a point, and "Confirm alignment" (asking once when
// entries are unchecked); a side mark's entry says the one axis it checks (Q108). The state is main's (`RunStatus.alignment`), so every window shows the
// same step; a G54 X/Y change clears the checks there.
// Doc: docs/modes/alignment.md#run-the-alignment-step, docs/conventions/ui.md#run-mode-safety-ui
import { useId, useState } from 'react'
import type { AlignmentStep as Step } from '../../../../core/run/alignment'
import type { UnitSystem } from '../../../../core/project/document'
import { runMessages } from '../../messages/run'
import { Button, Checkbox, ConfirmDialog, Icon } from '../../ui'
import { formatLength } from './machine-state'
import { useRun, useRunStore } from './run-store'
import styles from './Run.module.css'

const m = runMessages.setupChange.align
const AT_MM = 0.01

/** The step of this plan and setup, if one runs. */
export function stepOf(
  step: Step | undefined,
  planId: string | undefined,
  setupId: string,
): Step | undefined {
  return step !== undefined && step.planId === planId && step.setupId === setupId ? step : undefined
}

export function AlignmentStep({
  setupId,
  points,
  gate,
  reasonId,
  units,
}: {
  setupId: string
  /** The setup's alignment point count (0: no step). */
  points: number
  /** Why the pointer cannot move now (the jog gate), or null. */
  gate: string | null
  reasonId: string
  units: UnitSystem
}): React.JSX.Element | null {
  const store = useRunStore()
  const planId = useRun((s) => s.planId)
  const status = useRun((s) => s.status)
  const pending = useRun((s) => s.pending)
  const [confirmStart, setConfirmStart] = useState(false)
  const [confirmSkip, setConfirmSkip] = useState(false)
  const ids = { title: useId(), hint: useId() }
  if (points === 0) return null
  const a = store.getState()
  const step = stepOf(status.alignment, planId, setupId)
  const moving = pending.includes('run.align.goto') || status.state.startsWith('Jog')
  const blocked = gate !== null || moving
  const reason = gate === null ? {} : { 'aria-describedby': reasonId }
  const current = step?.entries.find((e) => e.id === step.current)
  const here =
    current !== undefined &&
    Math.abs(status.wpos[0] - current.target[0]) <= AT_MM &&
    Math.abs(status.wpos[1] - current.target[1]) <= AT_MM
  const unticked = step?.entries.filter((e) => !e.ticked).length ?? 0
  const name = (id: string, n: string) => (id === 'zero' ? m.zeroName : n)
  return (
    <section className={styles['alignStep']} aria-labelledby={ids.title}>
      <h3 id={ids.title} className={styles['alignTitle']}>
        <Icon name="pick" /> {m.title}
      </h3>
      {step === undefined ? (
        <>
          <p className={styles['hint']}>{m.intro(points)}</p>
          <div className={styles['buttons']}>
            <Button
              icon={<Icon name="jog" />}
              disabled={blocked}
              {...reason}
              onClick={() => setConfirmStart(true)}
            >
              {m.start}
            </Button>
          </div>
        </>
      ) : (
        <>
          <ol className={styles['alignEntries']} aria-label={m.listLabel}>
            {step.entries.map((e) => {
              const isCurrent = e.id === step.current
              return (
                <li
                  key={e.id}
                  className={styles['alignEntry']}
                  data-current={isCurrent || undefined}
                  data-align-entry={e.id}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  <Checkbox
                    label={m.linesUp(name(e.id, e.name))}
                    checked={e.ticked}
                    // a check needs the pointer there (rule notAtPoint): only the current one
                    disabled={e.ticked ? false : !(isCurrent && here) || moving}
                    onCheckedChange={(c) => void a.alignTick({ entry: e.id, ticked: c === true })}
                  />
                  <span className={styles['mono']}>
                    {m.at(formatLength(e.target[0], units), formatLength(e.target[1], units))}
                  </span>
                  {e.oneAxis === undefined ? null : (
                    // Q108 (assumed): a mark on a side wall checks one axis
                    <span className={styles['alignAxis']} title={m.oneAxisHint(e.oneAxis)}>
                      {m.oneAxis(e.oneAxis)}
                      <span className={styles['srOnly']}>: {m.oneAxisHint(e.oneAxis)}</span>
                    </span>
                  )}
                  {isCurrent ? <span className={styles['alignHere']}>{m.current}</span> : null}
                </li>
              )
            })}
          </ol>
          <div className={styles['buttons']}>
            <Button
              icon={<Icon name="arrow-up" />}
              disabled={blocked}
              {...reason}
              onClick={() => void a.alignGoto(setupId, 'previous')}
            >
              {m.previous}
            </Button>
            <Button
              icon={<Icon name="arrow-down" />}
              disabled={blocked}
              {...reason}
              onClick={() => void a.alignGoto(setupId, 'next')}
            >
              {m.next}
            </Button>
            {current?.id === 'zero' ? (
              <Button
                icon={<Icon name="work-zero" />}
                disabled={!here || blocked}
                aria-describedby={ids.hint}
                onClick={() => void a.setWorkZero(['x', 'y'])}
              >
                {m.setZeroHere}
              </Button>
            ) : current !== undefined ? (
              <Button
                icon={<Icon name="work-zero" />}
                disabled={blocked}
                aria-describedby={ids.hint}
                onClick={() => void a.setWorkZeroAt(current.target[0], current.target[1])}
              >
                {m.zeroOnPoint}
              </Button>
            ) : null}
          </div>
          {current === undefined ? null : (
            <p id={ids.hint} className={styles['hint']}>
              {current.id === 'zero' ? m.setZeroHereHint : m.zeroOnPointHint}
            </p>
          )}
          <div className={styles['buttons']}>
            {step.confirmed ? (
              <p className={styles['alignDone']} role="status">
                <Icon name="success" /> {m.confirmed(step.skipped.length)}
              </p>
            ) : (
              <Button
                icon={<Icon name="check" />}
                disabled={moving}
                onClick={() =>
                  unticked > 0 ? setConfirmSkip(true) : void a.alignTick({ confirm: true })
                }
              >
                {m.confirm}
              </Button>
            )}
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirmStart}
        onOpenChange={setConfirmStart}
        title={m.confirmTitle}
        description={m.confirmDescription}
        confirmLabel={m.start}
        destructive={false}
        onConfirm={() => void a.alignGoto(setupId, 'zero')}
      />
      <ConfirmDialog
        open={confirmSkip}
        onOpenChange={setConfirmSkip}
        title={m.skipTitle(unticked, step?.entries.length ?? 0)}
        description={m.skipDescription}
        confirmLabel={m.skipConfirm}
        destructive={false}
        onConfirm={() => void a.alignTick({ confirm: true, skipUnticked: true })}
      />
    </section>
  )
}
