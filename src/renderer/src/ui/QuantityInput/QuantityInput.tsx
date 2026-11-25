// QuantityInput: every dimensional field (task 3.4). A Field whose input keeps the source as typed
// (`1/16"`, `D/2 ±0.01`), reads it with the core parser/evaluator, echoes the reading while typing
// when the text alone does not show it,
// shows errors in place (underline, catalogue message, verified fix), commits a valid value on
// Enter/blur (one `onCommit` = one command = one undo step), reverts on Escape and never commits
// an invalid value. An optional field (`optional`) commits an emptied field as unset. Steppers
// (↑/↓, adjust panel), reference autocomplete and the pick toggle hook (pick mode itself belongs
// to the viewport) live here too. The adjust panel opens under the field on focus while the input
// keeps focus (DF9; the input is a combobox controlling it); its steps are a live gesture: each
// step commits with the session's gesture id (one undo step per session), Escape cancels it,
// focus leaving keeps it. Steps follow the field's step kind (DF104: ladder, preselected step,
// stock/machine caps, integers, a remembered choice: ./steps.ts); static help is an (i) tip on
// the title row (`info`, DF105) and a press on the title row focuses without the panel (DF111):
// docs/conventions/inspector-layout.md.
// v0.2 field rule (task P3): Enter commits and applies (the `ApplyScope`'s Apply), blur and Tab
// commit only. Doc: docs/conventions/ui.md#quantity-and-expression-input, #field,
// #selection-and-picking; docs/architecture/apply.md#field-rule;
// grammar and errors: docs/architecture/quantities.md
import { Icon } from '../icons/Icon'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type { ReferenceResolver } from '../../../../core/expression/evaluate'
import type { ParseContext } from '../../../../core/quantity/parse'
import type { Quantity } from '../../../../core/quantity/quantity'
import { Rational } from '../../../../core/quantity/rational'
import type { QuantityKind, UnitId } from '../../../../core/quantity/units'
import type { AppResult } from '../../../../shared/result'
import { quantityText } from '../../messages/quantity'
import { useApplyOnEnter } from '../ApplyButton/ApplyScope'
import { Button } from '../Button/Button'
import { Field, type FieldControlProps, type FieldMessage, type FieldProps } from '../Field/Field'
import { FieldInput } from '../Field/FieldInput'
import { SegmentedControl } from '../SegmentedControl/SegmentedControl'
import { UNITS } from '../../../../core/quantity/units'
import { useStepMemory, useStepScale } from './StepContext'
import { stepLabel, stepsFor, unitSystemOf, type StepKind } from './steps'
import {
  defaultPrecision,
  describeInherited,
  describeReading,
  echoAddsInformation,
  explainError,
  formatValue,
  NO_REFERENCES,
  readSource,
  referenceAt,
  showsComputedValue,
  stepRational,
  stepSource,
  UNIT_LABEL,
  type InheritedTolerance,
  type Reading,
} from './reading'
import styles from './QuantityInput.module.css'

/** Echo after this pause in typing (ui.md: debounced 150 ms). */
export const ECHO_DELAY_MS = 150
/** Errors appear on blur, Enter, or after this pause in typing – never mid-word. */
export const ERROR_DELAY_MS = 600

/** A reference the field offers while typing (surface of an earlier operation, tool parameter). */
export interface ReferenceOption {
  /** As typed in a formula: `pocket1.floor.z`, `tool.diameter`. */
  id: string
  /** Human name: "Pocket 1 floor". */
  label?: string
}

/**
 * How a QuantityInput commits. Required (the default): an empty field is an error like any other
 * invalid text. Optional: emptying the field (blank or spaces) and committing it commits unset
 * (`undefined`) instead; an empty optional field is never marked.
 */
export type QuantityCommitProps =
  | {
      optional?: false
      /**
       * A valid, changed value on Enter, blur, a fix or a step of the adjust popover: dispatch one
       * command. `gesture` is set for adjust-popover steps: pass it to the dispatch so the session
       * stays one undo step (docs/architecture/commands.md#gestures-live-edits).
       */
      onCommit: (value: Quantity, gesture?: string) => void
    }
  | {
      optional: true
      /** As above; `undefined` when a stored value was emptied (unset). */
      onCommit: (value: Quantity | undefined, gesture?: string) => void
    }

export type QuantityInputProps = QuantityInputBaseProps & QuantityCommitProps

export interface QuantityInputBaseProps {
  label: string
  /** The field's quantity kind (length, angle, …). */
  kind: QuantityKind
  /** Unit a bare number means (the project unit for the kind); also the display unit. */
  defaultUnit: UnitId
  /** The stored value; undefined = empty. */
  value: Quantity | undefined
  /** Resolves references in formulas; none by default. */
  resolver?: ReferenceResolver
  /** Offered while typing a name (and with Ctrl+Space / ↓ in a formula). */
  references?: readonly ReferenceOption[]
  /** Field rules on top of the grammar (sign, integer): an Err blocks the commit like a parse error. */
  validate?: (value: Quantity) => AppResult<Quantity>
  /** Display decimals in the display unit; default per unit (3 mm, 4 in). */
  precision?: number
  /**
   * What the field measures, for its adjust steps (inspector-layout.md § Step kinds and the
   * per-field assignment table); `xy` until every field names one (slice S6).
   */
  stepKind?: StepKind
  /** The field's maximum (count fields): the ladder stops at half of it (DF104 rule 6). */
  stepMax?: number
  /** No stock or machine cap (a "no cap" row of the assignment table: setup heights, stock size). */
  stepUncapped?: boolean
  /**
   * Role under which a chosen step is remembered for the session (`pocket.depth`); default
   * `<stepKind>:<label>`.
   */
  stepKey?: string
  /** Static explanation of the field: the (i) tip on the title row (DF105). */
  info?: ReactNode
  /** Provenance tag at the title row's end ("Preset", "Default"); `title` = the full sentence. */
  tag?: FieldProps['tag']
  /** General tolerance an untoleranced value inherits, shown in the echo. */
  inheritedTolerance?: InheritedTolerance
  /** Shown while empty: what applies without a value ("None: values are exact"). */
  placeholder?: string
  /** Recommended value: the adjust panel offers "Use …". */
  recommended?: { source: string; text: ReactNode }
  /**
   * Escape in the adjust panel after live steps: revert the gesture's commits (a command caller
   * dispatches `history.undo { gesture }`). Resolves false when they were not reverted (the field
   * keeps the value and says so). Without it the field commits the opening value again with the
   * same gesture (local form state).
   */
  onCancelGesture?: (gesture: string) => Promise<boolean>
  /**
   * Pick toggle in the adjust panel (and Alt+P): enter pick mode for a surface reference. Call
   * `insert` with the picked reference; it goes in at the caret (replacing the selection) and
   * focus returns.
   */
  onPick?: (insert: (reference: string) => void) => void
  /** Pick mode is active for this field (pick toggle pressed). */
  picking?: boolean
  /** The pressed pick toggle (or Alt+P) again while `picking`: leave pick mode (DF10). */
  onPickCancel?: () => void
  illustration?: ReactNode
  lock?: FieldProps['lock']
  /** Warnings, notes and recommendations from checks; parse errors are added by the field. */
  messages?: readonly FieldMessage[]
  readOnly?: boolean
  /**
   * A table cell (the Shape Editor's segment table, task U1): no unit suffix and no adjust panel,
   * so the number keeps the narrow box; the echo still says how the value is read.
   */
  dense?: boolean
  className?: string | undefined
}

interface ListState {
  /** Start of the name being completed and the caret (the replaced range). */
  start: number
  end: number
  options: readonly ReferenceOption[]
  active: number
}

/**
 * One adjust-panel session (a live gesture, ui.md#quantity-and-expression-input): from the first
 * step until the panel closes or the user types.
 */
interface AdjustSession {
  readonly id: string
  /** The text before the first step: Escape restores it. */
  readonly opening: string
  /** The stored value before the first step: unchanged after a failed cancel = nothing landed. */
  readonly openingStored: string
  /** A step was committed with this gesture. */
  stepped: boolean
}

let gestureCounter = 0
/** Unique per window (and across reloads): the dispatcher merges by gesture id and source. */
export function newGestureId(): string {
  gestureCounter += 1
  return `adjust-${Date.now().toString(36)}-${gestureCounter}`
}

const MAX_OPTIONS = 50
const TEN = Rational.int(10n)
const TENTH = stepRational('0.1')

export function QuantityInput(props: QuantityInputProps): React.JSX.Element {
  const {
    label,
    kind,
    defaultUnit,
    value,
    resolver = NO_REFERENCES,
    references = [],
    validate,
    precision,
    stepKind = 'xy',
    stepMax,
    stepUncapped = false,
    stepKey,
    info,
    tag,
    inheritedTolerance,
    placeholder,
    recommended,
    onCancelGesture,
    onPick,
    picking = false,
    onPickCancel,
    illustration,
    lock,
    messages = [],
    readOnly = false,
    dense = false,
    className,
  } = props
  const ctx: ParseContext = useMemo(() => ({ kind, defaultUnit }), [kind, defaultUnit])
  const applyOnEnter = useApplyOnEnter()
  const prec = precision ?? defaultPrecision(defaultUnit)
  const stored = value?.source ?? ''
  const baseId = useId()
  const listId = `${baseId}-references`
  const panelId = `${baseId}-adjust`

  /** What the user typed; null = showing the stored source. */
  const [draft, setDraft] = useState<string | null>(null)
  /** Last committed draft, until the stored value catches up. */
  const [committed, setCommitted] = useState<string | null>(null)
  const [seen, setSeen] = useState(stored)
  const [focused, setFocused] = useState(false)
  const [errorsShown, setErrorsShown] = useState(false)
  const [echoText, setEchoText] = useState(stored)
  const scale = useStepScale()
  const memory = useStepMemory()
  const memoryKey = stepKey ?? `${stepKind}:${label}`
  /** The steps for a reading (the preselected step is fixed when focus arrives). */
  const stepsNow = (r: AppResult<Reading>) => {
    const magnitude = r.isOk()
      ? r.unwrap().quantity.canonical / UNITS[defaultUnit].factor.toNumber()
      : undefined
    return stepsFor(stepKind, {
      value: magnitude,
      unitSystem: unitSystemOf(defaultUnit),
      scale: stepUncapped ? undefined : scale,
      max: stepMax,
      remembered: memory.get(memoryKey),
    })
  }
  const [stepSize, setStepSize] = useState<string>(
    () => stepsNow(readSource(stored, ctx, resolver, validate)).initial,
  )
  /** The adjust panel is open (on focus, ui.md#field). */
  const [adjustOpen, setAdjustOpen] = useState(false)
  /** An adjust session (live gesture) is running: its steps may still be landing. */
  const [adjusting, setAdjusting] = useState(false)
  /** An Escape cancel is in flight (its revert has not arrived yet). */
  const [cancelling, setCancelling] = useState(false)
  /** "Kept the adjusted value" after an Escape that could not revert a step that landed. */
  const [kept, setKept] = useState(false)
  const [list, setList] = useState<ListState | null>(null)
  /** Read-only and dense (table cell) fields have nothing to adjust: no panel (ui.md#field). */
  const hasPanel = !readOnly && !dense
  /** The reference list takes the panel's place while it is open. */
  const panelShown = hasPanel && adjustOpen && list === null

  const inputRef = useRef<HTMLInputElement>(null)
  const overlayRef = useRef<HTMLSpanElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const lastSelection = useRef<[number, number] | null>(null)
  const storedRef = useRef(stored)
  const session = useRef<AdjustSession | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  /** Focus the panel's first control once it renders (⌘↓ / Ctrl+↓ from the input). */
  const focusPanel = useRef(false)
  /** The next focus of the input comes back from the panel: do not reopen it. */
  const returning = useRef(false)

  // The stored value changed (commit landed, undo, agent edit): follow it unless the user is
  // typing something else. During an adjust session (and its cancel) earlier steps land while a
  // later one is shown: wait for the last committed value instead of flicking back.
  if (stored !== seen) {
    setSeen(stored)
    const stepsInFlight = (adjusting || cancelling) && committed !== null && stored !== committed
    if (draft !== null && !stepsInFlight && (draft === committed || !focused)) {
      setDraft(null)
      setCommitted(null)
      setErrorsShown(false)
    }
  }

  const text = draft ?? stored
  /** Empty text of an optional field: unset, not an error. */
  const isUnset = (s: string): boolean => props.optional === true && s.trim() === ''
  const reads = (s: string): boolean => readSource(s, ctx, resolver, validate).isOk()
  const reading = useMemo(
    () => readSource(text, ctx, resolver, validate),
    [text, ctx, resolver, validate],
  )
  const ladder = stepsNow(reading)
  /** The step in use: the chosen or preselected one while it fits the (scaled) ladder. */
  const step = ladder.steps.includes(stepSize) ? stepSize : ladder.initial
  const echoReading = useMemo(
    () => (echoText === text ? reading : readSource(echoText, ctx, resolver, validate)),
    [echoText, text, reading, ctx, resolver, validate],
  )

  useEffect(() => {
    storedRef.current = stored
  })

  useLayoutEffect(() => {
    const caret = pendingCaret.current
    const input = inputRef.current
    if (caret === null || !input) return
    pendingCaret.current = null
    input.setSelectionRange(caret, caret)
    syncScroll()
  })

  useEffect(() => {
    const echo = setTimeout(() => setEchoText(text), ECHO_DELAY_MS)
    const error = draft !== null ? setTimeout(() => setErrorsShown(true), ERROR_DELAY_MS) : null
    return () => {
      clearTimeout(echo)
      if (error !== null) clearTimeout(error)
    }
  }, [text, draft])

  function syncScroll(): void {
    const input = inputRef.current
    const overlay = overlayRef.current
    if (input && overlay) overlay.style.transform = `translateX(${-input.scrollLeft}px)`
  }

  function edit(next: string, caret: number | null): void {
    // typing ends an adjust session: the next step starts a new gesture
    endSession()
    setDraft(next)
    setKept(false)
    setErrorsShown(false)
    updateList(next, caret)
  }

  function updateList(next: string, caret: number | null, all = false): void {
    if (references.length === 0 || caret === null) return setList(null)
    const at = all ? { start: caret, prefix: '' } : referenceAt(next, caret)
    if (!at) return setList(null)
    const lower = at.prefix.toLowerCase()
    const options = references
      .filter((r) => r.id.toLowerCase().startsWith(lower) && r.id !== at.prefix)
      .slice(0, MAX_OPTIONS)
    setList(options.length > 0 ? { start: at.start, end: caret, options, active: 0 } : null)
  }

  function accept(option: ReferenceOption): void {
    if (!list) return
    const next = text.slice(0, list.start) + option.id + text.slice(list.end)
    pendingCaret.current = list.start + option.id.length
    setDraft(next)
    setErrorsShown(false)
    setList(null)
  }

  /**
   * Commit `source` if it reads and differs from what is stored; false if invalid. `gesture`:
   * a step of the adjust session with that id.
   */
  function commitSource(source: string, gesture?: string): boolean {
    if (readOnly) return true
    // a step back to the stored value while a later step is still landing must still commit
    const landing = gesture !== undefined && committed !== null && committed !== stored
    if (value !== undefined && source === stored && !landing) {
      setDraft(null)
      setCommitted(null)
      setErrorsShown(false)
      return true
    }
    if (source === committed) return true
    if (isUnset(source)) {
      if (value === undefined) {
        revert()
        return true
      }
      setDraft(source)
      setCommitted(source)
      setErrorsShown(false)
      setEchoText(source)
      if (props.optional) props.onCommit(undefined, gesture)
      markStepped(gesture)
      return true
    }
    const r = readSource(source, ctx, resolver, validate)
    if (r.isErr()) {
      setDraft(source)
      setErrorsShown(true)
      return false
    }
    setDraft(source)
    setCommitted(source)
    setErrorsShown(false)
    setEchoText(source)
    setKept(false)
    props.onCommit(r.unwrap().quantity, gesture)
    markStepped(gesture)
    return true
  }

  function markStepped(gesture: string | undefined): void {
    if (gesture !== undefined && session.current?.id === gesture) session.current.stepped = true
  }

  const commit = (): boolean => (draft === null ? true : commitSource(draft))

  function revert(): void {
    setDraft(null)
    setCommitted(null)
    setErrorsShown(false)
    setList(null)
  }

  const steppable = stepSource(text, ctx, Rational.ONE, prec).isSome()

  /** ↑/↓ in the field change the text only; a panel step (`live`) commits it with the gesture. */
  function stepBy(direction: 1 | -1, multiplier: Rational = Rational.ONE, live = false): boolean {
    const delta = stepRational(step)
      .mul(multiplier)
      .mul(Rational.int(BigInt(direction)))
    const next = stepSource(text, ctx, delta, prec)
    if (next.isNone()) return false
    if (live) return commitSource(next.unwrap(), startSession())
    setDraft(next.unwrap())
    setErrorsShown(false)
    return true
  }

  /** The running adjust session's gesture id, or a new session from the current text. */
  function startSession(): string {
    if (session.current) return session.current.id
    session.current = { id: newGestureId(), opening: text, openingStored: stored, stepped: false }
    setAdjusting(true)
    setKept(false)
    return session.current.id
  }

  function endSession(): AdjustSession | null {
    const s = session.current
    session.current = null
    if (s) setAdjusting(false)
    return s
  }

  function openAdjust(): void {
    if (hasPanel) setAdjustOpen(true)
  }

  /**
   * The panel closes. Focus leaving (or "Use …") keeps the live value; Escape (`escaped`) cancels
   * the session: nothing committed → just close; else the caller undoes the gesture
   * (`onCancelGesture`) or, without one, the opening value is committed again.
   */
  function closeAdjust(escaped = false): void {
    setAdjustOpen(false)
    const s = endSession()
    if (s === null || !escaped || !s.stepped) return
    if (onCancelGesture === undefined) {
      if (s.opening !== text) commitSource(s.opening, s.id)
      return
    }
    // show the opening value at once; the revert lands with the undo's patches
    setDraft(s.opening)
    setCommitted(s.opening)
    setErrorsShown(false)
    setCancelling(true)
    void onCancelGesture(s.id).then((reverted) => {
      setCancelling(false)
      if (reverted) return
      // nothing to undo and the stored value never moved: every step failed (the command was
      // rejected), so the value already is the one from before the session – no "Kept" note
      const nothingLanded = storedRef.current === s.openingStored
      if (nothingLanded && s.opening !== s.openingStored) {
        setDraft(s.opening)
        setCommitted(null)
        return
      }
      revert()
      if (!nothingLanded) setKept(true)
    })
  }

  /** Focus moved: close the panel when it left both the input and the panel. */
  function focusLeft(next: EventTarget | null): void {
    const inside =
      next instanceof Node &&
      (next === inputRef.current || (panelRef.current?.contains(next) ?? false))
    if (!inside) closeAdjust()
  }

  /** Back to the input from the panel, without reopening it on that focus. */
  function returnToInput(): void {
    returning.current = true
    inputRef.current?.focus()
    returning.current = false
  }

  /** ⌘↓ / Ctrl+↓ (or ↓ with nothing to step or list): focus the panel's first control. */
  function enterPanel(): void {
    focusPanel.current = true
    if (panelShown) focusFirstControl()
    else openAdjust()
  }

  function panelControls(): HTMLElement[] {
    const panel = panelRef.current
    if (!panel) return []
    return [...panel.querySelectorAll<HTMLElement>('button:not(:disabled)')]
  }

  function focusFirstControl(): void {
    focusPanel.current = false
    panelControls()[0]?.focus()
  }

  useLayoutEffect(() => {
    if (focusPanel.current && panelRef.current) focusFirstControl()
  })

  function onPanelKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      // in pick mode Escape cancels the pick (the viewport listens on the document)
      if (picking) return
      e.preventDefault()
      e.stopPropagation()
      closeAdjust(true)
      returnToInput()
      return
    }
    const controls = panelControls()
    const at = controls.indexOf(document.activeElement as HTMLElement)
    const n = controls.length
    if (n === 0) return
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? (at + 1) % n
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? (at - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : null
    if (to === null) return
    e.preventDefault()
    controls[to]?.focus()
  }

  function insert(reference: string): void {
    const input = inputRef.current
    // the field may never have lost focus (the pick toggle in the panel keeps it): its own caret
    const selection: [number, number] | null =
      input !== null && document.activeElement === input
        ? [input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length]
        : lastSelection.current
    setDraft((d) => {
      const current = d ?? storedRef.current
      const [from, to] = selection ?? [0, current.length]
      pendingCaret.current = from + reference.length
      return current.slice(0, from) + reference + current.slice(to)
    })
    setErrorsShown(false)
    input?.focus()
  }

  /** The pick toggle: a second press (or Alt+P) while picking leaves pick mode (DF10). */
  const togglePick = (): void => (picking ? onPickCancel?.() : onPick?.(insert))

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    const caret = e.currentTarget.selectionStart
    if (list) {
      const n = list.options.length
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        setList({ ...list, active: (list.active + delta + n) % n })
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const option = list.options[list.active]
        if (option) accept(option)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setList(null)
        return
      }
      if (e.key === 'Tab') setList(null)
    }
    if (e.key === ' ' && e.ctrlKey && references.length > 0) {
      e.preventDefault()
      updateList(text, caret, true)
      return
    }
    if (onPick && e.altKey && e.code === 'KeyP') {
      e.preventDefault()
      togglePick()
      return
    }
    if (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey) && hasPanel) {
      e.preventDefault()
      enterPanel()
      return
    }
    if (e.key === 'Enter') {
      // Enter (and Cmd/Ctrl+Enter) = commit and apply; an invalid value applies nothing
      // (apply.md#field-rule); blur and Tab commit only. A valid Enter is done editing: the
      // adjust panel closes (keeping a live session's value), so it no longer covers what is below
      e.preventDefault()
      if (commit()) {
        if (adjustOpen) closeAdjust()
        applyOnEnter?.()
      }
      return
    }
    if (e.key === 'Escape') {
      // pick mode first (the viewport cancels it), then the open panel, then the typed text
      if (picking) return
      if (panelShown) {
        e.preventDefault()
        e.stopPropagation()
        closeAdjust(true)
        return
      }
      if (draft === null && !errorsShown) return
      e.preventDefault()
      e.stopPropagation()
      revert()
      return
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !readOnly) {
      // integer fields have no fractional steps: Alt (×0.1) does nothing (DF104 rule 6)
      if (e.altKey && !e.shiftKey && ladder.integer) {
        e.preventDefault()
        return
      }
      const multiplier = e.shiftKey ? TEN : e.altKey ? TENTH : Rational.ONE
      if (stepBy(e.key === 'ArrowUp' ? 1 : -1, multiplier)) e.preventDefault()
      else if (e.key === 'ArrowDown' && !e.altKey && !e.shiftKey) {
        if (references.length > 0) {
          e.preventDefault()
          updateList(text, caret, true)
        } else if (hasPanel) {
          e.preventDefault()
          enterPanel()
        }
      }
    }
  }

  // error in place: after blur/Enter/600 ms; a stored source that no longer reads (a reference
  // that became unknown) is marked too
  const storedInvalid = draft === null && value !== undefined && reading.isErr()
  const explained =
    reading.isErr() && (errorsShown || storedInvalid) && !isUnset(text)
      ? explainError(reading.unwrapErr(), text, ctx, reads)
      : undefined
  const fixSource = explained?.fix
  const errorMessage: FieldMessage | undefined = explained
    ? {
        id: 'quantity.input',
        severity: 'error',
        text: explained.text,
        ...(fixSource !== undefined
          ? {
              fix: {
                label: quantityText.fix(fixSource),
                onApply: () => {
                  commitSource(fixSource)
                  inputRef.current?.focus()
                },
              },
            }
          : {}),
      }
    : undefined

  // the echo only when it adds something to the text (expression, fraction, other unit,
  // asymmetric tolerance); a plain value shows at most its inherited tolerance
  const echo =
    focused && !readOnly && explained === undefined && echoReading.isOk()
      ? echoAddsInformation(echoReading.unwrap(), echoText, defaultUnit)
        ? describeReading(echoReading.unwrap(), defaultUnit, prec, inheritedTolerance)
        : describeInherited(echoReading.unwrap(), defaultUnit, prec, inheritedTolerance)
      : undefined

  const showComputed =
    !focused &&
    draft === null &&
    value !== undefined &&
    reading.isOk() &&
    showsComputedValue(reading.unwrap(), defaultUnit)
  const shownReading = reading.isOk() ? reading : echoReading
  const writtenUnit = shownReading.isOk()
    ? shownReading
        .unwrap()
        .nominal.map((n) => n.unit.isSome())
        .unwrapOr(false)
    : false
  const suffix = showComputed || writtenUnit ? undefined : UNIT_LABEL[defaultUnit] || undefined

  const mark = explained?.mark
  const overlay = mark ? (
    <span ref={overlayRef} className={styles['layer']}>
      {text.slice(0, mark.start)}
      <span className={styles['mark']} data-at-end={mark.start === mark.end || undefined}>
        {mark.start === mark.end ? ' ' : text.slice(mark.start, mark.end)}
      </span>
    </span>
  ) : showComputed ? (
    <span ref={overlayRef} className={styles['layer']}>
      {text}
      <span className={styles['computed']}>
        {' · '}
        {formatValue(value.exact, defaultUnit, prec)}
      </span>
    </span>
  ) : null

  const recommendedReading = recommended
    ? readSource(recommended.source, ctx, resolver, validate)
    : undefined
  const fixAvailable =
    recommendedReading !== undefined &&
    recommendedReading.isOk() &&
    (value === undefined || !value.equals(recommendedReading.unwrap().quantity))

  // the adjust panel (ui.md#field): under the field, opened on focus; a pointer press in it never
  // takes focus from the input, its controls are out of the Tab order (⌘↓ / Ctrl+↓ moves in)
  const panel = panelShown ? (
    <div
      ref={panelRef}
      id={panelId}
      role="dialog"
      aria-label={quantityText.adjust(label)}
      className={styles['panel']}
      onMouseDown={(e) => e.preventDefault()}
      onKeyDown={onPanelKeyDown}
      onBlur={(e) => focusLeft(e.relatedTarget)}
    >
      <div className={styles['title']}>
        {quantityText.adjust(label)}
        <span>{quantityText.adjustHint()}</span>
      </div>
      <SegmentedControl
        label={quantityText.step()}
        size="sm"
        tabbable={false}
        options={ladder.steps.map((s) => ({ value: s, label: stepLabel(s) }))}
        value={step}
        onValueChange={(s) => {
          setStepSize(s)
          memory.set(memoryKey, s)
        }}
      />
      <div className={styles['adjust']}>
        <Button
          tabIndex={-1}
          aria-label={quantityText.decrease()}
          disabled={!steppable}
          onClick={() => stepBy(-1, Rational.ONE, true)}
        >
          −
        </Button>
        <output className={styles['value']}>
          {text}
          {suffix ? <small>{suffix}</small> : null}
        </output>
        <Button
          tabIndex={-1}
          aria-label={quantityText.increase()}
          disabled={!steppable}
          onClick={() => stepBy(1, Rational.ONE, true)}
        >
          +
        </Button>
      </div>
      {steppable ? null : <p className={styles['note']}>{quantityText.stepsNeedNumber()}</p>}
      {recommended ? (
        <div className={styles['recommended']}>
          <span>
            {quantityText.recommended()} <b>{recommended.text}</b>
          </span>
          <Button
            tabIndex={-1}
            size="sm"
            variant="primary"
            icon={<Icon name="check" />}
            disabled={!fixAvailable}
            onClick={() => {
              const fromPanel = panelRef.current?.contains(document.activeElement) ?? false
              commitSource(recommended.source, startSession())
              closeAdjust()
              if (fromPanel) returnToInput()
            }}
          >
            {quantityText.fix(recommended.source)}
          </Button>
        </div>
      ) : null}
      {onPick ? (
        <Button
          tabIndex={-1}
          size="sm"
          variant="ghost"
          icon={<Icon name="pick" />}
          aria-pressed={picking}
          className={styles['pickToggle']}
          onClick={togglePick}
        >
          {quantityText.pick(label)}
          <kbd aria-hidden="true">⌥P</kbd>
        </Button>
      ) : null}
    </div>
  ) : null

  const activeId = list ? `${listId}-${list.active}` : undefined
  // a combobox whose popup is the reference list while it is open, else the adjust panel
  const combobox = hasPanel
    ? {
        role: 'combobox' as const,
        ...(references.length > 0 ? { 'aria-autocomplete': 'list' as const } : {}),
        'aria-haspopup': list ? ('listbox' as const) : ('dialog' as const),
        'aria-expanded': list !== null || panelShown,
        ...(list ? { 'aria-controls': listId } : panelShown ? { 'aria-controls': panelId } : {}),
        ...(activeId ? { 'aria-activedescendant': activeId } : {}),
      }
    : references.length > 0 && !readOnly
      ? {
          role: 'combobox' as const,
          'aria-autocomplete': 'list' as const,
          'aria-expanded': list !== null,
          ...(list ? { 'aria-controls': listId } : {}),
          ...(activeId ? { 'aria-activedescendant': activeId } : {}),
        }
      : {}

  return (
    <Field
      label={label}
      illustration={illustration}
      {...(info !== undefined ? { info } : {})}
      {...(tag !== undefined ? { tag } : {})}
      onLabelPress={returnToInput}
      {...(lock ? { lock } : {})}
      {...(echo !== undefined ? { echo } : {})}
      messages={[
        ...messages,
        ...(errorMessage ? [errorMessage] : []),
        ...(kept
          ? [
              {
                id: 'quantity.adjustKept',
                severity: 'info' as const,
                text: quantityText.adjustKept(),
              },
            ]
          : []),
      ]}
      readOnly={readOnly}
      popup={panel}
      className={className}
    >
      <ControlSlot
        render={(control) => (
          <div className={styles['wrap']}>
            <FieldInput
              {...control}
              {...combobox}
              ref={inputRef}
              value={text}
              {...(placeholder !== undefined ? { placeholder } : {})}
              {...(suffix !== undefined && !dense ? { unit: suffix } : {})}
              overlay={overlay}
              autoComplete="off"
              onChange={(e) => edit(e.target.value, e.target.selectionStart)}
              onKeyDown={onKeyDown}
              onScroll={syncScroll}
              onSelect={syncScroll}
              onClick={() => {
                if (!adjustOpen) openAdjust()
              }}
              onFocus={(e) => {
                setFocused(true)
                setEchoText(text)
                // focus arriving from outside the field preselects the step for the value now
                const from = e.relatedTarget
                const inside = from instanceof Node && (panelRef.current?.contains(from) ?? false)
                if (!inside && session.current === null) setStepSize(ladder.initial)
                if (!returning.current) openAdjust()
              }}
              onBlur={(e) => {
                lastSelection.current = [
                  e.currentTarget.selectionStart ?? text.length,
                  e.currentTarget.selectionEnd ?? text.length,
                ]
                setFocused(false)
                setList(null)
                commit()
                focusLeft(e.relatedTarget)
              }}
            />
            {list ? (
              <ul
                id={listId}
                role="listbox"
                aria-label={quantityText.references(label)}
                className={styles['list']}
              >
                {list.options.map((o, i) => (
                  <li
                    key={o.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === list.active}
                    className={styles['option']}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => accept(o)}
                  >
                    <span>{o.id}</span>
                    {o.label ? <span className={styles['optionLabel']}>{o.label}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      />
    </Field>
  )
}

/** Receives the Field's control props (id, aria-describedby, aria-invalid, readOnly). */
function ControlSlot({
  render,
  ...control
}: FieldControlProps & { render: (control: FieldControlProps) => ReactNode }): ReactNode {
  return render(control)
}
