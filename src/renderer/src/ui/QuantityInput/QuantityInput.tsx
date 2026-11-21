// QuantityInput: every dimensional field (task 3.4). A Field whose input keeps the source as typed
// (`1/16"`, `D/2 ±0.01`), reads it with the core parser/evaluator, echoes the reading while typing
// when the text alone does not show it,
// shows errors in place (underline, catalogue message, verified fix), commits a valid value on
// Enter/blur (one `onCommit` = one command = one undo step), reverts on Escape and never commits
// an invalid value. An optional field (`optional`) commits an emptied field as unset. Steppers (↑/↓, adjust popover), reference autocomplete and the pick button
// hook (pick mode itself belongs to the viewport) live here too.
// Doc: docs/conventions/ui.md#quantity-and-expression-input, #field, #selection-and-picking;
// grammar and errors: docs/architecture/quantities.md
import { Check, Crosshair } from 'lucide-react'
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
import { Button } from '../Button/Button'
import { Field, type FieldControlProps, type FieldMessage, type FieldProps } from '../Field/Field'
import { FieldAdjustButton, FieldInput } from '../Field/FieldInput'
import { Popover } from '../Popover/Popover'
import { SegmentedControl } from '../SegmentedControl/SegmentedControl'
import { Tooltip } from '../Tooltip/Tooltip'
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
} from './reading'
import styles from './QuantityInput.module.css'

/** Echo after this pause in typing (ui.md: debounced 150 ms). */
export const ECHO_DELAY_MS = 150
/** Errors appear on blur, Enter, or after this pause in typing – never mid-word. */
export const ERROR_DELAY_MS = 600

export const STEP_SIZES = ['0.001', '0.01', '0.1', '1', '10', '100'] as const
export type StepSize = (typeof STEP_SIZES)[number]

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
      /** A valid, changed value on Enter, blur, a fix or the adjust popover: dispatch one command. */
      onCommit: (value: Quantity) => void
    }
  | {
      optional: true
      /** As above; `undefined` when a stored value was emptied (unset). */
      onCommit: (value: Quantity | undefined) => void
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
  /** Initial step of ↑/↓ and the adjust popover, in the source's unit. */
  step?: StepSize
  /** General tolerance an untoleranced value inherits, shown in the echo. */
  inheritedTolerance?: InheritedTolerance
  /** Recommended value: the pencil turns amber and the popover offers "Use …". */
  recommended?: { source: string; text: ReactNode }
  /**
   * Pick button (and Alt+P): enter pick mode for a surface reference. Call `insert` with the
   * picked reference; it goes in at the caret (replacing the selection) and focus returns.
   */
  onPick?: (insert: (reference: string) => void) => void
  /** Pick mode is active for this field (pick button pressed). */
  picking?: boolean
  illustration?: ReactNode
  lock?: FieldProps['lock']
  /** Warnings, notes and recommendations from checks; parse errors are added by the field. */
  messages?: readonly FieldMessage[]
  readOnly?: boolean
  className?: string | undefined
}

interface ListState {
  /** Start of the name being completed and the caret (the replaced range). */
  start: number
  end: number
  options: readonly ReferenceOption[]
  active: number
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
    step = '1',
    inheritedTolerance,
    recommended,
    onPick,
    picking = false,
    illustration,
    lock,
    messages = [],
    readOnly = false,
    className,
  } = props
  const ctx: ParseContext = useMemo(() => ({ kind, defaultUnit }), [kind, defaultUnit])
  const prec = precision ?? defaultPrecision(defaultUnit)
  const stored = value?.source ?? ''
  const listId = `${useId()}-references`

  /** What the user typed; null = showing the stored source. */
  const [draft, setDraft] = useState<string | null>(null)
  /** Last committed draft, until the stored value catches up. */
  const [committed, setCommitted] = useState<string | null>(null)
  const [seen, setSeen] = useState(stored)
  const [focused, setFocused] = useState(false)
  const [errorsShown, setErrorsShown] = useState(false)
  const [echoText, setEchoText] = useState(stored)
  const [stepSize, setStepSize] = useState<StepSize>(step)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [list, setList] = useState<ListState | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const overlayRef = useRef<HTMLSpanElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const lastSelection = useRef<[number, number] | null>(null)
  const storedRef = useRef(stored)

  // The stored value changed (commit landed, undo, agent edit): follow it unless the user is
  // typing something else.
  if (stored !== seen) {
    setSeen(stored)
    if (draft !== null && (draft === committed || !focused)) {
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
    setDraft(next)
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

  /** Commit `source` if it reads and differs from what is stored; false if invalid. */
  function commitSource(source: string): boolean {
    if (readOnly) return true
    if (value !== undefined && source === stored) {
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
      if (props.optional) props.onCommit(undefined)
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
    props.onCommit(r.unwrap().quantity)
    return true
  }

  const commit = (): boolean => (draft === null ? true : commitSource(draft))

  function revert(): void {
    setDraft(null)
    setCommitted(null)
    setErrorsShown(false)
    setList(null)
  }

  const steppable = stepSource(text, ctx, Rational.ONE, prec).isSome()

  function stepBy(direction: 1 | -1, multiplier: Rational = Rational.ONE): boolean {
    const delta = stepRational(stepSize)
      .mul(multiplier)
      .mul(Rational.int(BigInt(direction)))
    const next = stepSource(text, ctx, delta, prec)
    if (next.isNone()) return false
    setDraft(next.unwrap())
    setErrorsShown(false)
    return true
  }

  function insert(reference: string): void {
    const input = inputRef.current
    setDraft((d) => {
      const current = d ?? storedRef.current
      const [from, to] = lastSelection.current ?? [0, current.length]
      pendingCaret.current = from + reference.length
      return current.slice(0, from) + reference + current.slice(to)
    })
    setErrorsShown(false)
    input?.focus()
  }

  const startPick = (): void => onPick?.(insert)

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
      startPick()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
      return
    }
    if (e.key === 'Escape') {
      if (draft === null && !errorsShown) return
      e.preventDefault()
      e.stopPropagation()
      revert()
      return
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !readOnly) {
      const multiplier = e.shiftKey ? TEN : e.altKey ? TENTH : Rational.ONE
      if (stepBy(e.key === 'ArrowUp' ? 1 : -1, multiplier)) e.preventDefault()
      else if (e.key === 'ArrowDown' && references.length > 0 && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        updateList(text, caret, true)
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

  const adjust = readOnly ? null : (
    <>
      {onPick ? (
        <Tooltip content={quantityText.pick(label)} shortcut="⌥P">
          <button
            type="button"
            className={styles['pick']}
            aria-label={quantityText.pick(label)}
            aria-pressed={picking}
            onClick={startPick}
          >
            <Crosshair aria-hidden="true" />
          </button>
        </Tooltip>
      ) : null}
      <Popover
        label={quantityText.adjust(label)}
        title={
          <span className={styles['title']}>
            {quantityText.adjust(label)}
            <span>{quantityText.stepKeys()}</span>
          </span>
        }
        open={adjustOpen}
        onOpenChange={(open) => {
          setAdjustOpen(open)
          if (!open) commit()
        }}
        content={
          <>
            <SegmentedControl
              label={quantityText.step()}
              size="sm"
              options={STEP_SIZES.map((s) => ({ value: s, label: s.replace(/^0\./, '.') }))}
              value={stepSize}
              onValueChange={setStepSize}
            />
            <div className={styles['adjust']}>
              <Button
                aria-label={quantityText.decrease()}
                disabled={!steppable}
                onClick={() => stepBy(-1)}
              >
                −
              </Button>
              <output className={styles['value']}>
                {text}
                {suffix ? <small>{suffix}</small> : null}
              </output>
              <Button
                aria-label={quantityText.increase()}
                disabled={!steppable}
                onClick={() => stepBy(1)}
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
                  size="sm"
                  variant="primary"
                  icon={<Check aria-hidden="true" />}
                  disabled={!fixAvailable}
                  onClick={() => {
                    commitSource(recommended.source)
                    setAdjustOpen(false)
                  }}
                >
                  {quantityText.fix(recommended.source)}
                </Button>
              </div>
            ) : null}
          </>
        }
      >
        <FieldAdjustButton label={quantityText.adjust(label)} fix={fixAvailable} />
      </Popover>
    </>
  )

  const activeId = list ? `${listId}-${list.active}` : undefined
  const combobox =
    references.length > 0 && !readOnly
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
      {...(lock ? { lock } : {})}
      {...(echo !== undefined ? { echo } : {})}
      messages={errorMessage ? [...messages, errorMessage] : messages}
      readOnly={readOnly}
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
              {...(suffix !== undefined ? { unit: suffix } : {})}
              adjust={adjust}
              overlay={overlay}
              autoComplete="off"
              onChange={(e) => edit(e.target.value, e.target.selectionStart)}
              onKeyDown={onKeyDown}
              onScroll={syncScroll}
              onSelect={syncScroll}
              onFocus={() => {
                setFocused(true)
                setEchoText(text)
              }}
              onBlur={(e) => {
                lastSelection.current = [
                  e.currentTarget.selectionStart ?? text.length,
                  e.currentTarget.selectionEnd ?? text.length,
                ]
                setFocused(false)
                setList(null)
                commit()
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
