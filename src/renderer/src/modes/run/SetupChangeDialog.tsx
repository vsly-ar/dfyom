// The setup-change prompt (v0.2 task E2): between two setups' runs, built like the tool-change
// dialog: the next setup's name and direction, a picture of the stock in its new orientation, the
// steps (turn and clamp the stock, set the work zero at the front-left corner of the new top or
// where the setup moved it, DF78 N7; start), the zero to set and the part corner it is (M7), jog
// and work-zero controls inside, "Start setup n" as the only primary action and the run dialogs'
// Stop. It never continues by itself; "Close (start later)" puts it off to the inspector. A setup
// with alignment points aligns in the docked Run panel (AlignmentPanel, Q107 assumed): the prompt
// says so with "Align in the Run panel" and keeps "Start setup n" disabled until it is confirmed.
// Doc: docs/modes/plan-v0.2.md#setup-change-in-run, docs/conventions/ui.md#run-mode-safety-ui,
// docs/modes/run-machine.md#run-status-and-the-zero-to-set-m7
import { useId } from 'react'
import { DIRECTION_LABEL } from '../../../../core/geometry/face'
import type { ProjectDoc } from '../../../../core/project/document'
import type { SetupOrientation } from '../../../../core/toolpath/wcs'
import { formatHeight } from '../../messages/plan'
import { runMessages } from '../../messages/run'
import { Icon, Button, Dialog } from '../../ui'
import { JogPad, useJogControls } from './JogPad'
import { formatLength, runGates } from './machine-state'
import { planRunInfo, setupPlacement } from './plan-info'
import { useRun, useRunStore } from './run-store'
import { WorkZeroButtons } from './RunNavigator'
import { ProbeZButton, usePlateThickness } from './ProbeZButton'
import { RunDialogFooter } from './RunStop'
import { stepOf } from './AlignmentStep'
import styles from './Run.module.css'

const m = runMessages.setupChange

export function SetupChangeDialog({ doc }: { doc: ProjectDoc }): React.JSX.Element | null {
  const store = useRunStore()
  const setupId = useRun((s) => s.setupChange)
  const open = useRun((s) => s.setupChangeOpen)
  const planId = useRun((s) => s.planId)
  const status = useRun((s) => s.status)
  const jog = useJogControls(doc)
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
  // DF78: a setup with alignment points starts once its step is confirmed (the server's gate)
  const points = plan.setups.find((s) => s.id === info.setup.id)?.alignment?.length ?? 0
  const aligned =
    points === 0 || stepOf(status.alignment, planId, info.setup.id)?.confirmed === true
  const startGate = gates.start ?? (aligned ? null : m.align.pending)
  // DF78 (N7): the zero's offset or point, in words
  const moved =
    placed !== undefined &&
    (placed.zeroPoint !== undefined || placed.zero[0] !== 0 || placed.zero[1] !== 0)
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
            disabled={startGate !== null || starting}
            {...(startGate === null ? {} : { 'aria-describedby': ids.start })}
            onClick={() => void a.startRun(info.setup.id)}
          >
            {m.start(n)}
          </Button>
        </RunDialogFooter>
      }
    >
      {placed ? (
        <SetupPicture
          orientation={placed.orientation}
          zero={placed.zero}
          zeroText={zeroText}
          points={placed.points}
          current={stepOf(status.alignment, planId, info.setup.id)?.current}
        />
      ) : null}
      <ol className={styles['steps']}>
        {m.steps(up, zeroText).map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <JogPad controls={jog} disabledReason={gates.jog} reasonId={ids.jog} />
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
        <dt>{m.zeroToSet}</dt>
        <dd>
          {m.zeroText(moved ? zeroText?.replace(/^X /, 'at X ') : undefined)}
          {placed && placed.zeroPoint === undefined
            ? ` ${moved ? m.offsetCorner(placed.corner) : m.zeroCorner(placed.corner)}`
            : ''}
        </dd>
        {placed ? (
          <>
            <dt>{m.stockOnMachine}</dt>
            <dd className={styles['mono']}>
              {placed.orientation.size
                .map((v, i) => `${'XYZ'[i]} ${formatLength(v, units)}`)
                .join(' × ')}{' '}
              {runMessages.dro.units[units]}
            </dd>
          </>
        ) : null}
        <dt>{m.workZero}</dt>
        <dd className={styles['mono']}>
          {status.workZero.map((v) => formatLength(v, units)).join(' · ')}{' '}
          {runMessages.dro.units[units]}
        </dd>
      </dl>
      {points === 0 ? null : (
        // Q107 (assumed): the step is docked in the Run inspector, beside the DRO and the jog pad
        <section className={styles['alignHandover']} aria-label={m.align.title}>
          <h3 className={styles['alignTitle']}>
            <Icon name="pick" /> {m.align.title}
          </h3>
          {aligned ? (
            <p className={styles['alignDone']} role="status">
              <Icon name="success" /> {m.align.handoverDone}
            </p>
          ) : (
            <>
              <p className={styles['hint']}>{m.align.handover(points)}</p>
              <div className={styles['buttons']}>
                <Button icon={<Icon name="pick" />} onClick={() => a.showAlignPanel()}>
                  {m.align.openPanel}
                </Button>
              </div>
            </>
          )}
        </section>
      )}
      {startGate === null ? null : (
        <p id={ids.start} className={styles['why']}>
          {startGate}
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
 * the work zero (the front-left corner of the top unless the setup moves it), and which part faces are up, in front and on
 * the right (legend). Pure SVG with design tokens.
 */
export function SetupPicture({
  orientation,
  zero = [0, 0],
  zeroText,
  points = [],
  current,
  compact = false,
}: {
  orientation: SetupOrientation
  /** DF78 (N7): the work zero from the front-left corner of the top (mm); the ring is drawn there. */
  zero?: readonly [number, number]
  zeroText?: string | undefined
  /** DF78: alignment points on the top (setup frame, mm), drawn as numbered diamonds. */
  points?: readonly {
    readonly id: string
    readonly name: string
    readonly n: number
    readonly at: readonly [number, number]
  }[]
  /** The alignment step's current entry (`'zero'` or a point id): highlighted. */
  current?: string | undefined
  /** In the alignment panel (Q107): narrower, without the faces legend. */
  compact?: boolean
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
    // the zero may lie off the stock: keep it in the picture
    [zero[0], zero[1], 0],
    ...points.map((p): P3 => [p.at[0], p.at[1], 0]),
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
  const ring = at([zero[0], zero[1], 0]).split(',').map(Number) as [number, number]
  return (
    <figure className={styles['setupPicture']} data-compact={compact || undefined}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={m.picture(
          label(orientation.up),
          label(orientation.front),
          label(orientation.right),
          zeroText,
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
        {points.map((p) => {
          const [cx, cy] = at([p.at[0], p.at[1], 0]).split(',').map(Number) as [number, number]
          const r = p.id === current ? 5.5 : 4
          return (
            <g
              key={p.id}
              className={styles['alignMarker']}
              data-align-point={p.id}
              data-current={p.id === current ? '' : undefined}
            >
              <title>{p.name}</title>
              <polygon points={`${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy} ${cx},${cy - r}`} />
              <text x={cx + r + 2} y={cy - r - 1}>
                {p.n}
              </text>
            </g>
          )
        })}
        <circle
          className={styles['workZeroRing']}
          data-current={current === 'zero' ? '' : undefined}
          cx={ring[0]}
          cy={ring[1]}
          r={current === 'zero' ? 7.5 : 6}
        />
        <circle className={styles['workZeroDot']} cx={ring[0]} cy={ring[1]} r={2.2} />
        <text className={styles['workZeroLabel']} x={ring[0] - 8} y={ring[1] - 10}>
          {m.zeroLabel}
        </text>
      </svg>
      <figcaption hidden={compact}>
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
