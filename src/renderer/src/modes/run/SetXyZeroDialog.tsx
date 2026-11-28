// Set X/Y zero (v0.5 RV5, Q225): pick a stock edge or corner on the stock top picture (the plan's
// zero ringed, the nearest corner picked first), probe it (an RV4 routine through
// `run.machine.probe`, the workholding guard over its path) or touch it with the bit (the jog pad
// inside, a feeler, "Touching" per edge), then confirm the new G54 X/Y (old → new) before
// `G10 L20` writes it. Without a plan the user enters where the edge is. Nothing moves until Probe
// or a jog is pressed; nothing is written until Set zero. On the virtual machine the virtual
// operator lays the plan's stock a few mm off (`run.virtual.stock`) and its touch readout is on
// while the touch method is chosen.
// Doc: docs/modes/run-probing.md#set-xy-zero-rv5
import { useEffect, useId, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import {
  ROUTINE_DEFAULTS,
  routinePath,
  XY_PROBE_KINDS,
  type ProbeRoutine,
  type ProbeRoutineSpec,
} from '../../../../core/run/probe-routines'
import type { GoToStep, Vec3 } from '../../../../core/run/goto'
import {
  g54For,
  planEdge,
  touchedEdge,
  virtualStockBox,
  zeroCorner,
  type PlanStock,
  type Side,
} from '../../../../core/run/xy-zero'
import { lengthSource } from '../../messages/dfm'
import { runMessages } from '../../messages/run'
import { Button, Dialog, Field, FieldInput, Icon, SegmentedControl } from '../../ui'
import { useLibraryItems } from '../plan/usePlan'
import { parseGoToField } from './GoToDialog'
import { JogPad, useJogControls } from './JogPad'
import { activeJob, formatLength, runGates } from './machine-state'
import { findingText, mayGo, MoveGuardFinding, useGoAnyway, useMoveGuard } from './MoveGuardFinding'
import { machineProbe, setupPlacement, setupStock } from './plan-info'
import { ProbeInput, useProbeCheck } from './ProbeInput'
import { NO_PLAN, useRun, useRunStore, useRunUnits, type ProbedValue } from './run-store'
import { RunDialogFooter } from './RunStop'
import { useRunWorkholding } from './useRunWorkholding'
import styles from './Run.module.css'

const m = runMessages.xyZero
type Pick = readonly [Side | 0, Side | 0]
type Method = 'probe' | 'touch'
type Measured = { readonly x?: ProbedValue; readonly y?: ProbedValue }

/** The eight picks, laid out on the picture's 3 × 3 grid (Y+ at the top). */
const PICKS: readonly Pick[] = [
  [-1, 1],
  [0, 1],
  [1, 1],
  [-1, 0],
  [1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
]
const key = (p: Pick) => `${p[0]},${p[1]}`
const edgeName = (axis: 'x' | 'y', side: Side) => `${axis.toUpperCase()}${side < 0 ? '−' : '+'}`
/** Without a plan: a stock for the virtual machine and the picture's square. */
const NO_PLAN_STOCK: PlanStock = { length: 100, width: 100, thickness: 20, zero: [0, 0] }

/** Mounted with the run dialogs; open while the run store's `xyZeroOpen` is set. */
export function SetXyZeroDialog({
  doc,
}: {
  doc: ProjectDoc | undefined
}): React.JSX.Element | null {
  const open = useRun((s) => s.xyZeroOpen)
  return open ? <XyZeroOpen doc={doc} /> : null
}

function XyZeroOpen({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element {
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const setupId = useRun((s) => s.setupId)
  const machineId = useRun((s) => s.machineId)
  const busy = useRun((s) => s.probeJobId !== undefined)
  const actionError = useRun((s) => s.actionError)
  const machines = useLibraryItems('machine')
  const units = useRunUnits(doc)
  const unit = runMessages.dro.units[units]
  const jog = useJogControls(doc)
  const wh = useRunWorkholding()
  const ids = { jog: useId(), why: useId(), finding: useId() }
  const probeOk = useProbeCheck(doc)

  const plan = planId === undefined || planId === NO_PLAN ? undefined : doc?.plans[planId]
  const placed = plan === undefined ? undefined : setupPlacement(plan, setupId, units)
  const stock: PlanStock | undefined = setupStock(placed)
  const probe = machineProbe(plan, machines, machineId)
  const canProbe = XY_PROBE_KINDS.includes(probe.kind)
  const plateReady =
    probe.kind !== 'xyzPlate' ||
    (probe.plateThickness !== undefined && probe.wallOffset !== undefined)
  const zc = stock === undefined ? undefined : zeroCorner(stock)

  const [pick, setPick] = useState<Pick>(() => zc?.corner ?? [-1, -1])
  const [method, setMethod] = useState<Method>(canProbe ? 'probe' : 'touch')
  const spindleD = wh?.tool?.tool.diameter.canonical
  const [diaText, setDiaText] = useState(() =>
    spindleD === undefined ? '' : formatLength(spindleD, units),
  )
  const [feelerText, setFeelerText] = useState(() => formatLength(0, units))
  const [valueTexts, setValueTexts] = useState<readonly [string, string]>(() => [
    formatLength(0, units),
    formatLength(0, units),
  ])
  const [touches, setTouches] = useState<{ readonly x?: number; readonly y?: number }>({})
  const [measured, setMeasured] = useState<Measured | undefined>(undefined)
  const [anyway, setAnyway] = useGoAnyway(key(pick) + method)

  // the virtual operator lays the stock (once per connection and setup) and, for the touch
  // method, lets the bit's contact close the probe input
  const virtual = status.connection.target === 'virtual'
  const layKey = `${planId ?? ''}:${setupId ?? ''}`
  useEffect(() => {
    if (!virtual) return
    const s = store.getState().status
    void store.getState().layVirtualStock(
      layKey,
      virtualStockBox(stock ?? NO_PLAN_STOCK, {
        workZero: [s.workZero[0], s.workZero[1], s.workZero[2]],
        ...(s.zeroLevel === undefined ? {} : { zeroLevel: s.zeroLevel }),
        mpos: [s.mpos[0], s.mpos[1], s.mpos[2]],
      }),
    )
    // laid once when the dialog opens: the stock does not follow later G54 changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtual, layKey, store])

  const axes = (['x', 'y'] as const).filter((a) => pick[a === 'x' ? 0 : 1] !== 0)
  const sideOf = (a: 'x' | 'y') => pick[a === 'x' ? 0 : 1] as Side
  const what = m.picks[key(pick)]!.replace(/ \(.*\)$/, '').toLowerCase()

  const ball = probe.kind === '3d'
  const typedD = parseGoToField(diaText, units)
  const diameter = ball ? probe.tipDiameter : typedD
  const feeler = parseGoToField(feelerText, units)
  const values = valueTexts.map((t) => parseGoToField(t, units))
  const validD = diameter !== undefined && diameter >= 0
  // the virtual stock closes the probe input while the bit (this Ø) touches it, in the touch step
  const touchD = virtual && method === 'touch' && validD ? diameter : undefined
  useEffect(() => {
    if (touchD === undefined) return
    void store.getState().setVirtualTouch(true, touchD)
    return () => void store.getState().setVirtualTouch(false)
  }, [touchD, store])

  // the routine and its guard (each probe to its full distance)
  const routine: ProbeRoutine =
    axes.length === 2
      ? { cycle: 'corner', corner: [sideOf('x'), sideOf('y')] }
      : { cycle: 'edge', axis: axes[0]!, side: sideOf(axes[0]!) }
  const reach = probe.kind === 'xyzPlate' ? (probe.plateSize ?? 50) : ROUTINE_DEFAULTS.reach
  const spec: ProbeRoutineSpec = {
    routine,
    probe: {
      kind: probe.kind,
      tipDiameter: diameter ?? 0,
      ...(probe.plateThickness === undefined ? {} : { plateThickness: probe.plateThickness }),
      ...(probe.wallOffset === undefined ? {} : { wallOffset: probe.wallOffset }),
    },
    reach,
    zDistance: ROUTINE_DEFAULTS.zDistance,
    depth: ROUTINE_DEFAULTS.depth,
    clearance: probe.retract ?? ROUTINE_DEFAULTS.clearance,
    fastFeed: probe.fastFeed ?? ROUTINE_DEFAULTS.fastFeed,
    slowFeed: probe.slowFeed ?? ROUTINE_DEFAULTS.slowFeed,
    moveFeed: ROUTINE_DEFAULTS.moveFeed,
  }
  const from: Vec3 = [status.mpos[0], status.mpos[1], status.mpos[2]]
  const path = method === 'probe' && measured === undefined ? routinePath(spec, from) : []
  const guard = useMoveGuard(from, path)
  const steps: GoToStep[] = path.map((to, i) => {
    const a = i === 0 ? from : path[i - 1]!
    return { to, axis: a[0] === to[0] && a[1] === to[1] ? 'z' : 'xy' }
  })

  const gates = runGates(status, { planChosen: plan !== undefined })
  const gate =
    gates.workZero ??
    (activeJob(status) !== undefined ? m.gate.running : status.spindle > 0 ? m.gate.spindle : null)
  const probeWhy =
    gate ??
    (!canProbe
      ? m.probeKindNo
      : !plateReady
        ? m.probeGeometryNo
        : !validD
          ? m.gate.invalid
          : !probeOk
            ? runMessages.why.probeCheck
            : null)
  const canProbeNow = probeWhy === null && !busy && mayGo(guard, anyway)
  const touchedAll = axes.every((a) => touches[a] !== undefined)
  const touchWhy =
    gate ??
    (!validD || feeler === undefined ? m.gate.invalid : touchedAll ? null : m.gate.touchFirst)

  const doProbe = async () => {
    if (!canProbeNow) return
    const r = await store.getState().probeRoutine({
      routine,
      probe: spec.probe,
      reach,
      clearance: spec.clearance,
      fastFeed: spec.fastFeed,
      slowFeed: spec.slowFeed,
      ...(probe.plateSize === undefined ? {} : { plateSize: probe.plateSize }),
    })
    if (r === undefined) return
    setMeasured({
      ...(r.x === undefined ? {} : { x: r.x }),
      ...(r.y === undefined ? {} : { y: r.y }),
    })
  }
  const review = () => {
    if (touchWhy !== null || diameter === undefined || feeler === undefined) return
    const res = (units === 'inch' ? 0.0254 : 0.001) / 2
    const edge = (a: 'x' | 'y'): ProbedValue => ({
      value: touchedEdge(touches[a]!, sideOf(a), diameter, feeler),
      uncertainty: res,
    })
    setMeasured({
      ...(pick[0] === 0 ? {} : { x: edge('x') }),
      ...(pick[1] === 0 ? {} : { y: edge('y') }),
    })
  }

  // the new zero per picked axis: the measured edge gets the plan's (or the entered) coordinate
  const wcsOf = (a: 'x' | 'y'): number | undefined =>
    stock === undefined ? values[a === 'x' ? 0 : 1] : planEdge(stock, a, sideOf(a))
  const g54 = { x: undefined as number | undefined, y: undefined as number | undefined }
  for (const a of axes) {
    const e = measured?.[a]
    const w = wcsOf(a)
    if (e !== undefined && w !== undefined) g54[a] = g54For(e.value, w)
  }
  const setZero = async () => {
    const ok = await store.getState().setXyZero({
      ...(g54.x === undefined ? {} : { x: g54.x }),
      ...(g54.y === undefined ? {} : { y: g54.y }),
    })
    if (ok) store.getState().setXyZeroOpen(false)
  }
  const canSet =
    gates.workZero === null && axes.every((a) => g54[a] !== undefined) && axes.length > 0
  const f = (mm: number) => formatLength(mm, units)
  const signed = (mm: number) => (mm >= 0 ? `+${f(mm)}` : f(mm))
  const touching = status.pins?.includes('P') === true

  const changePick = (p: Pick) => {
    setPick(p)
    setTouches({})
    setMeasured(undefined)
  }
  const close = () => store.getState().setXyZeroOpen(false)

  const zeroRing =
    stock === undefined
      ? undefined
      : {
          // the ring may lie off the stock: the picture keeps a margin of a quarter each side
          left: `${12.5 + 75 * Math.min(1.1667, Math.max(-0.1667, stock.zero[0] / stock.length))}%`,
          bottom: `${12.5 + 75 * Math.min(1.1667, Math.max(-0.1667, stock.zero[1] / stock.width))}%`,
        }
  const aspect = stock === undefined ? 1 : Math.min(2.5, Math.max(0.6, stock.length / stock.width))

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
          <Button onClick={measured === undefined ? close : () => setMeasured(undefined)}>
            {measured === undefined ? m.cancel : m.back}
          </Button>
          {measured !== undefined ? (
            <Button
              variant="primary"
              icon={<Icon name="check" />}
              disabled={!canSet}
              onClick={() => void setZero()}
            >
              {m.set}
            </Button>
          ) : method === 'probe' ? (
            <Button
              variant="primary"
              icon={<Icon name="jog" />}
              disabled={!canProbeNow}
              aria-describedby={`${guard.finding === undefined ? '' : `${ids.finding} `}${ids.why}`}
              onClick={() => void doProbe()}
            >
              {busy ? m.probing : m.probeGo}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Icon name="check" />}
              disabled={touchWhy !== null}
              aria-describedby={ids.why}
              onClick={review}
            >
              {m.review}
            </Button>
          )}
        </RunDialogFooter>
      }
    >
      <div className={styles['xyZero']} data-xy-zero="">
        {measured === undefined ? (
          <>
            <div
              className={styles['xyZeroPicture']}
              style={{ aspectRatio: `${aspect}` }}
              role="radiogroup"
              aria-label={m.pick}
            >
              <div className={styles['xyZeroStock']} aria-hidden="true" />
              {zeroRing === undefined ? null : (
                <span
                  className={styles['xyZeroRing']}
                  style={zeroRing}
                  aria-hidden="true"
                  data-plan-zero=""
                />
              )}
              {PICKS.map((p) => {
                const on = key(p) === key(pick)
                return (
                  <button
                    key={key(p)}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={m.picks[key(p)]}
                    tabIndex={on ? 0 : -1}
                    className={styles['xyZeroPick']}
                    data-pick={key(p)}
                    style={{
                      left: `${12.5 + 37.5 * (p[0] + 1)}%`,
                      bottom: `${12.5 + 37.5 * (p[1] + 1)}%`,
                    }}
                    disabled={busy}
                    onClick={() => changePick(p)}
                    onKeyDown={(e) => {
                      const i = PICKS.findIndex((q) => key(q) === key(pick))
                      const d =
                        e.key === 'ArrowRight' || e.key === 'ArrowDown'
                          ? 1
                          : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                            ? -1
                            : 0
                      if (d === 0) return
                      e.preventDefault()
                      const next = PICKS[(i + d + PICKS.length) % PICKS.length]!
                      changePick(next)
                      const el = e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
                        `[data-pick="${key(next)}"]`,
                      )
                      el?.focus()
                    }}
                  />
                )
              })}
            </div>
            <p className={styles['hint']}>
              {m.picks[key(pick)]}
              {' · '}
              {stock === undefined
                ? m.noPlan
                : zc !== undefined && zc.on && key(zc.corner) === key(pick)
                  ? m.zeroOn
                  : m.zeroNear}
            </p>
            {stock === undefined ? (
              <div className={styles['goToFields']}>
                {axes.map((a) => (
                  <Field key={a} label={m.edgeIs(a.toUpperCase())}>
                    <FieldInput
                      unit={unit}
                      inputMode="decimal"
                      value={valueTexts[a === 'x' ? 0 : 1]}
                      onChange={(e) =>
                        setValueTexts(
                          a === 'x'
                            ? [e.target.value, valueTexts[1]]
                            : [valueTexts[0], e.target.value],
                        )
                      }
                    />
                  </Field>
                ))}
              </div>
            ) : null}
            <SegmentedControl<Method>
              label={m.method}
              size="sm"
              options={[
                { value: 'probe', label: m.probe, disabled: !canProbe },
                { value: 'touch', label: m.touch },
              ]}
              value={method}
              onValueChange={(v) => {
                setMethod(v)
                setTouches({})
              }}
              disabled={busy}
            />
            {!canProbe ? <p className={styles['hint']}>{m.probeKindNo}</p> : null}
            {ball ? (
              <p className={styles['hint']}>
                {m.ball(probe.tipDiameter === undefined ? '–' : f(probe.tipDiameter), unit)}
              </p>
            ) : (
              <Field
                label={m.bit}
                messages={
                  typedD === undefined
                    ? [{ id: 'invalid', severity: 'error', text: m.gate.invalid }]
                    : []
                }
              >
                <FieldInput
                  unit={unit}
                  inputMode="decimal"
                  value={diaText}
                  readOnly={busy}
                  onChange={(e) => setDiaText(e.target.value)}
                />
              </Field>
            )}
            {ball ? null : (
              <p className={styles['hint']}>
                {wh?.tool === undefined ? m.bitEnter : m.bitFromSpindle(wh.tool.n)}
              </p>
            )}
            {method === 'probe' ? (
              <>
                {canProbe ? (
                  <p className={styles['hint']}>
                    {m.probeSteps(what, probe.kind as 'xyzPlate' | 'tool' | '3d', f(reach), unit)}{' '}
                    {m.spindleOff}
                  </p>
                ) : null}
                {/* DF143: the probe input live, and the probe check before the first probe */}
                {canProbe ? <ProbeInput doc={doc} /> : null}
                {guard.finding === undefined ? null : (
                  <MoveGuardFinding
                    id={ids.finding}
                    text={findingText(
                      guard.finding,
                      from,
                      steps,
                      (mm) => f(mm),
                      (mm) => lengthSource(mm, units),
                    )}
                    guard={guard}
                    anyway={anyway}
                    onAnyway={setAnyway}
                    disabled={busy}
                  />
                )}
              </>
            ) : (
              <>
                <p className={styles['hint']}>{m.touchSteps(what)}</p>
                <Field label={m.feeler} info={m.feelerHint}>
                  <FieldInput
                    unit={unit}
                    inputMode="decimal"
                    value={feelerText}
                    onChange={(e) => setFeelerText(e.target.value)}
                  />
                </Field>
                <JogPad controls={jog} disabledReason={gates.jog} reasonId={ids.jog} />
                <p className={styles['hint']} role="status" data-touch-readout="">
                  {m.input(touching)}
                </p>
                <div className={styles['buttons']}>
                  {axes.map((a) => (
                    <Button
                      key={a}
                      size="sm"
                      disabled={gate !== null}
                      onClick={() =>
                        setTouches({
                          ...touches,
                          [a]: store.getState().status.mpos[a === 'x' ? 0 : 1],
                        })
                      }
                    >
                      {m.touching(edgeName(a, sideOf(a)))}
                    </Button>
                  ))}
                </div>
                {axes.map((a) =>
                  touches[a] === undefined ? null : (
                    <p key={a} className={styles['hint']}>
                      {m.touched(edgeName(a, sideOf(a)), f(touches[a]), unit)}
                    </p>
                  ),
                )}
              </>
            )}
            <p id={ids.why} className={styles['why']} role="status">
              {busy ? m.probing : method === 'probe' ? (probeWhy ?? '') : (touchWhy ?? '')}
            </p>
            {actionError !== undefined && !busy ? (
              <p className={styles['why']}>{actionError.message}</p>
            ) : null}
          </>
        ) : (
          <>
            <p className={styles['sectionLabel']}>{m.measured}</p>
            <ul className={styles['xyZeroList']}>
              {axes.map((a) =>
                measured[a] === undefined ? null : (
                  <li key={a}>
                    {m.edge(
                      edgeName(a, sideOf(a)),
                      f(measured[a].value),
                      formatLength(measured[a].uncertainty, units),
                      unit,
                    )}
                  </li>
                ),
              )}
            </ul>
            {ball || diameter === undefined ? null : (
              <p className={styles['hint']}>{m.radiusNote(f(diameter), unit)}</p>
            )}
            <p className={styles['sectionLabel']}>{m.newZero}</p>
            <ul className={styles['xyZeroList']} data-new-zero="">
              {axes.map((a) => {
                const to = g54[a]
                const was = status.workZero[a === 'x' ? 0 : 1]
                return to === undefined ? null : (
                  <li key={a}>
                    {m.change(a.toUpperCase(), f(was), f(to), signed(to - was), unit)}
                  </li>
                )
              })}
            </ul>
            <p className={styles['why']} role="status">
              {gates.workZero ?? ''}
            </p>
          </>
        )}
      </div>
    </Dialog>
  )
}
