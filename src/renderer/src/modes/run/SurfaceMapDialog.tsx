// Map stock surface (v0.5 RV10): a grid of heights on the setup's stock top (inset by a margin),
// as columns × rows or a spacing; points whose probe path meets workholding are skipped through
// the workholding guard; the points are probed in serpentine order, one `run.machine.surfacePoint`
// job each (travel height: the job's start Z, then the last contact plus the clearance), so a
// failure or a Stop keeps what was measured and "Retry from here" probes the rest. The heat map
// fills as each point ends; the map is saved per plan and setup (app settings `surfaceMaps`).
// v0.5 RV11: the same dialog in bed mode ("Map bed", from Machine settings): the work area (else
// the travel) in machine coordinates on a homed machine, no skipped points, a stickout field; the
// map is saved per library machine with what makes it stale (app settings `bedMaps`).
// Doc: docs/modes/run-surface.md#probing-a-map, docs/modes/run-surface.md#the-bed-map-rv11
import { useId, useMemo, useRef, useState } from 'react'
import type { HeightMap } from '../../../../core/post/height-map'
import type { ProjectDoc } from '../../../../core/project/document'
import { bedMapStamp } from '../../../../core/run/bed-map'
import { STOCK_TOP } from '../../../../core/run/jog-guard'
import {
  mapEstimateSeconds,
  pointsFor,
  serpentine,
  SURFACE_DEFAULTS,
  surfaceGrid,
} from '../../../../core/run/surface-probe'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { BedMapRecord, SurfaceMapRecord } from '../../../../shared/settings'
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
} from '../../ui'
import { useLibraryItems } from '../plan/usePlan'
import { formatLength, isConnected } from './machine-state'
import { machineProbe, runSetup, setupPlacement, setupStock } from './plan-info'
import { ProbeInput, useProbeCheck } from './ProbeInput'
import { guardActive, moveGuard, wcoOf } from './run-guard'
import { NO_PLAN, useRun, useRunStore, useRunUnits } from './run-store'
import { RunDialogFooter } from './RunStop'
import { SurfaceHeatMap } from './SurfaceHeatMap'
import { useBedMap } from './useBedMap'
import styles from './Run.module.css'

const m = runMessages.surface

/** `planId/setupId`: the key of a setup's map in app settings `surfaceMaps`. */
export const surfaceMapKey = (planId: string, setupId: string): string => `${planId}/${setupId}`

/** A saved map as `run.job.check`/`start`'s `surfaceMap` (with the follow limit). */
export function followArg(record: SurfaceMapRecord, maxRange: number): object {
  return {
    setupId: record.setupId,
    origin: record.origin,
    spacing: record.spacing,
    cols: record.cols,
    rows: record.rows,
    z: record.z,
    ...(record.skipped === undefined ? {} : { skipped: record.skipped }),
    workZero: record.workZero,
    maxRange,
  }
}

/**
 * Mounted with the run dialogs; open while the run store's `surfaceMapOpen` (a stock map) or
 * `bedMapOpen` (RV11: a bed map) is set.
 */
export function SurfaceMapDialog({
  doc,
}: {
  doc: ProjectDoc | undefined
}): React.JSX.Element | null {
  const stock = useRun((s) => s.surfaceMapOpen)
  const bed = useRun((s) => s.bedMapOpen)
  if (stock && doc !== undefined) return <SurfaceMapOpen doc={doc} mode="stock" />
  return bed ? <SurfaceMapOpen doc={doc} mode="bed" /> : null
}

type Layout = 'count' | 'spacing'

/** The map being taken: a stock map's record, or a bed map's grid and heights (machine Z). */
type Taken = Omit<SurfaceMapRecord, 'setupId' | 'workZero'> & {
  readonly workZero?: readonly [number, number]
}

const num = (text: string): number => (text.trim() === '' ? NaN : Number(text))

function SurfaceMapOpen({
  doc,
  mode,
}: {
  doc: ProjectDoc | undefined
  mode: 'stock' | 'bed'
}): React.JSX.Element {
  const { bridge } = useShell()
  const bedMode = mode === 'bed'
  const t = bedMode ? m.bed : m
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const chosenSetup = useRun((s) => s.setupId)
  const machineId = useRun((s) => s.machineId)
  const guardSetup = useRun((s) => s.guardSetup)
  const guardOff = useRun((s) => s.guardOff)
  const units = useRunUnits(doc)
  const unit = runMessages.dro.units[units]
  const f = (mm: number) => formatLength(mm, units)
  const machines = useLibraryItems('machine')
  const plan = planId === undefined || planId === NO_PLAN ? undefined : doc?.plans[planId]
  const setupId = plan === undefined ? undefined : runSetup(plan, chosenSetup).id
  const bed = useBedMap(doc)
  const repeat = useSettings((s) =>
    bed.key === undefined ? undefined : s.settings.homingRepeatability[bed.key],
  )
  const key = bedMode
    ? bed.key
    : plan === undefined || setupId === undefined
      ? undefined
      : surfaceMapKey(plan.id, setupId)
  const stock = useMemo(
    () => (plan === undefined ? undefined : setupStock(setupPlacement(plan, setupId, units))),
    [plan, setupId, units],
  )
  const probe = machineProbe(plan, machines, machineId)
  const probeOk = useProbeCheck(doc)
  const savedStock = useSettings((s) =>
    key === undefined || bedMode ? undefined : s.settings.surfaceMaps[key],
  )
  const saved: Taken | null | undefined = bedMode ? bed.record : savedStock
  const maxRange = useSettings((s) => s.settings.surfaceMapMaxRange)
  const update = useSettings((s) => s.update)

  const [layout, setLayout] = useState<Layout>('count')
  const [colsText, setColsText] = useState(String(SURFACE_DEFAULTS.cols))
  const [rowsText, setRowsText] = useState(String(SURFACE_DEFAULTS.rows))
  const [spacingText, setSpacingText] = useState('20')
  const [marginText, setMarginText] = useState(String(SURFACE_DEFAULTS.margin))
  const [clearanceText, setClearanceText] = useState(String(SURFACE_DEFAULTS.clearance))
  const [depthText, setDepthText] = useState(String(SURFACE_DEFAULTS.depth))
  const [stickoutText, setStickoutText] = useState(
    bed.record?.stickout !== undefined
      ? String(bed.record.stickout)
      : bed.stickout === undefined
        ? ''
        : String(bed.stickout),
  )
  // the map being taken (work Z per point; a bed map: machine Z); starts as the saved one
  const [taken, setTaken] = useState<Taken | undefined>(saved ?? undefined)
  const [busy, setBusy] = useState(false)
  const [jobId, setJobId] = useState<string | undefined>(undefined)
  const [failed, setFailed] = useState<number | undefined>(undefined)
  const [error, setError] = useState<AppErrorData | undefined>(undefined)
  const [stopped, setStopped] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const stopRef = useRef(false)
  const ids = { why: useId() }

  const margin = num(marginText)
  const clearance = num(clearanceText)
  const depth = num(depthText)
  const stickout = num(stickoutText)
  const env = status.envelope
  // RV11: the bed: the work area's bound (margin in), else the travel, in machine X/Y
  const bedBounds =
    env === undefined
      ? undefined
      : (env.workArea ?? {
          min: [-env.travel[0], -env.travel[1], -env.travel[2]] as const,
          max: [0, 0, 0] as const,
        })
  const area = bedMode
    ? bedBounds === undefined || !(margin >= 0)
      ? undefined
      : {
          min: [bedBounds.min[0] + margin, bedBounds.min[1] + margin] as const,
          max: [bedBounds.max[0] - margin, bedBounds.max[1] - margin] as const,
        }
    : stock === undefined || !(margin >= 0)
      ? undefined
      : {
          min: [-stock.zero[0] + margin, -stock.zero[1] + margin] as const,
          max: [
            stock.length - stock.zero[0] - margin,
            stock.width - stock.zero[1] - margin,
          ] as const,
        }
  const sides =
    area === undefined ? undefined : [area.max[0] - area.min[0], area.max[1] - area.min[1]]
  const spacing = num(spacingText)
  const counts =
    sides === undefined
      ? undefined
      : layout === 'count'
        ? [num(colsText), num(rowsText)]
        : spacing > 0
          ? [pointsFor(sides[0]!, spacing), pointsFor(sides[1]!, spacing)]
          : undefined
  const countOk = (n: number | undefined) =>
    n !== undefined &&
    Number.isInteger(n) &&
    n >= SURFACE_DEFAULTS.minPoints &&
    n <= SURFACE_DEFAULTS.maxPoints
  const inputError =
    sides === undefined || sides[0]! <= 0 || sides[1]! <= 0
      ? m.areaTooSmall
      : !countOk(counts?.[0]) || !countOk(counts?.[1])
        ? m.countRange(SURFACE_DEFAULTS.minPoints, SURFACE_DEFAULTS.maxPoints)
        : !(clearance > 0) || !(depth > 0)
          ? m.positive
          : bedMode && stickoutText.trim() !== '' && !(stickout > 0)
            ? m.bed.stickoutPositive
            : null
  const grid =
    inputError !== null || area === undefined || counts === undefined
      ? undefined
      : surfaceGrid(area.min, area.max, counts[0]!, counts[1]!)
  // points whose probe path (down the first point's search depth from the Z when the grid or the
  // guard changed) meets workholding; not recomputed as the machine moves while mapping
  const guardOn = guardActive(status, guardSetup, guardOff)
  const gridKey =
    grid === undefined
      ? ''
      : [...grid.origin, ...grid.spacing, grid.cols, grid.rows, ...status.workZero, guardOn].join()
  const skipped = useMemo(() => {
    const out = new Map<number, string>()
    const { status: st, guardSetup: gs } = store.getState()
    // a bed map has no setup to guard: the bed is cleared (run-surface.md#taking-it)
    if (grid === undefined || !guardOn || gs === undefined || bedMode) return out
    const w = wcoOf(st)
    const z = st.mpos[2]
    grid.points.forEach(([x, y], k) => {
      const at: [number, number, number] = [x + w[0], y + w[1], z]
      const hit = moveGuard(st, gs, at, [[at[0], at[1], z - SURFACE_DEFAULTS.firstDepth]])
      if (hit !== undefined && hit.hit.contact.itemId !== STOCK_TOP) out.set(k, hit.item)
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `gridKey` names the grid and guard
  }, [gridKey, store])
  const order =
    grid === undefined ? [] : serpentine(grid.cols, grid.rows).filter((k) => !skipped.has(k))
  const estimate =
    grid === undefined
      ? 0
      : mapEstimateSeconds(
          order.map((k) => grid.points[k]!),
          {
            clearance: clearance > 0 ? clearance : SURFACE_DEFAULTS.clearance,
            fastFeed: probe.fastFeed ?? SURFACE_DEFAULTS.fastFeed,
            slowFeed: probe.slowFeed ?? SURFACE_DEFAULTS.slowFeed,
            moveFeed: SURFACE_DEFAULTS.moveFeed,
          },
        )
  // the taken map continues ("Retry from here") while its grid is the one laid out
  const sameGrid =
    taken !== undefined &&
    grid !== undefined &&
    taken.cols === grid.cols &&
    taken.rows === grid.rows &&
    Math.abs(taken.origin[0] - grid.origin[0]) < 1e-6 &&
    Math.abs(taken.origin[1] - grid.origin[1]) < 1e-6 &&
    Math.abs(taken.spacing[0] - grid.spacing[0]) < 1e-6 &&
    Math.abs(taken.spacing[1] - grid.spacing[1]) < 1e-6 &&
    (taken.workZero === undefined ||
      (Math.abs(taken.workZero[0] - status.workZero[0]) < 0.01 &&
        Math.abs(taken.workZero[1] - status.workZero[1]) < 0.01))
  const missing = sameGrid ? order.filter((k) => taken.z[k] === null) : order
  const partial = sameGrid && missing.length > 0 && missing.length < order.length

  const connected = isConnected(status)
  const serial = connected && status.connection.target === 'serial'
  const why =
    bedMode && key === undefined
      ? m.bed.noMachine
      : !bedMode && plan === undefined
        ? m.noPlan
        : !connected
          ? runMessages.why.notConnected
          : bedMode && !status.homed
            ? m.bed.homeFirst
            : status.spindle > 0
              ? m.spindleOn
              : status.state !== 'Idle' && !busy
                ? m.idleFirst
                : inputError !== null
                  ? inputError
                  : order.length < 2
                    ? m.allSkipped
                    : !probeOk
                      ? runMessages.why.probeCheck
                      : null

  const pointJob = async (args: object): Promise<{ z: number } | 'stopped' | AppErrorData> => {
    const r = await bridge.call('run.machine.surfacePoint', args)
    if (!r.ok) return r.error
    const id = (r.value as { jobId: string }).jobId
    setJobId(id)
    try {
      let w = await bridge.call('job.wait', { jobId: id, timeoutSeconds: 300 })
      while (w.ok && (w.value as { timedOut?: boolean }).timedOut === true)
        w = await bridge.call('job.wait', { jobId: id, timeoutSeconds: 300 })
      if (!w.ok) return w.error
      const outcome = (
        w.value as { outcome?: { ok: boolean; value?: unknown; error?: AppErrorData } }
      ).outcome
      if (outcome?.ok === true) return outcome.value as { z: number }
      const e = outcome?.error
      if (e === undefined || e.code === 'op.aborted' || e.code === 'machine.reset') return 'stopped'
      return e
    } finally {
      setJobId(undefined)
    }
  }

  const run = async () => {
    if (grid === undefined || key === undefined || why !== null) return
    if (!bedMode && setupId === undefined) return
    setError(undefined)
    setStopped(false)
    setFailed(undefined)
    stopRef.current = false
    const s0 = store.getState().status
    const w0 = wcoOf(s0)
    const base: Taken =
      sameGrid && partial
        ? taken
        : {
            date: new Date().toISOString(),
            probe: probe.kind,
            margin,
            origin: [grid.origin[0], grid.origin[1]],
            spacing: [grid.spacing[0], grid.spacing[1]],
            cols: grid.cols,
            rows: grid.rows,
            z: grid.points.map(() => null),
            ...(skipped.size === 0 ? {} : { skipped: [...skipped.keys()].sort((a, b) => a - b) }),
            ...(bedMode ? {} : { workZero: [s0.workZero[0], s0.workZero[1]] as const }),
          }
    const z = [...base.z]
    const todo = sameGrid && partial ? missing : order
    // the travel height: the job's start, then the last contact plus the clearance
    let travelZ = s0.mpos[2]
    let first = !z.some((v) => v !== null)
    setBusy(true)
    setTaken({ ...base, z: [...z] })
    try {
      for (const k of todo) {
        if (stopRef.current) {
          setStopped(true)
          break
        }
        const [x, y] = grid.points[k]!
        const r = await pointJob({
          // a bed map's grid is in machine X/Y already
          at: bedMode ? [x, y] : [x + w0[0], y + w0[1]],
          ...(bedMode ? { bed: true } : {}),
          travelZ,
          zDistance: first ? SURFACE_DEFAULTS.firstDepth : clearance + depth,
          retract: clearance,
          ...(probe.fastFeed === undefined ? {} : { fastFeed: probe.fastFeed }),
          ...(probe.slowFeed === undefined ? {} : { slowFeed: probe.slowFeed }),
        })
        if (r === 'stopped') {
          setStopped(true)
          break
        }
        if (!('z' in r)) {
          setFailed(k)
          setError(r)
          break
        }
        z[k] = bedMode ? r.z : r.z - w0[2]
        travelZ = r.z + clearance
        first = false
        setTaken({ ...base, z: [...z] })
      }
    } finally {
      setBusy(false)
      if (z.some((v) => v !== null)) save({ ...base, date: new Date().toISOString(), z })
    }
  }
  const save = (map: Taken) => {
    if (key === undefined) return
    if (!bedMode) {
      if (setupId === undefined || map.workZero === undefined) return
      update({ surfaceMaps: { [key]: { ...map, setupId, workZero: [...map.workZero] } } })
      return
    }
    const { skipped: _s, workZero: _w, ...grid } = map
    const record: BedMapRecord = {
      ...grid,
      ...(stickout > 0 ? { stickout } : {}),
      ...bedMapStamp({
        ...(env === undefined
          ? {}
          : {
              envelope: {
                travel: env.travel,
                pullOff: env.pullOff,
                homingMask: env.homingMask,
                ...(env.workArea === undefined ? {} : { workArea: env.workArea }),
              },
            }),
        ...(repeat === undefined
          ? {}
          : { repeatability: { date: repeat.date, pass: repeat.pass } }),
      }),
    } as BedMapRecord
    update({ bedMaps: { [key]: record } })
  }
  const stop = () => {
    stopRef.current = true
    if (jobId !== undefined) void bridge.call('job.abort', { jobId })
  }
  const clear = () => {
    if (key === undefined) return
    update(bedMode ? { bedMaps: { [key]: null } } : { surfaceMaps: { [key]: null } })
    setTaken(undefined)
    setFailed(undefined)
    setError(undefined)
  }
  const close = () =>
    bedMode ? store.getState().setBedMapOpen(false) : store.getState().setSurfaceMapOpen(false)

  const shownMap: HeightMap | undefined =
    taken === undefined
      ? undefined
      : {
          origin: taken.origin,
          spacing: taken.spacing,
          cols: taken.cols,
          rows: taken.rows,
          z: taken.z,
          ...(taken.skipped === undefined ? {} : { skipped: taken.skipped }),
          ...(taken.workZero === undefined ? {} : { workZero: taken.workZero }),
        }
  const measured = taken === undefined ? 0 : taken.z.filter((v) => v !== null).length
  const total = busy && taken !== undefined ? taken.z.length - (taken.skipped?.length ?? 0) : 0
  const skippedNames = [...new Set(skipped.values())]
  const action = partial ? m.retry : t.run
  // RV11: why the saved bed map is not used, or that it is old
  const bedNote =
    !bedMode || busy || taken === undefined || bed.state === undefined
      ? undefined
      : bed.state.unusable !== undefined
        ? m.bed.unusable[bed.state.unusable]
        : bed.state.old
          ? m.bed.old(bed.state.ageDays)
          : undefined

  return (
    <Dialog
      open
      placement="end"
      onOpenChange={(o) => (o || busy ? undefined : close())}
      title={t.title}
      description={t.description}
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
            icon={<Icon name="run" />}
            disabled={why !== null || busy}
            aria-describedby={ids.why}
            onClick={() => (serial ? setConfirm(true) : void run())}
          >
            {action}
          </Button>
        </RunDialogFooter>
      }
    >
      <div className={styles['xyZero']} data-surface="">
        <p className={styles['hint']}>{t.steps}</p>
        <Field label={m.margin}>
          <FieldInput
            inputMode="decimal"
            value={marginText}
            disabled={busy}
            onChange={(e) => setMarginText(e.target.value)}
          />
        </Field>
        <SegmentedControl
          label={m.layout}
          options={(['count', 'spacing'] as const).map((v) => ({ value: v, label: m.layouts[v] }))}
          value={layout}
          disabled={busy}
          onValueChange={setLayout}
        />
        {layout === 'count' ? (
          <div className={styles['buttons']}>
            <Field label={m.cols}>
              <FieldInput
                inputMode="numeric"
                value={colsText}
                disabled={busy}
                onChange={(e) => setColsText(e.target.value)}
              />
            </Field>
            <Field label={m.rows}>
              <FieldInput
                inputMode="numeric"
                value={rowsText}
                disabled={busy}
                onChange={(e) => setRowsText(e.target.value)}
              />
            </Field>
          </div>
        ) : (
          <Field label={m.spacing}>
            <FieldInput
              inputMode="decimal"
              value={spacingText}
              disabled={busy}
              onChange={(e) => setSpacingText(e.target.value)}
            />
          </Field>
        )}
        {bedMode ? (
          <Field label={m.bed.stickout}>
            <FieldInput
              inputMode="decimal"
              value={stickoutText}
              disabled={busy}
              onChange={(e) => setStickoutText(e.target.value)}
            />
          </Field>
        ) : null}
        <div className={styles['buttons']}>
          <Field label={m.clearance}>
            <FieldInput
              inputMode="decimal"
              value={clearanceText}
              disabled={busy}
              onChange={(e) => setClearanceText(e.target.value)}
            />
          </Field>
          <Field label={m.depth}>
            <FieldInput
              inputMode="decimal"
              value={depthText}
              disabled={busy}
              onChange={(e) => setDepthText(e.target.value)}
            />
          </Field>
        </div>
        {grid === undefined ? null : (
          <p className={styles['hint']} data-grid="">
            {m.gridSummary(
              grid.cols,
              grid.rows,
              f(grid.spacing[0]),
              f(grid.spacing[1]),
              unit,
              order.length,
              Math.max(1, Math.round(estimate / 60)),
            )}
          </p>
        )}
        {skipped.size === 0 ? null : (
          <p className={styles['hint']} data-skipped="">
            {m.skipped(skipped.size, skippedNames.join(', '))}
          </p>
        )}
        <p className={styles['hint']}>{m.probeHint[probe.kind] ?? m.probeHint['zPlate']}</p>
        {why === runMessages.why.probeCheck || !probeOk ? <ProbeInput doc={doc} /> : null}
        {busy ? (
          <>
            <Progress
              label={m.progress}
              value={measured}
              max={Math.max(1, total)}
              valueText={m.running(Math.min(measured + 1, total), total)}
            />
            <p className={styles['hint']} role="status">
              {m.running(Math.min(measured + 1, total), total)}
            </p>
          </>
        ) : null}
        <p id={ids.why} className={styles['why']} role="status">
          {stopped ? m.stopped : busy ? '' : (why ?? '')}
        </p>
        {error === undefined ? null : (
          <ErrorMessage
            error={error}
            {...(failed === undefined ? {} : { message: m.failed(failed + 1) })}
          />
        )}
        {shownMap === undefined ? null : (
          <>
            <p className={styles['sectionLabel']}>{t.result}</p>
            {taken !== undefined && !busy ? (
              <p className={styles['hint']}>
                {m.when(new Date(taken.date).toLocaleString(), taken.probe)}
              </p>
            ) : null}
            {bedNote === undefined ? null : (
              <p className={styles['why']} data-bed-note="">
                {bedNote}
              </p>
            )}
            <SurfaceHeatMap map={shownMap} units={units} failed={failed} limit={maxRange} />
            {busy ? null : (
              <div className={styles['buttons']}>
                <Button size="sm" variant="ghost" icon={<Icon name="delete" />} onClick={clear}>
                  {m.clear}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t.confirm.title}
        description={t.confirm.description(missing.length)}
        confirmLabel={action}
        onConfirm={() => void run()}
      />
    </Dialog>
  )
}
