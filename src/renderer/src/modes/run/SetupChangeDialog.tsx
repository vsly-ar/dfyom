// The setup-change prompt (v0.2 task E2): between two setups' runs, built like the tool-change
// dialog: the next setup's name and direction, a picture of the stock in its new orientation, the
// steps (turn and clamp the stock, set the work zero at the front-left corner of the new top,
// start), jog and work-zero controls inside, "Start setup n" as the only primary action and the
// run dialogs' Stop. It never continues by itself; "Later" puts it off to the inspector.
// Doc: docs/modes/plan-v0.2.md#setup-change-in-run, docs/conventions/ui.md#run-mode-safety-ui
import { useId } from 'react'
import { DIRECTION_LABEL } from '../../../../core/geometry/face'
import type { ProjectDoc } from '../../../../core/project/document'
import type { SetupOrientation } from '../../../../core/toolpath/wcs'
import { runMessages } from '../../messages/run'
import { Icon, Button, Dialog } from '../../ui'
import { JogPad, useJogMode } from './JogPad'
import { formatLength, runGates } from './machine-state'
import { planRunInfo, setupPlacement } from './plan-info'
import { useRun, useRunStore } from './run-store'
import { WorkZeroButtons } from './RunNavigator'
import { ProbeZButton, usePlateThickness } from './ProbeZButton'
import { RunDialogFooter } from './RunStop'
import styles from './Run.module.css'

const m = runMessages.setupChange

export function SetupChangeDialog({ doc }: { doc: ProjectDoc }): React.JSX.Element | null {
  const store = useRunStore()
  const setupId = useRun((s) => s.setupChange)
  const open = useRun((s) => s.setupChangeOpen)
  const planId = useRun((s) => s.planId)
  const status = useRun((s) => s.status)
  const jogStep = useRun((s) => s.jogStep)
  const jogMode = useJogMode()
  const pending = useRun((s) => s.pending)
  const ids = { jog: useId(), zero: useId(), start: useId() }
  const plate = usePlateThickness(doc)
  const plan = planId === undefined ? undefined : doc.plans[planId]
  if (setupId === undefined || plan === undefined) return null
  const a = store.getState()
  const info = planRunInfo(plan, setupId)
  const n = info.setups.findIndex((s) => s.id === info.setup.id) + 1
  const up = DIRECTION_LABEL[info.setup.direction]
  const placed = setupPlacement(plan, setupId, doc.unitSystem)
  const gates = runGates(status, { planChosen: true })
  const units = doc.unitSystem
  const starting = pending.includes('run.job.start')
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => a.setSetupChangeOpen(o)}
      title={m.title(n, info.setup.name)}
      description={m.description(up)}
      footer={
        <RunDialogFooter>
          <Button variant="ghost" onClick={() => a.setSetupChangeOpen(false)}>
            {m.later}
          </Button>
          <Button
            variant="primary"
            icon={<Icon name="run" />}
            disabled={gates.start !== null || starting}
            {...(gates.start === null ? {} : { 'aria-describedby': ids.start })}
            onClick={() => void a.startRun(info.setup.id)}
          >
            {m.start(n)}
          </Button>
        </RunDialogFooter>
      }
    >
      {placed ? <SetupPicture orientation={placed.orientation} /> : null}
      <ol className={styles['steps']}>
        {m.steps(up).map((s) => (
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
      <dl className={styles['facts']}>
        <dt>{m.workZero}</dt>
        <dd className={styles['mono']}>
          {status.workZero.map((v) => formatLength(v, units)).join(' · ')}{' '}
          {runMessages.dro.units[units]}
        </dd>
      </dl>
      {gates.start === null ? null : (
        <p id={ids.start} className={styles['why']}>
          {gates.start}
        </p>
      )}
    </Dialog>
  )
}

type P3 = readonly [number, number, number]

/** Isometric view from front-right-top (machine +X, −Y, +Z): SVG x right, y down. */
const iso = ([x, y, z]: P3): [number, number] => [
  (x + y) / Math.SQRT2,
  (x - y - 2 * z) / Math.sqrt(6),
]

const W = 240
const H = 150
const PAD = 14

/**
 * The stock as it sits on the machine for the setup: its extents on X, Y, Z, the top face marked,
 * the work zero at the front-left corner of the top, and which part faces are up, in front and on
 * the right (legend). Pure SVG with design tokens.
 */
export function SetupPicture({
  orientation,
}: {
  orientation: SetupOrientation
}): React.JSX.Element {
  const [X, Y, Z] = orientation.size
  const corners: P3[] = [
    [0, 0, 0],
    [X, 0, 0],
    [X, Y, 0],
    [0, Y, 0],
    [0, 0, -Z],
    [X, 0, -Z],
    [X, Y, -Z],
  ]
  const flat = corners.map(iso)
  const minX = Math.min(...flat.map((p) => p[0]))
  const maxX = Math.max(...flat.map((p) => p[0]))
  const minY = Math.min(...flat.map((p) => p[1]))
  const maxY = Math.max(...flat.map((p) => p[1]))
  const k = Math.min((W - 2 * PAD) / (maxX - minX || 1), (H - 2 * PAD) / (maxY - minY || 1))
  const at = (p: P3): string => {
    const [sx, sy] = iso(p)
    const ox = (W - (maxX - minX) * k) / 2
    const oy = (H - (maxY - minY) * k) / 2
    return `${((sx - minX) * k + ox).toFixed(1)},${((sy - minY) * k + oy).toFixed(1)}`
  }
  const face = (ps: readonly P3[]) => ps.map(at).join(' ')
  const label = (d: keyof typeof DIRECTION_LABEL) => DIRECTION_LABEL[d]
  const zero = at([0, 0, 0]).split(',').map(Number) as [number, number]
  return (
    <figure className={styles['setupPicture']}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={m.picture(
          label(orientation.up),
          label(orientation.front),
          label(orientation.right),
        )}
      >
        <polygon
          className={styles['stockSide']}
          points={face([
            [0, 0, 0],
            [X, 0, 0],
            [X, 0, -Z],
            [0, 0, -Z],
          ])}
        />
        <polygon
          className={styles['stockSide']}
          points={face([
            [X, 0, 0],
            [X, Y, 0],
            [X, Y, -Z],
            [X, 0, -Z],
          ])}
        />
        <polygon
          className={styles['stockTop']}
          points={face([
            [0, 0, 0],
            [X, 0, 0],
            [X, Y, 0],
            [0, Y, 0],
          ])}
        />
        <circle className={styles['workZeroRing']} cx={zero[0]} cy={zero[1]} r={6} />
        <circle className={styles['workZeroDot']} cx={zero[0]} cy={zero[1]} r={2.2} />
      </svg>
      <figcaption>
        <dl className={styles['facts']}>
          <dt>{m.faces.up}</dt>
          <dd>{label(orientation.up)}</dd>
          <dt>{m.faces.front}</dt>
          <dd>{label(orientation.front)}</dd>
          <dt>{m.faces.right}</dt>
          <dd>{label(orientation.right)}</dd>
        </dl>
      </figcaption>
    </figure>
  )
}
