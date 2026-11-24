// The alignment panel (hardening DF78, Q107 assumed): the Run alignment step docked in the Run
// inspector below the DRO, so the position and the navigator's jog pad stay in view while the
// operator nudges the stock (the setup-change prompt is modal and hid them). Shown between run
// jobs for the setup the next run starts (the setup change's, else the chosen one) when it has
// alignment points: its name, the setup picture with the points (the current one highlighted)
// and the step (AlignmentStep). The setup-change prompt points here ("Align in the Run panel"
// closes it and focuses this panel, which flashes its accent edge once); after the step is
// confirmed, "Back to the setup change" reopens the prompt, whose start gate stays.
// Doc: docs/modes/alignment.md#implementation-follow-ups-q106q108, docs/conventions/ui.md#run-mode-safety-ui
import { useEffect, useId, useRef, useState } from 'react'
import { DIRECTION_LABEL } from '../../../../core/geometry/face'
import type { ProjectDoc } from '../../../../core/project/document'
import { formatHeight } from '../../messages/plan'
import { runMessages } from '../../messages/run'
import { Button, Icon } from '../../ui'
import { AlignmentStep, stepOf } from './AlignmentStep'
import { activeJob, runGates } from './machine-state'
import { planRunInfo, setupPlacement } from './plan-info'
import { useRun, useRunStore } from './run-store'
import { SetupPicture } from './SetupChangeDialog'
import styles from './Run.module.css'

const m = runMessages.setupChange

/** The flash on focus (ms): `--motion-slow` × 3. */
const FLASH_MS = 840

export function AlignmentPanel({ doc }: { doc: ProjectDoc }): React.JSX.Element | null {
  const store = useRunStore()
  const planId = useRun((s) => s.planId)
  const status = useRun((s) => s.status)
  const setupChange = useRun((s) => s.setupChange)
  const chosen = useRun((s) => s.setupId)
  const alignFocus = useRun((s) => s.alignFocus)
  const panel = useRef<HTMLElement>(null)
  const [flash, setFlash] = useState(false)
  const reasonId = useId()
  // the prompt handed over: focus the panel once the prompt has closed and given focus back
  useEffect(() => {
    if (alignFocus === 0) return
    const t = window.setTimeout(() => {
      panel.current?.focus()
      panel.current?.scrollIntoView?.({ block: 'nearest' })
      setFlash(true)
    }, 60)
    const f = window.setTimeout(() => setFlash(false), FLASH_MS + 60)
    return () => {
      window.clearTimeout(t)
      window.clearTimeout(f)
    }
  }, [alignFocus])
  const plan = planId === undefined ? undefined : doc.plans[planId]
  if (plan === undefined || activeJob(status) !== undefined) return null
  const setupId =
    setupChange ?? (plan.setups.some((s) => s.id === chosen) ? chosen : plan.setups[0]?.id)
  const setup = plan.setups.find((s) => s.id === setupId)
  const points = setup?.alignment?.length ?? 0
  if (setup === undefined || points === 0) return null
  const units = doc.unitSystem
  const info = planRunInfo(plan, setup.id)
  const n = info.setups.findIndex((s) => s.id === setup.id) + 1
  const placed = setupPlacement(plan, setup.id, units)
  const step = stepOf(status.alignment, planId, setup.id)
  const gate = runGates(status, { planChosen: true }).jog
  const zeroText =
    placed === undefined
      ? undefined
      : m.zeroAt(
          placed.zeroPoint !== undefined
            ? { point: placed.zeroPoint }
            : placed.zero[0] === 0 && placed.zero[1] === 0
              ? {}
              : {
                  offset: [
                    formatHeight(placed.zero[0], units),
                    formatHeight(placed.zero[1], units),
                  ],
                },
        )
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className={styles['alignPanel']}
      data-flash={flash || undefined}
      aria-label={m.align.panelLabel(setup.name)}
    >
      <p className={styles['alignPanelSetup']}>
        <span>{m.align.setupFor(n, setup.name)}</span>
        <span className={styles['hint']}>{DIRECTION_LABEL[info.setup.direction]} up</span>
      </p>
      {placed ? (
        <SetupPicture
          orientation={placed.orientation}
          zero={placed.zero}
          zeroText={zeroText}
          points={placed.points}
          current={step?.current}
          compact
        />
      ) : null}
      <AlignmentStep
        setupId={setup.id}
        points={points}
        gate={gate}
        reasonId={reasonId}
        units={units}
      />
      {gate === null ? null : (
        <p id={reasonId} className={styles['why']}>
          {gate}
        </p>
      )}
      {setupChange === setup.id && step?.confirmed === true ? (
        <Button
          icon={<Icon name="run" />}
          onClick={() => store.getState().setSetupChangeOpen(true)}
        >
          {m.align.backToChange(n)}
        </Button>
      ) : null}
    </section>
  )
}
