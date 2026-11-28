// Check alignment (v0.5 RV6, Q226): after the X/Y zero, is the stock square to the axes? The
// Pointer moves the bit to stops on the stock outline offset outward by a gap, at a height above
// the top (corners, both ends of each edge, a perimeter trace corner to corner, or both), one
// guarded jog sequence per press (Next/Previous, Continue), so the operator compares the gap at
// each stop; Measure (the bit on a conductive stock or a 3D probe) probes one edge at two points
// and says the angle and how far to nudge which corner. Nothing is rotated or written (Q65). The
// stock is the plan setup's, or entered without a plan. Moves are jogs: the footer's Stop, Escape
// and Close cancel them; the workholding guard checks every move before it is sent.
// Doc: docs/modes/alignment.md#check-alignment-rv6
import { useEffect, useId, useRef, useState } from 'react'
import type { ProjectDoc } from '../../../../core/project/document'
import {
  CHECK_DEFAULTS,
  checkMoves,
  checkStops,
  edgeAngle,
  measureStarts,
  pointerProblem,
  stopKey,
  type CheckPattern,
  type CheckStep,
  type CheckStop,
  type EdgeAngle,
  type EdgePoint,
  type MeasureEdge,
} from '../../../../core/run/check-alignment'
import { goToMoves, goToSafeZ, type GoToStep, type Vec3 } from '../../../../core/run/goto'
import {
  ROUTINE_DEFAULTS,
  routinePath,
  type ProbeRoutineSpec,
} from '../../../../core/run/probe-routines'
import type { RunStatus } from '../../../../core/run/service'
import { virtualStockBox, type PlanStock, type Side } from '../../../../core/run/xy-zero'
import { lengthSource } from '../../messages/dfm'
import { runMessages } from '../../messages/run'
import { Button, Dialog, Field, FieldInput, Icon, SegmentedControl } from '../../ui'
import { useLibraryItems } from '../plan/usePlan'
import { parseGoToField, wcoOf } from './GoToDialog'
import { useJogControls, useMachineJog } from './JogPad'
import { formatFeed, formatLength, goToGate } from './machine-state'
import { findingText, mayGo, MoveGuardFinding, useGoAnyway, useMoveGuard } from './MoveGuardFinding'
import { machineProbe, planRunInfo, setupClearance, setupPlacement, setupStock } from './plan-info'
import { NO_PLAN, useRun, useRunStore, useRunUnits, type RunStore } from './run-store'
import { RunDialogFooter } from './RunStop'
import { useRunWorkholding } from './useRunWorkholding'
import styles from './Run.module.css'

const m = runMessages.checkAlign
type View = 'pointer' | 'measure'
/** The kinds Measure can probe an edge with at two points (a plate sits on one spot). */
const MEASURE_KINDS = ['tool', '3d'] as const
const EDGES: readonly MeasureEdge[] = [
  { axis: 'y', side: -1 },
  { axis: 'y', side: 1 },
  { axis: 'x', side: -1 },
  { axis: 'x', side: 1 },
]
const ZERO_CORNERS: readonly (readonly [Side, Side])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
]
/** Within this (mm) of a move's end the machine is there. */
const AT_MM = 0.01
/** Measure starts this far (mm) above the stock top (within the routine's Z search). */
const MEASURE_ABOVE = 5
/** Under this (mm) the far end counts as square. */
const SQUARE_MM = 0.02

const edgeKey = (e: MeasureEdge) => `${e.axis}${e.side}`
const near = (a: readonly number[], b: readonly number[]) =>
  a.every((v, i) => Math.abs(v - b[i]!) <= AT_MM)

/** A stop's name ("front left corner", "front edge, left end"). */
export function stopName(stop: CheckStop): string {
  if (stop.kind === 'corner') return m.corners[`${stop.corner[0]},${stop.corner[1]}`]!.toLowerCase()
  const edge = m.edges[`${stop.edge.axis}${stop.edge.side}`]!.toLowerCase()
  return `${edge}, ${m.ends[stop.edge.axis][String(stop.end)]!}`
}

/**
 * Follows a sent jog sequence until the machine is Idle at `end` (true) or stops short of it: Idle
 * elsewhere after jogging, or any other state (false). `abort` ends the wait (false).
 */
function follow(store: RunStore, end: Vec3, abort: { current: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let sawJog = false
    const check = (s: RunStatus): boolean | undefined => {
      if (abort.current) return false
      if (s.state === 'Idle' && near(s.mpos, end)) return true
      if (s.state.startsWith('Jog')) sawJog = true
      else if (s.state !== 'Idle' || sawJog) return false
      return undefined
    }
    const unsub = store.subscribe((st, prev) => {
      if (st.status === prev.status && !abort.current) return
      const r = check(st.status)
      if (r === undefined) return
      unsub()
      resolve(r)
    })
  })
}

/** Mounted with the run dialogs; open while the run store's `checkAlignOpen` is set. */
export function CheckAlignmentDialog({
  doc,
}: {
  doc: ProjectDoc | undefined
}): React.JSX.Element | null {
  const open = useRun((s) => s.checkAlignOpen)
  return open ? <CheckOpen doc={doc} /> : null
}

type Walk =
  | { readonly kind: 'idle' }
  | { readonly kind: 'moving'; readonly to: number; readonly legs: number }
  | { readonly kind: 'at'; readonly at: number; readonly legs: number }
  | { readonly kind: 'stopped'; readonly at: Vec3 }

type Measure =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly point: number }
  | { readonly kind: 'failed' }
  | { readonly kind: 'done'; readonly points: readonly EdgePoint[]; readonly result: EdgeAngle }

function CheckOpen({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element {
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const setupId = useRun((s) => s.setupId)
  const machineId = useRun((s) => s.machineId)
  const probing = useRun((s) => s.probeJobId !== undefined)
  const actionError = useRun((s) => s.actionError)
  const machines = useLibraryItems('machine')
  const units = useRunUnits(doc)
  const unit = runMessages.dro.units[units]
  const controls = useJogControls(doc)
  const machine = useMachineJog(doc)
  const wh = useRunWorkholding()
  const ids = { why: useId(), finding: useId(), stops: useId() }
  const f = (mm: number) => formatLength(mm, units)

  const plan = planId === undefined || planId === NO_PLAN ? undefined : doc?.plans[planId]
  const placed = plan === undefined ? undefined : setupPlacement(plan, setupId, units)
  const planStock = setupStock(placed)
  const setupName =
    plan === undefined ? undefined : planRunInfo(plan, setupId).setup.name.toLowerCase()
  const probe = machineProbe(plan, machines, machineId)
  const canMeasure = (MEASURE_KINDS as readonly string[]).includes(probe.kind)

  // the stock: the plan's, or entered (length, width and the corner the work zero is on)
  const [sizeTexts, setSizeTexts] = useState<readonly [string, string]>(() => [
    formatLength(100, units),
    formatLength(100, units),
  ])
  const [zeroAt, setZeroAt] = useState('-1,-1')
  const entered = sizeTexts.map((t) => parseGoToField(t, units))
  const stock: PlanStock | undefined =
    planStock ??
    (entered.every((v) => v !== undefined && v > 0)
      ? (() => {
          const [l, w] = entered as [number, number]
          const [sx, sy] = zeroAt.split(',').map(Number) as [number, number]
          return {
            length: l,
            width: w,
            thickness: Infinity,
            zero: [sx < 0 ? 0 : l, sy < 0 ? 0 : w],
          }
        })()
      : undefined)

  const [view, setView] = useState<View>('pointer')
  const [pattern, setPattern] = useState<CheckPattern>('corners')
  const [gapText, setGapText] = useState(() => formatLength(CHECK_DEFAULTS.gap, units))
  const [heightText, setHeightText] = useState(() => formatLength(CHECK_DEFAULTS.height, units))
  const gap = parseGoToField(gapText, units)
  const height = parseGoToField(heightText, units)
  const spindleD = wh?.tool?.tool.diameter.canonical
  const [diaText, setDiaText] = useState(() =>
    spindleD === undefined ? '' : formatLength(spindleD, units),
  )
  const typedD = parseGoToField(diaText, units)
  const diameter = probe.kind === '3d' ? probe.tipDiameter : typedD
  const validD = diameter !== undefined && diameter >= 0
  const [walk, setWalk] = useState<Walk>({ kind: 'idle' })
  const [measure, setMeasure] = useState<Measure>({ kind: 'idle' })
  const [edge, setEdge] = useState<MeasureEdge>(EDGES[0]!)
  const abort = useRef(false)
  useEffect(
    () => () => {
      abort.current = true
    },
    [],
  )

  // the virtual operator lays the stock once per connection and setup (as Set X/Y zero does)
  const virtual = status.connection.target === 'virtual'
  const layKey = `${planId ?? ''}:${setupId ?? ''}`
  useEffect(() => {
    if (!virtual || stock === undefined) return
    const s = store.getState().status
    void store.getState().layVirtualStock(
      layKey,
      virtualStockBox(stock.thickness === Infinity ? { ...stock, thickness: 20 } : stock, {
        workZero: [s.workZero[0], s.workZero[1], s.workZero[2]],
        ...(s.zeroLevel === undefined ? {} : { zeroLevel: s.zeroLevel }),
        mpos: [s.mpos[0], s.mpos[1], s.mpos[2]],
      }),
    )
    // laid once when the dialog opens: the stock does not follow later G54 changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtual, layKey, store])

  const feed = {
    trace: CHECK_DEFAULTS.traceFeed,
    xy: controls.feed,
    z: machine.maxZ === undefined ? controls.feed : Math.min(controls.feed, machine.maxZ),
  }
  const feedOf = (s: CheckStep | GoToStep): number =>
    'feed' in s && s.feed === 'trace' ? feed.trace : s.axis === 'z' ? feed.z : feed.xy
  const clearance = plan === undefined ? undefined : setupClearance(plan, setupId)
  const wco = wcoOf(status)
  const safeZOf = (s: RunStatus) =>
    goToSafeZ({ wcoZ: wcoOf(s)[2], zeroLevel: s.zeroLevel, clearance, envelope: s.envelope })
  const from: Vec3 = [status.mpos[0], status.mpos[1], status.mpos[2]]
  const gate = goToGate(status)

  // ── Pointer ────────────────────────────────────────────────────────────────────────────────
  const problem =
    stock === undefined || gap === undefined || height === undefined
      ? 'invalid'
      : pointerProblem({
          height,
          gap,
          toolDiameter: validD ? diameter : 0,
          thickness: stock.thickness,
        })
  const stops = stock === undefined || gap === undefined ? [] : checkStops(stock, pattern, gap)
  const perimeter = pattern === 'perimeter'
  const atIndex = walk.kind === 'at' ? walk.at : undefined
  const legs = walk.kind === 'at' ? walk.legs : 0
  const traceDone = perimeter && atIndex !== undefined && legs >= stops.length
  /** The next move: to the first stop, or one along (dir) from the stop the walk is at. */
  const plannedMove = (
    dir: 1 | -1,
    s: RunStatus,
  ): { to: number; steps: CheckStep[] } | undefined => {
    if (stock === undefined || gap === undefined || height === undefined || problem !== undefined)
      return undefined
    if (stops.length === 0) return undefined
    const n = stops.length
    const to = atIndex === undefined ? 0 : (atIndex + dir + n) % n
    const r = checkMoves({
      from: [s.mpos[0], s.mpos[1], s.mpos[2]],
      wco: wcoOf(s),
      zeroLevel: s.zeroLevel,
      stock,
      gap,
      height,
      safeZ: safeZOf(s),
      fromStop: atIndex === undefined ? undefined : stops[atIndex],
      to: stops[to]!,
      dir,
      envelope: s.envelope,
    })
    return r.isOk() ? { to, steps: r.unwrap() } : undefined
  }
  const nextMove = view === 'pointer' ? plannedMove(1, status) : undefined
  const travelWhy =
    view === 'pointer' && problem === undefined && stops.length > 0 && nextMove === undefined
      ? m.travel
      : undefined

  // ── Measure ────────────────────────────────────────────────────────────────────────────────
  const top = stock === undefined ? undefined : wco[2] - (status.zeroLevel ?? 0)
  const starts =
    stock === undefined || top === undefined
      ? undefined
      : measureStarts(stock, edge).map(
          ([x, y]) => [x + wco[0], y + wco[1], top + MEASURE_ABOVE] as Vec3,
        )
  const spec: ProbeRoutineSpec = {
    routine: { cycle: 'edge', axis: edge.axis, side: edge.side },
    probe: { kind: probe.kind, tipDiameter: diameter ?? 0 },
    reach: ROUTINE_DEFAULTS.reach,
    zDistance: ROUTINE_DEFAULTS.zDistance,
    depth: ROUTINE_DEFAULTS.depth,
    clearance: probe.retract ?? ROUTINE_DEFAULTS.clearance,
    fastFeed: probe.fastFeed ?? ROUTINE_DEFAULTS.fastFeed,
    slowFeed: probe.slowFeed ?? ROUTINE_DEFAULTS.slowFeed,
    moveFeed: ROUTINE_DEFAULTS.moveFeed,
  }
  const measureMoves = (s: Vec3, to: Vec3, safeZ: number) =>
    goToMoves({
      from: s,
      wco,
      target: to,
      frame: 'machine',
      mode: 'absolute',
      safeZ,
      liftToTop: false,
      envelope: status.envelope,
    })
  // the whole measure path for the guard: to A, A's routine, A to B, B's routine
  const measurePath: Vec3[] = (() => {
    if (view !== 'measure' || starts === undefined || !canMeasure || measure.kind === 'running')
      return []
    const safeZ = safeZOf(status)
    const toA = measureMoves(from, starts[0]!, safeZ)
    const toB = measureMoves(starts[0]!, starts[1]!, safeZ)
    if (toA.isErr() || toB.isErr()) return []
    return [
      ...toA.unwrap().map((s) => s.to),
      ...routinePath(spec, starts[0]!),
      ...toB.unwrap().map((s) => s.to),
      ...routinePath(spec, starts[1]!),
    ]
  })()

  // the guard over the move a press would make; "Go anyway" is for that very move
  const guardTos = view === 'pointer' ? (nextMove?.steps.map((s) => s.to) ?? []) : measurePath
  const guard = useMoveGuard(from, guardTos)
  const [anyway, setAnyway] = useGoAnyway(JSON.stringify([view, from, ...guardTos]))
  const guardSteps: GoToStep[] = guardTos.map((to, i) => {
    const a = i === 0 ? from : guardTos[i - 1]!
    return { to, axis: a[0] === to[0] && a[1] === to[1] ? 'z' : 'xy' }
  })

  // the next pointer move drawn in the 3D view (Go to's dashed path), by value
  const previewKey =
    view === 'pointer' &&
    nextMove !== undefined &&
    nextMove.steps.length > 0 &&
    walk.kind !== 'moving'
      ? JSON.stringify([from, ...nextMove.steps.map((s) => s.to)])
      : ''
  useEffect(() => {
    const pts = previewKey === '' ? [] : (JSON.parse(previewKey) as Vec3[])
    store
      .getState()
      .setGoToPreview(pts.length < 2 ? undefined : { from: pts[0]!, points: pts.slice(1) })
  }, [previewKey, store])
  useEffect(() => () => store.getState().setGoToPreview(undefined), [store])

  const moving = walk.kind === 'moving' || measure.kind === 'running' || probing
  const pointerWhy =
    gate ??
    (problem === 'invalid'
      ? m.problem.invalid
      : problem === 'sideTouches'
        ? m.problem.sideTouches(f((diameter ?? 0) / 2 + CHECK_DEFAULTS.sideClearance), unit)
        : problem !== undefined
          ? m.problem[problem]
          : (travelWhy ?? null))
  const canMove = !moving && pointerWhy === null && nextMove !== undefined && mayGo(guard, anyway)
  const measureWhy =
    gate ??
    (!canMeasure
      ? m.measureNo
      : !validD
        ? m.gate.invalid
        : stock === undefined
          ? m.problem.invalid
          : null)
  const canMeasureNow =
    !moving && measureWhy === null && measurePath.length > 0 && mayGo(guard, anyway)

  // the finding and "Go anyway" are Next's (the shown move); Previous goes through the store's
  // own guard check, which refuses a blocked move with the jog notice
  const go = async (dir: 1 | -1) => {
    if (dir > 0 ? !canMove : moving || pointerWhy !== null) return
    const s = store.getState().status
    const mv = plannedMove(dir, s)
    if (mv === undefined) return
    const legsNow = atIndex === undefined || traceDone ? 0 : legs
    const leg = atIndex === undefined ? 0 : 1
    if (mv.steps.length === 0) {
      setWalk({ kind: 'at', at: mv.to, legs: legsNow + leg })
      return
    }
    setWalk({ kind: 'moving', to: mv.to, legs: legsNow })
    const sent = await store.getState().moveTo(
      mv.steps.map((x) => ({ to: x.to, feed: feedOf(x) })),
      { anyway: dir > 0 && anyway },
    )
    const arrived = sent && (await follow(store, mv.steps[mv.steps.length - 1]!.to, abort))
    if (abort.current) return
    const now = store.getState().status
    setWalk(
      arrived
        ? {
            kind: 'at',
            at: mv.to,
            legs: legsNow + leg,
          }
        : { kind: 'stopped', at: [now.wpos[0], now.wpos[1], now.wpos[2]] },
    )
  }

  const doMeasure = async () => {
    if (!canMeasureNow || starts === undefined || stock === undefined) return
    const points: EdgePoint[] = []
    for (const [i, start] of starts.entries()) {
      setMeasure({ kind: 'running', point: i + 1 })
      const s = store.getState().status
      const moves = goToMoves({
        from: [s.mpos[0], s.mpos[1], s.mpos[2]],
        wco: wcoOf(s),
        target: start,
        frame: 'machine',
        mode: 'absolute',
        safeZ: safeZOf(s),
        liftToTop: false,
        envelope: s.envelope,
      })
      if (moves.isErr()) return setMeasure({ kind: 'failed' })
      const steps = moves.unwrap()
      if (steps.length > 0) {
        const sent = await store.getState().moveTo(
          steps.map((x) => ({ to: x.to, feed: feedOf(x) })),
          { anyway: true },
        )
        const arrived = sent && (await follow(store, steps[steps.length - 1]!.to, abort))
        if (abort.current) return
        if (!arrived) return setMeasure({ kind: 'failed' })
      }
      const r = await store.getState().probeRoutine({
        routine: spec.routine,
        probe: spec.probe,
        reach: spec.reach,
        clearance: spec.clearance,
        fastFeed: spec.fastFeed,
        slowFeed: spec.slowFeed,
      })
      if (abort.current) return
      const v = edge.axis === 'y' ? r?.y : r?.x
      if (r === undefined || v === undefined) return setMeasure({ kind: 'failed' })
      points.push({
        along: edge.axis === 'y' ? r.start[0] : r.start[1],
        value: v.value,
        uncertainty: v.uncertainty,
      })
    }
    setMeasure({ kind: 'done', points, result: edgeAngle(stock, edge, points[0]!, points[1]!) })
  }

  const close = () => {
    if (walk.kind === 'moving') void store.getState().jogCancel()
    store.getState().setCheckAlignOpen(false)
  }

  // ── Texts ──────────────────────────────────────────────────────────────────────────────────
  const at = atIndex === undefined ? undefined : stops[atIndex]
  const statusText =
    walk.kind === 'moving'
      ? m.moving(stops[walk.to] === undefined ? '' : stopName(stops[walk.to]!))
      : walk.kind === 'stopped'
        ? m.stopped(f(walk.at[0]), f(walk.at[1]), f(walk.at[2]), unit)
        : traceDone
          ? m.traceDone
          : at !== undefined
            ? m.at(stopName(at), atIndex! + 1, stops.length)
            : ''
  const primaryLabel =
    atIndex === undefined || walk.kind === 'stopped'
      ? perimeter
        ? m.startTrace
        : m.start
      : perimeter
        ? traceDone
          ? m.again
          : m.continue
        : m.next
  const res = measure.kind === 'done' ? measure.result : undefined
  const cornerName = (c: readonly [Side, Side]) => m.corners[`${c[0]},${c[1]}`]!.toLowerCase()
  const between =
    starts === undefined
      ? '–'
      : f(Math.hypot(starts[1]![0] - starts[0]![0], starts[1]![1] - starts[0]![1]))
  const finding =
    guard.finding === undefined
      ? undefined
      : findingText(
          guard.finding,
          from,
          guardSteps,
          (mm, axis) => f(mm - wco[axis]!),
          (mm) => lengthSource(mm, units),
        )

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
          {view === 'pointer' ? (
            <>
              {perimeter || atIndex === undefined ? null : (
                <Button disabled={moving || pointerWhy !== null} onClick={() => void go(-1)}>
                  {m.previous}
                </Button>
              )}
              <Button
                variant="primary"
                icon={<Icon name="jog" />}
                disabled={!canMove}
                aria-describedby={`${finding === undefined ? '' : `${ids.finding} `}${ids.why}`}
                onClick={() => void go(1)}
              >
                {primaryLabel}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              icon={<Icon name="jog" />}
              disabled={!canMeasureNow}
              aria-describedby={`${finding === undefined ? '' : `${ids.finding} `}${ids.why}`}
              onClick={() => void doMeasure()}
            >
              {measure.kind === 'done' ? m.again2 : m.measureGo}
            </Button>
          )}
        </RunDialogFooter>
      }
    >
      <div className={styles['xyZero']} data-check-align="">
        {planStock !== undefined && setupName !== undefined ? (
          <p className={styles['hint']}>
            {m.stockPlan(f(planStock.length), f(planStock.width), unit, setupName)}
          </p>
        ) : (
          <>
            <p className={styles['hint']}>{m.noPlan}</p>
            <div className={styles['goToFields']}>
              {([m.length, m.width] as const).map((label, i) => (
                <Field key={label} label={label}>
                  <FieldInput
                    unit={unit}
                    inputMode="decimal"
                    value={sizeTexts[i]}
                    readOnly={moving}
                    onChange={(e) =>
                      setSizeTexts(
                        i === 0 ? [e.target.value, sizeTexts[1]] : [sizeTexts[0], e.target.value],
                      )
                    }
                  />
                </Field>
              ))}
            </div>
            <SegmentedControl<string>
              label={m.zeroAt}
              size="sm"
              options={ZERO_CORNERS.map((c) => ({
                value: `${c[0]},${c[1]}`,
                label: m.zeroCorners[`${c[0]},${c[1]}`]!,
              }))}
              value={zeroAt}
              onValueChange={(v) => {
                setZeroAt(v)
                setWalk({ kind: 'idle' })
              }}
              disabled={moving}
            />
          </>
        )}
        <SegmentedControl<View>
          label={m.view}
          size="sm"
          options={[
            { value: 'pointer', label: m.pointer },
            { value: 'measure', label: m.measure },
          ]}
          value={view}
          onValueChange={setView}
          disabled={moving}
        />
        {view === 'pointer' ? (
          <>
            <SegmentedControl<CheckPattern>
              label={m.pattern}
              size="sm"
              options={(['corners', 'edges', 'perimeter', 'both'] as const).map((p) => ({
                value: p,
                label: m.patterns[p],
              }))}
              value={pattern}
              onValueChange={(p) => {
                setPattern(p)
                setWalk({ kind: 'idle' })
              }}
              disabled={moving}
            />
            <div className={styles['goToFields']}>
              <Field label={m.gap} info={m.gapHint}>
                <FieldInput
                  unit={unit}
                  inputMode="decimal"
                  value={gapText}
                  readOnly={moving}
                  onChange={(e) => {
                    setGapText(e.target.value)
                    setWalk({ kind: 'idle' })
                  }}
                />
              </Field>
              <Field label={m.height} info={m.heightHint}>
                <FieldInput
                  unit={unit}
                  inputMode="decimal"
                  value={heightText}
                  readOnly={moving}
                  onChange={(e) => setHeightText(e.target.value)}
                />
              </Field>
            </div>
            {probe.kind === '3d' ? null : (
              <Field label={runMessages.xyZero.bit}>
                <FieldInput
                  unit={unit}
                  inputMode="decimal"
                  value={diaText}
                  readOnly={moving}
                  onChange={(e) => setDiaText(e.target.value)}
                />
              </Field>
            )}
            <p className={styles['hint']}>
              {m.pointerSteps(gapText.trim(), heightText.trim(), unit)} {m.spindleOff}{' '}
              {m.traceFeed(formatFeed(feed.trace, units), runMessages.dro.feedUnits[units])}
            </p>
            <p className={styles['sectionLabel']} id={ids.stops}>
              {m.stops}
            </p>
            <ol className={styles['xyZeroList']} aria-labelledby={ids.stops} data-check-stops="">
              {stops.map((st, i) => (
                <li
                  key={stopKey(st)}
                  {...(i === atIndex ? { 'aria-current': 'step' as const } : {})}
                  data-current={i === atIndex || undefined}
                >
                  {stopName(st).replace(/^./, (c) => c.toUpperCase())} ·{' '}
                  {m.stopAt(f(st.at[0]), f(st.at[1]))}
                </li>
              ))}
            </ol>
          </>
        ) : (
          <>
            <SegmentedControl<string>
              label={m.edge}
              size="sm"
              options={EDGES.map((e) => ({
                value: edgeKey(e),
                label: m.measureEdges[edgeKey(e)]!,
              }))}
              value={edgeKey(edge)}
              onValueChange={(k) => {
                setEdge(EDGES.find((e) => edgeKey(e) === k)!)
                setMeasure({ kind: 'idle' })
              }}
              disabled={moving}
            />
            {!canMeasure ? (
              <p className={styles['hint']}>{m.measureNo}</p>
            ) : (
              <>
                {probe.kind === '3d' ? (
                  <p className={styles['hint']}>
                    {runMessages.xyZero.ball(
                      probe.tipDiameter === undefined ? '–' : f(probe.tipDiameter),
                      unit,
                    )}
                  </p>
                ) : (
                  <Field label={runMessages.xyZero.bit}>
                    <FieldInput
                      unit={unit}
                      inputMode="decimal"
                      value={diaText}
                      readOnly={moving}
                      onChange={(e) => setDiaText(e.target.value)}
                    />
                  </Field>
                )}
                <p className={styles['hint']}>
                  {m.measureSteps(
                    m.measureEdges[edgeKey(edge)]!.replace(/ \(.*\)$/, '').toLowerCase(),
                    probe.kind as 'tool' | '3d',
                    between,
                    unit,
                  )}{' '}
                  {runMessages.xyZero.spindleOff.replace('Probe', 'Measure')}
                </p>
              </>
            )}
            {measure.kind === 'done' && res !== undefined ? (
              <div data-measure-result="">
                <p className={styles['sectionLabel']}>{m.points}</p>
                <ul className={styles['xyZeroList']}>
                  {measure.points.map((p, i) => (
                    <li key={i}>
                      {m.point(
                        i + 1,
                        edge.axis.toUpperCase(),
                        f(p.value),
                        edge.axis === 'y' ? 'X' : 'Y',
                        f(p.along),
                        formatLength(p.uncertainty, units),
                        unit,
                      )}
                    </li>
                  ))}
                </ul>
                <p data-measure-angle="">
                  {m.angle(
                    Math.abs(res.angle).toFixed(3),
                    Math.max(res.uncertainty, 0.001).toFixed(3),
                    res.angle >= 0,
                  )}
                </p>
                <p data-measure-nudge="">
                  {res.nudge < SQUARE_MM
                    ? m.square(f(SQUARE_MM), unit)
                    : m.nudge(
                        cornerName(res.keep),
                        cornerName(res.move),
                        f(res.nudge),
                        unit,
                        `${res.toward.axis.toUpperCase()}${res.toward.sign < 0 ? '−' : '+'}`,
                      )}
                </p>
                <p className={styles['hint']}>{m.after}</p>
              </div>
            ) : null}
          </>
        )}
        <MoveGuardFinding
          id={ids.finding}
          text={finding}
          guard={guard}
          anyway={anyway}
          onAnyway={setAnyway}
          disabled={moving}
        />
        <p id={ids.why} className={styles['why']} role="status" data-check-status="">
          {view === 'pointer'
            ? statusText || (pointerWhy ?? '')
            : measure.kind === 'running'
              ? m.measuring(measure.point)
              : measure.kind === 'failed'
                ? m.measureFailed
                : (measureWhy ?? '')}
        </p>
        {actionError !== undefined && !moving ? (
          <p className={styles['why']}>{actionError.message}</p>
        ) : null}
      </div>
    </Dialog>
  )
}
