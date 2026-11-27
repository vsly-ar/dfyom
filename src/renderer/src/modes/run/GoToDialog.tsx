// Go to coordinates (hardening DF128): opened from a DRO value on its frame and axis. The X, Y, Z
// fields start at the current position in the chosen frame (relative: at 0), take lengths and
// expressions in the project unit, and the steps list shows the move in the safe order
// (`goToMoves`, src/core/run/goto.ts) before Go. Enter in a field is Go; the steps are sent as
// `run.machine.jog { to, feed }` one after the other (GRBL queues them), the dialog follows them
// and closes on arrival. While open the jog hotkeys are off (`goTo` in the run store). Escape
// restores an edited field first, else closes, stopping the move (jog cancel) if one runs.
// GT2: the listed steps go to the run store (`goToPreview`) for the 3D path; the dialog sits at
// the bottom of the end edge without the dark scrim (`placement="end"`), so the view stays visible.
// DF133 RW4 (Q187): the steps through the workholding guard on every change; a contact is a finding
// under the steps, Go disabled, the path red from the contact on, and "Go anyway" (reset when the
// move changes) or an armed "Jog past once" lets it go. Guard not on: exactly as before.
// DF140: the DRO's "→0" opens it with the axis's work zero filled (`goToZeroTarget`, exact until
// a field is edited) and goes at once when Go may; otherwise it stays open with the reason.
// Doc: docs/modes/run-goto.md, docs/modes/run-workholding.md#go-to-and-the-touch-off-spot
import { useEffect, useId, useRef, useState } from 'react'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import { quantityFromSource } from '../../../../core/expression/quantity'
import {
  goToLengths,
  goToMoves,
  goToSafeZ,
  goToSeconds,
  goToTarget,
  goToZeroTarget,
  machineTopZ,
  type GoToFrame,
  type GoToMode,
  type GoToStep,
  type Vec3,
} from '../../../../core/run/goto'
import type { RunStatus } from '../../../../core/run/service'
import { None } from '../../../../shared/result'
import { lengthSource } from '../../messages/dfm'
import { runMessages } from '../../messages/run'
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  FieldInput,
  Icon,
  SegmentedControl,
  type FieldMessage,
} from '../../ui'
import { useJogControls, useMachineJog } from './JogPad'
import { formatFeed, formatLength, goToGate } from './machine-state'
import { findingText, mayGo, MoveGuardFinding, useGoAnyway, useMoveGuard } from './MoveGuardFinding'
import { setupClearance } from './plan-info'
import { NO_PLAN, useRun, useRunStore, useRunUnits, type Axis, type GoToRequest } from './run-store'
import { guardActive, moveGuard } from './run-guard'
import { RunDialogFooter } from './RunStop'
import styles from './Run.module.css'

const m = runMessages.goTo
const AXES = ['x', 'y', 'z'] as const
/** Within this (mm) of a step's end the machine is there (the dialog follows the steps). */
const AT_MM = 0.01

type Texts = readonly [string, string, string]

/** The work offset of the status (MPos − WPos: G54 plus any G92), mm. */
export const wcoOf = (s: Pick<RunStatus, 'mpos' | 'wpos'>): Vec3 => [
  s.mpos[0] - s.wpos[0],
  s.mpos[1] - s.wpos[1],
  s.mpos[2] - s.wpos[2],
]

/** A field text as mm (a length or an expression in the project unit), if valid. */
export function parseGoToField(text: string, units: UnitSystem): number | undefined {
  if (text.trim() === '') return undefined
  const q = quantityFromSource(
    text,
    { kind: 'length', defaultUnit: units === 'inch' ? 'in' : 'mm' },
    { resolve: () => None },
  )
  return q.isOk() && Number.isFinite(q.unwrap().canonical) ? q.unwrap().canonical : undefined
}

/** A point in mm as the fields' texts in the project unit. */
const textsOf = (mm: Vec3, units: UnitSystem): Texts => [
  formatLength(mm[0], units),
  formatLength(mm[1], units),
  formatLength(mm[2], units),
]

/** The current position in a frame (mm). */
const positionIn = (s: RunStatus, frame: GoToFrame): Vec3 =>
  frame === 'work' ? [s.wpos[0], s.wpos[1], s.wpos[2]] : [s.mpos[0], s.mpos[1], s.mpos[2]]

const near = (a: Vec3, b: Vec3) => a.every((v, i) => Math.abs(v - b[i]!) <= AT_MM)

/** Distance (mm) from `p` to the segment `a`–`b`. */
function toSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const len2 = d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2
  const t =
    len2 === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((p[0] - a[0]) * d[0]! + (p[1] - a[1]) * d[1]! + (p[2] - a[2]) * d[2]!) / len2,
          ),
        )
  return Math.hypot(p[0] - a[0] - t * d[0]!, p[1] - a[1] - t * d[1]!, p[2] - a[2] - t * d[2]!)
}

/**
 * The step a position is on, from `current` on (the reports may skip a step's end): the last
 * step whose segment passes within `AT_MM` of it, else `current`.
 */
export function currentStep(
  at: Vec3,
  from: Vec3,
  steps: readonly GoToStep[],
  current: number,
): number {
  let found = current
  for (let k = current; k < steps.length; k++) {
    const start = k === 0 ? from : steps[k - 1]!.to
    if (toSegment(at, start, steps[k]!.to) <= AT_MM) found = k
  }
  return found
}

/** The Go to dialog, mounted with the run dialogs; open while the run store's `goTo` is set. */
export function GoToDialog({ doc }: { doc: ProjectDoc | undefined }): React.JSX.Element | null {
  const goTo = useRun((s) => s.goTo)
  // a new form per opening: the fields start at the position of that moment
  const [opened, setOpened] = useState(0)
  const [last, setLast] = useState<GoToRequest | undefined>(undefined)
  if (goTo !== last) {
    setLast(goTo)
    if (goTo !== undefined) setOpened(opened + 1)
  }
  return goTo === undefined ? null : <GoToOpen key={opened} doc={doc} request={goTo} />
}

type Phase =
  | { readonly kind: 'editing' }
  | {
      readonly kind: 'moving'
      readonly from: Vec3
      readonly steps: readonly GoToStep[]
      /** The step under way (0-based). */
      readonly current: number
      /** DF133 RW4: the guard's contact the user went past ("Go anyway", "Jog past once"). */
      readonly hit?: { readonly step: number; readonly at: Vec3 }
    }
  | { readonly kind: 'stopped'; readonly at: Vec3 }

function GoToOpen({
  doc,
  request,
}: {
  doc: ProjectDoc | undefined
  request: GoToRequest
}): React.JSX.Element {
  const store = useRunStore()
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const setupId = useRun((s) => s.setupId)
  const liftToTop = useRun((s) => s.goToLiftTop)
  const actionError = useRun((s) => s.actionError)
  const units = useRunUnits(doc)
  const unit = runMessages.dro.units[units]
  const controls = useJogControls(doc)
  const machine = useMachineJog(doc)
  const feed = {
    xy: controls.feed,
    z: machine.maxZ === undefined ? controls.feed : Math.min(controls.feed, machine.maxZ),
  }
  const plan = planId === undefined || planId === NO_PLAN ? undefined : doc?.plans[planId]
  const clearance = plan === undefined ? undefined : setupClearance(plan, setupId)
  const envelope = status.envelope
  const wco = wcoOf(status)
  const safeZ = goToSafeZ({ wcoZ: wco[2], zeroLevel: status.zeroLevel, clearance, envelope })
  const top = machineTopZ(envelope)

  const [frame, setFrame] = useState<GoToFrame>(request.frame)
  const [mode, setMode] = useState<GoToMode>('absolute')
  /** The texts the fields were last filled with (Escape in an edited field restores them). */
  // DF140: "→0" fills the axis's work zero; the exact point counts until a field is edited (the
  // texts are rounded to the display precision, which must not turn "Z only" into an X/Y move)
  const [zero] = useState<{ target: Vec3; texts: Texts } | undefined>(() => {
    if (request.zero !== true) return undefined
    const target = goToZeroTarget({
      wpos: positionIn(status, 'work'),
      wco,
      axis: request.axis,
      safeZ,
    })
    return { target, texts: textsOf(target, units) }
  })
  const [filled, setFilled] = useState<Texts>(
    () => zero?.texts ?? textsOf(positionIn(status, request.frame), units),
  )
  const [texts, setTexts] = useState<Texts>(filled)
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' })
  const fields = useRef<(HTMLInputElement | null)[]>([])
  const stepsId = useId()
  const whyId = useId()
  const relativeId = useId()
  const findingId = useId()
  // focus goes back to the DRO value that opened the dialog (taken before the field's autofocus;
  // the dialog unmounts on close, so Radix cannot return it)
  const [opener] = useState(() => request.opener ?? document.activeElement)
  useEffect(
    () => () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    },
    [opener],
  )

  const fill = (next: Texts) => {
    setFilled(next)
    setTexts(next)
  }
  const values = texts.map((t) => parseGoToField(t, units))
  const valid = values.every((v) => v !== undefined)
  const exact =
    zero !== undefined &&
    frame === 'work' &&
    mode === 'absolute' &&
    texts.every((t, i) => t === zero.texts[i])
  const target = exact ? zero.target : ((valid ? values : [0, 0, 0]) as unknown as Vec3)
  const plannedFrom: Vec3 = [status.mpos[0], status.mpos[1], status.mpos[2]]
  const planned = valid
    ? goToMoves({ from: plannedFrom, wco, target, frame, mode, safeZ, liftToTop, envelope })
    : undefined
  const steps = planned?.isOk() === true ? planned.unwrap() : undefined
  const travel =
    planned?.isErr() === true
      ? (planned.unwrapErr().frames[0]?.data as
          { axis: Axis; target: number; min: number; max: number } | undefined)
      : undefined

  // DF133 RW4: the steps through the guard; "Go anyway" is for this very move
  const stepTos = steps?.map((st) => st.to) ?? []
  const guard = useMoveGuard(plannedFrom, stepTos)
  const [anyway, setAnyway] = useGoAnyway(JSON.stringify([plannedFrom, ...stepTos]))

  const gate = goToGate(status)
  const moving = phase.kind === 'moving'
  const why =
    gate ??
    (!valid ? m.invalid : travel !== undefined ? null : steps?.length === 0 ? m.already : null)
  const canGo =
    !moving && why === null && steps !== undefined && steps.length > 0 && mayGo(guard, anyway)

  // follow the steps: Idle at the last end = arrived (the dialog closes); Idle short of it after
  // jogging, or any other state = stopped (the jog cancel, a refusal, an alarm)
  const phaseRef = useRef(phase)
  useEffect(() => {
    phaseRef.current = phase
  })
  useEffect(() => {
    if (!moving) return
    let sawJog = false
    return store.subscribe((st, prev) => {
      const p = phaseRef.current
      if (st.status === prev.status || p.kind !== 'moving') return
      const s = st.status
      const at: Vec3 = [s.mpos[0], s.mpos[1], s.mpos[2]]
      if (s.state === 'Idle' && near(at, p.steps[p.steps.length - 1]!.to)) {
        store.getState().closeGoTo()
        return
      }
      if (s.state.startsWith('Jog')) sawJog = true
      else if (s.state !== 'Idle' || sawJog) {
        setPhase({ kind: 'stopped', at })
        return
      }
      const current = currentStep(at, p.from, p.steps, p.current)
      if (current !== p.current) setPhase({ ...p, current })
    })
  }, [moving, store])

  const go = async () => {
    if (!canGo) return
    // computed again from the live position: the machine may have moved since the dialog opened
    const s = store.getState().status
    const r = goToMoves({
      from: [s.mpos[0], s.mpos[1], s.mpos[2]],
      wco: wcoOf(s),
      target,
      frame,
      mode,
      safeZ,
      liftToTop,
      envelope: s.envelope,
    })
    if (r.isErr() || r.unwrap().length === 0) return
    const todo = r.unwrap()
    const from: Vec3 = [s.mpos[0], s.mpos[1], s.mpos[2]]
    // DF133 RW4: the guard again on the live steps; a contact goes only with "Go anyway" or past once
    const st = store.getState()
    const live = guardActive(st.status, st.guardSetup, st.guardOff)
      ? moveGuard(
          st.status,
          st.guardSetup,
          from,
          todo.map((x) => x.to),
        )
      : undefined
    if (live !== undefined && !anyway && st.pastOnceUntil === undefined) return
    setPhase({
      kind: 'moving',
      from,
      steps: todo,
      current: 0,
      ...(live === undefined ? {} : { hit: { step: live.hit.step, at: live.hit.at } }),
    })
    const sent = await store.getState().moveTo(
      todo.map((x) => ({ to: x.to, feed: x.axis === 'z' ? feed.z : feed.xy })),
      { anyway },
    )
    if (!sent) {
      const now = store.getState().status
      setPhase({ kind: 'stopped', at: [now.mpos[0], now.mpos[1], now.mpos[2]] })
    }
  }

  // DF140: "→0" goes at once when Go may (once, on opening); else the dialog shows why
  const autoGo = useRef(request.zero === true)
  useEffect(() => {
    if (!autoGo.current) return
    autoGo.current = false
    // after the effect (the Go button's own path, not a state change inside the effect)
    if (canGo) queueMicrotask(() => void go())
  })

  /** Escape (Radix) or Cancel: stops a move under way (jog cancel), then closes. */
  const close = () => {
    if (moving) void store.getState().jogCancel()
    store.getState().closeGoTo()
  }
  const onOpenChange = (open: boolean) => {
    if (open) return
    // Escape in an edited field restores it first (quantity field rule); a second one closes
    const i = fields.current.findIndex((f) => f !== null && f === document.activeElement)
    if (i >= 0 && texts[i] !== filled[i]) {
      setTexts(texts.map((t, j) => (j === i ? filled[j]! : t)) as unknown as Texts)
      return
    }
    close()
  }

  const changeFrame = (next: GoToFrame) => {
    if (next === frame) return
    // the same point in the other frame (through the live work offset)
    if (mode === 'absolute' && valid) {
      const machinePt = goToTarget({ from: plannedFrom, wco, target, frame, mode })
      const pt: Vec3 =
        next === 'work'
          ? [machinePt[0] - wco[0], machinePt[1] - wco[1], machinePt[2] - wco[2]]
          : machinePt
      fill(textsOf(pt, units))
    }
    setFrame(next)
  }
  const changeMode = (next: GoToMode) => {
    if (next === mode) return
    if (next === 'relative') fill(textsOf([0, 0, 0], units))
    else {
      // keep the target: the position plus the typed distance
      const pos = positionIn(status, frame)
      const d = valid ? target : ([0, 0, 0] as const)
      fill(textsOf([pos[0] + d[0], pos[1] + d[1], pos[2] + d[2]], units))
    }
    setMode(next)
  }
  /** A shortcut: fills the fields (absolute, `frame`); nothing moves until Go. */
  const shortcut = (to: GoToFrame, pt: (cur: Vec3) => Vec3) => {
    setMode('absolute')
    setFrame(to)
    fill(textsOf(pt(positionIn(status, to)), units))
  }

  const fieldMessages = (i: number): FieldMessage[] => {
    if (values[i] === undefined) return [{ id: 'invalid', severity: 'error', text: m.invalid }]
    if (travel !== undefined && travel.axis === AXES[i])
      return [
        {
          id: 'travel',
          severity: 'error',
          text: m.travel(
            travel.axis.toUpperCase(),
            formatLength(travel.target, units),
            formatLength(travel.min, units),
            formatLength(travel.max, units),
            unit,
          ),
        },
      ]
    return []
  }

  const shown = (mm: number, axis: number) =>
    formatLength(frame === 'work' ? mm - wco[axis]! : mm, units)
  const list = phase.kind === 'moving' ? phase.steps : (steps ?? [])
  const listFrom = phase.kind === 'moving' ? phase.from : plannedFrom
  const lengths = goToLengths(listFrom, list)
  const seconds = steps === undefined ? undefined : goToSeconds(plannedFrom, steps, feed)
  const feedUnit = runMessages.dro.feedUnits[units]
  const serial = status.connection.target === 'serial'

  // GT2: the steps shown, drawn in the run scene as a dashed path to a target marker (by value,
  // so a status report that moved nothing republishes nothing)
  // DF133 RW4: red from the guard's contact on
  const hit =
    phase.kind === 'moving'
      ? phase.hit
      : guard.finding === undefined
        ? undefined
        : { step: guard.finding.hit.step, at: guard.finding.hit.at }
  const previewKey =
    list.length === 0 ? '' : JSON.stringify([[listFrom, ...list.map((st) => st.to)], hit ?? null])
  useEffect(() => {
    const [pts, h] =
      previewKey === ''
        ? [[], null]
        : (JSON.parse(previewKey) as [Vec3[], { step: number; at: Vec3 } | null])
    store
      .getState()
      .setGoToPreview(
        pts.length < 2
          ? undefined
          : { from: pts[0]!, points: pts.slice(1), ...(h === null ? {} : { hit: h }) },
      )
  }, [previewKey, store])
  useEffect(() => () => store.getState().setGoToPreview(undefined), [store])

  const stopAt: Vec3 | undefined =
    phase.kind !== 'stopped'
      ? undefined
      : frame === 'work'
        ? [phase.at[0] - wco[0], phase.at[1] - wco[1], phase.at[2] - wco[2]]
        : phase.at

  return (
    <Dialog
      open
      placement="end"
      onOpenChange={onOpenChange}
      title={m.title}
      description={m.description}
      hideDescription
      footer={
        <RunDialogFooter>
          <Button onClick={close}>{m.cancel}</Button>
          <Button
            variant="primary"
            icon={<Icon name="jog" />}
            disabled={!canGo}
            aria-describedby={`${stepsId} ${guard.finding === undefined ? '' : `${findingId} `}${whyId}`}
            onClick={() => void go()}
          >
            {m.go}
          </Button>
        </RunDialogFooter>
      }
    >
      <div className={styles['goTo']}>
        <div className={styles['goToModes']}>
          <SegmentedControl
            label={m.frame}
            size="sm"
            options={[
              { value: 'work', label: m.work },
              { value: 'machine', label: m.machine },
            ]}
            value={frame}
            onValueChange={changeFrame}
            disabled={mode === 'relative' || moving}
            {...(mode === 'relative' ? { 'aria-describedby': relativeId } : {})}
          />
          <SegmentedControl
            label={m.mode}
            size="sm"
            options={[
              { value: 'absolute', label: m.absolute },
              { value: 'relative', label: m.relative },
            ]}
            value={mode}
            onValueChange={changeMode}
            disabled={moving}
          />
        </div>
        <p
          id={relativeId}
          className={styles['hint']}
          aria-hidden={mode !== 'relative' || undefined}
        >
          {mode === 'relative' ? m.relativeFrame : ' '}
        </p>
        <div className={styles['goToFields']}>
          {AXES.map((axis, i) => (
            <Field key={axis} label={axis.toUpperCase()} messages={fieldMessages(i)}>
              <FieldInput
                ref={(el) => {
                  fields.current[i] = el
                }}
                unit={unit}
                inputMode="decimal"
                value={texts[i]}
                readOnly={moving}
                autoFocus={axis === request.axis}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) =>
                  setTexts(texts.map((t, j) => (j === i ? e.target.value : t)) as unknown as Texts)
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void go()
                  }
                }}
              />
            </Field>
          ))}
        </div>
        <div className={styles['buttons']} role="group" aria-label={m.shortcuts}>
          <Button
            size="sm"
            disabled={moving}
            onClick={() => shortcut('work', (cur) => [0, 0, cur[2]])}
          >
            {m.workZeroXY}
          </Button>
          <Button
            size="sm"
            disabled={moving}
            onClick={() => shortcut('work', () => [0, 0, safeZ - wco[2]])}
          >
            {m.workZero}
          </Button>
          <Button
            size="sm"
            disabled={moving}
            onClick={() =>
              shortcut(frame, (cur) => [cur[0], cur[1], frame === 'work' ? top - wco[2] : top])
            }
          >
            {m.machineTop}
          </Button>
        </div>
        <Checkbox
          label={m.liftTop}
          checked={liftToTop}
          disabled={moving}
          onCheckedChange={(c) => store.getState().setGoToLiftTop(c === true)}
        />
        <div className={styles['goToSteps']}>
          <p className={styles['sectionLabel']}>
            {m.steps}{' '}
            <span className={styles['hint']}>
              {m.feed(formatFeed(feed.xy, units), formatFeed(feed.z, units), feedUnit)}
              {seconds === undefined || list.length === 0 ? null : ` · ${m.seconds(seconds)}`}
            </span>
          </p>
          <ol id={stepsId} className={styles['goToList']} aria-label={m.steps}>
            {list.map((st, i) => {
              const from = i === 0 ? listFrom : list[i - 1]!.to
              const text =
                st.axis === 'xy'
                  ? m.stepXY(shown(st.to[0], 0), shown(st.to[1], 1))
                  : st.to[2] > from[2]
                    ? m.stepUp(shown(st.to[2], 2))
                    : m.stepDown(shown(st.to[2], 2))
              return (
                <li
                  key={i}
                  {...(phase.kind === 'moving' && i === phase.current
                    ? { 'aria-current': 'step' as const }
                    : {})}
                >
                  <span>
                    <span className={styles['mono']}>{i + 1}</span> · {text}
                  </span>{' '}
                  <span className={styles['hint']}>
                    {formatLength(lengths[i]!, units)} {unit}
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
        {phase.kind === 'editing' && steps !== undefined ? (
          <MoveGuardFinding
            id={findingId}
            text={
              guard.finding === undefined
                ? undefined
                : findingText(guard.finding, plannedFrom, steps, shown, (mm) =>
                    lengthSource(mm, units),
                  )
            }
            guard={guard}
            anyway={anyway}
            onAnyway={setAnyway}
          />
        ) : null}
        <p id={whyId} className={styles['why']} role="status">
          {phase.kind === 'moving'
            ? m.moving(phase.current + 1, phase.steps.length)
            : stopAt !== undefined
              ? m.stopped(...textsOf(stopAt, units))
              : (why ?? (serial ? m.spindleReal : ''))}
        </p>
        {phase.kind === 'stopped' && actionError !== undefined ? (
          <p className={styles['why']}>{actionError.message}</p>
        ) : null}
      </div>
    </Dialog>
  )
}
