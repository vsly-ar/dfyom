// Field: illustration + label, lock (only while a recommendation mode is on), the control, and one support area under the control that
// looks pulled out from under it (echo, the highest-severity status with its fix, further notes
// collapsed; a dismissed soft warning collapses to "1 dismissed · Show"). Wires the control's
// id, aria-describedby and aria-invalid. Structure only: the quantity behaviour is QuantityInput
// (task 3.4). Doc: docs/conventions/ui.md#field, severities: ui.md#warnings-and-dfm (decision 21)
import { Icon } from '../icons/Icon'
import {
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { Button } from '../Button/Button'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './Field.module.css'
import { afterPointerRelease, trackPointer } from './pointerRelease'

/**
 * The id of an element saying why the fields inside are read-only ("Part of Hole 1: change it in
 * the hole.", task U1): every read-only `Field` below adds it to its control's
 * `aria-describedby` (ui.md § Accessibility (feature UI)). One note for a whole group of fields.
 */
const ReadOnlyReasonContext = createContext<string | undefined>(undefined)

export function ReadOnlyReason({
  id,
  children,
}: {
  id: string
  children: ReactNode
}): React.JSX.Element {
  return <ReadOnlyReasonContext.Provider value={id}>{children}</ReadOnlyReasonContext.Provider>
}

/** Support-area tiers: error blocks Generate; hard and soft warn (soft can be dismissed). */
export type FieldSeverity = 'error' | 'hard' | 'soft' | 'info' | 'note'

export interface FieldMessage {
  /** Stable id (e.g. the check code) so a dismissal survives re-renders. */
  id: string
  severity: FieldSeverity
  text: ReactNode
  /**
   * One-click fix ("Use 3.00"), dispatched as one command by the caller. A warning's fix shows a
   * check (it settles the value); `icon` replaces it for a fix that adds something (a plus for
   * "Add to library").
   */
  fix?: { label: string; onApply: () => void; icon?: ReactNode }
  /**
   * A second, plain action after the fix (e.g. "Add to library" beside "Use wexme 1/4″ 1F"):
   * shown only with a `fix`, on a non-error message.
   */
  alternative?: { label: string; onApply: () => void; icon?: ReactNode }
  /** Replaces the severity's icon (e.g. a lock for read-only notes). */
  icon?: ReactNode
}

const RANK: Record<FieldSeverity, number> = { error: 0, hard: 1, soft: 2, info: 3, note: 4 }

const ICON: Record<FieldSeverity, ReactNode> = {
  error: <Icon name="error" />,
  hard: <Icon name="warning" />,
  soft: <Icon name="warning" />,
  info: <Icon name="info" />,
  note: <Icon name="info" />,
}

/** Props the Field adds to its control (any element that spreads them onto its focusable node). */
export interface FieldControlProps {
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
  readOnly?: boolean
}

export interface FieldLock {
  locked: boolean
  onLockedChange: (locked: boolean) => void
  /** Why the lock can't be pressed now (invalid value, machine limit, …). */
  disabledReason?: string | undefined
  /** Accessible name; defaults to "Lock <label>" for a text label, else "Lock value". */
  name?: string | undefined
}

export interface FieldProps {
  label: ReactNode
  /** A `FieldIcon` (ui/icons/field); the measured part is the amber line. */
  illustration?: ReactNode
  /**
   * The lock between label and control: pressed = the other recommendations follow this value.
   * Omit it to hide the lock (no recommendation mode, or nothing depends on the field).
   * `disabledReason` makes it `aria-disabled` (still focusable), with the reason as its tooltip
   * and as visible text in the support area (docs/conventions/ui.md#field).
   */
  lock?: FieldLock
  /** How the input is read, while typing ("= 1.588 mm"). */
  echo?: ReactNode
  messages?: readonly FieldMessage[]
  /** Read-only look: desaturated illustration, dashed control, dimmed support area. */
  readOnly?: boolean
  /** `toggle` for fields without a value input (checkbox, switch, button): full-colour illustration. */
  kind?: 'value' | 'toggle'
  /** The control; receives `FieldControlProps`. */
  children: ReactElement<FieldControlProps>
  /**
   * A popup under the whole field (below the support area), positioned by its own class against
   * the field: QuantityInput's adjust panel (ui.md#field). Comes after the support area in DOM
   * and Tab order.
   */
  popup?: ReactNode
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
}

export function Field({
  label,
  illustration,
  lock,
  echo,
  messages = [],
  readOnly = false,
  kind = 'value',
  children,
  popup,
  className,
}: FieldProps): React.JSX.Element {
  const base = useId()
  const readOnlyReason = useContext(ReadOnlyReasonContext)
  const controlId = children.props.id ?? `${base}-control`
  const echoId = `${base}-echo`
  const statusId = `${base}-status`
  const moreId = `${base}-more`
  const lockReasonId = `${base}-lock-reason`
  const lockName = lock?.name ?? (typeof label === 'string' ? `Lock ${label}` : 'Lock value')
  const lockDisabled = lock?.disabledReason !== undefined

  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState(false)
  const showRef = useRef<HTMLButtonElement>(null)
  const dismissRef = useRef<HTMLButtonElement>(null)
  // after dismiss/show, focus moves to the button that replaced the one just clicked
  const focusNext = useRef<'show' | 'dismiss' | null>(null)
  useEffect(() => {
    const next = focusNext.current
    if (!next) return
    focusNext.current = null
    ;(next === 'show' ? showRef : dismissRef).current?.focus()
  })

  // The echo outlives its prop until the click that blurred the field has landed, then the
  // support area collapses with a short ease (ui.md#field: support area collapse).
  const [shownEcho, setShownEcho] = useState<ReactNode>(echo)
  const [echoLeaving, setEchoLeaving] = useState(false)
  if (echo !== undefined && (shownEcho !== echo || echoLeaving)) {
    setShownEcho(echo)
    setEchoLeaving(false)
  }
  const shown = echo ?? shownEcho
  const fieldRef = useRef<HTMLDivElement>(null)
  const supportRef = useRef<HTMLDivElement>(null)
  const echoRef = useRef<HTMLDivElement>(null)
  useEffect(trackPointer, [])
  useEffect(() => {
    if (echo !== undefined || shownEcho === undefined || echoLeaving) return
    // still focused (the echo gave way to an error): no layout to protect, and a stale echo
    // never sits next to an error, so it goes at once
    const focused = fieldRef.current?.contains(document.activeElement) ?? false
    if (focused) return void Promise.resolve().then(() => setShownEcho(undefined))
    return afterPointerRelease(() => setEchoLeaving(true))
  }, [echo, shownEcho, echoLeaving])
  useLayoutEffect(() => {
    if (!echoLeaving) return
    const done = (): void => {
      setShownEcho(undefined)
      setEchoLeaving(false)
    }
    // the whole support area when the echo is all it holds, else the echo line alone
    const support = supportRef.current
    const echoOnly = support !== null && support.childElementCount === 1
    const animations = echoOnly
      ? collapse(support, fieldRef.current)
      : collapse(echoRef.current, null)
    if (animations.length === 0) return done()
    let live = true
    void Promise.all(animations.map((a) => a.finished)).then(
      () => {
        if (live) done()
      },
      () => {},
    )
    return () => {
      live = false
      for (const a of animations) a.cancel()
    }
  }, [echoLeaving])

  const visible = messages
    .filter((m) => !(m.severity === 'soft' && dismissed.has(m.id)))
    .toSorted((a, b) => RANK[a.severity] - RANK[b.severity])
  const [primary, ...rest] = visible
  const dismissedCount = messages.filter((m) => m.severity === 'soft' && dismissed.has(m.id)).length
  const invalid = messages.some((m) => m.severity === 'error')
  const tier = primary && RANK[primary.severity] <= RANK.soft ? primary.severity : 'none'

  const describedBy = [
    children.props['aria-describedby'],
    shown !== undefined ? echoId : undefined,
    primary ? statusId : undefined,
    readOnly ? readOnlyReason : undefined,
  ]
    .filter(Boolean)
    .join(' ')

  const control = isValidElement(children)
    ? cloneElement(children, {
        id: controlId,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(invalid ? { 'aria-invalid': true } : {}),
        ...(readOnly && kind === 'value' ? { readOnly: true } : {}),
      })
    : children

  const hasOthers = primary !== undefined || dismissedCount > 0 || rest.length > 0 || lockDisabled
  const hasSupport = shown !== undefined || hasOthers

  return (
    <div
      data-kind={kind}
      data-readonly={readOnly || undefined}
      data-invalid={invalid || undefined}
      ref={fieldRef}
      className={[styles['field'], className].filter(Boolean).join(' ')}
    >
      <label htmlFor={controlId} className={styles['label']}>
        {illustration ? <span className={styles['illustration']}>{illustration}</span> : null}
        {label}
      </label>
      {lock ? (
        <Tooltip content={lock.disabledReason ?? lockName}>
          <button
            type="button"
            className={styles['lock']}
            aria-label={lockName}
            aria-pressed={lock.locked}
            {...(lockDisabled ? { 'aria-disabled': true, 'aria-describedby': lockReasonId } : {})}
            onClick={() => {
              if (!lockDisabled) lock.onLockedChange(!lock.locked)
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
              <path
                d={lock.locked ? 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' : 'M5.5 7V5a2.5 2.5 0 0 1 4.9-.7'}
              />
            </svg>
          </button>
        </Tooltip>
      ) : null}
      <div className={styles['control']}>{control}</div>
      {hasSupport ? (
        <div ref={supportRef} className={styles['support']} data-tier={tier}>
          {shown !== undefined ? (
            <div ref={echoRef} id={echoId} className={styles['item']} data-severity="echo">
              <span />
              <span>{shown}</span>
              <span />
            </div>
          ) : null}
          {primary ? (
            <div className={styles['item']} data-severity={primary.severity}>
              {primary.icon ?? ICON[primary.severity]}
              <span id={statusId}>{primary.text}</span>
              <span className={styles['actions']}>
                {primary.fix ? (
                  // a warning's fix is the suggested action (primary); an error's fix is a plain
                  // correction of the typed text, as on the design system page
                  primary.severity === 'error' ? (
                    <Button size="sm" onClick={primary.fix.onApply}>
                      {primary.fix.label}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={primary.fix.icon ?? <Icon name="check" />}
                      onClick={primary.fix.onApply}
                    >
                      {primary.fix.label}
                    </Button>
                  )
                ) : null}
                {primary.fix && primary.alternative && primary.severity !== 'error' ? (
                  <Button
                    size="sm"
                    {...(primary.alternative.icon ? { icon: primary.alternative.icon } : {})}
                    onClick={primary.alternative.onApply}
                  >
                    {primary.alternative.label}
                  </Button>
                ) : null}
                {primary.severity === 'soft' ? (
                  <Tooltip content="Dismiss">
                    <button
                      ref={dismissRef}
                      type="button"
                      className={styles['quick']}
                      aria-label="Dismiss warning"
                      onClick={() => {
                        focusNext.current = 'show'
                        setDismissed((d) => new Set(d).add(primary.id))
                      }}
                    >
                      <Icon name="close" />
                    </button>
                  </Tooltip>
                ) : null}
              </span>
            </div>
          ) : null}
          {lock?.disabledReason !== undefined ? (
            <div className={styles['item']} data-severity="note">
              <Icon name="lock" />
              <span id={lockReasonId}>{lock.disabledReason}</span>
              <span />
            </div>
          ) : null}
          {dismissedCount > 0 ? (
            <button
              ref={showRef}
              type="button"
              className={styles['more']}
              onClick={() => {
                focusNext.current = 'dismiss'
                setDismissed(new Set())
              }}
            >
              <Icon name="warning" />
              {dismissedCount} dismissed · Show
            </button>
          ) : null}
          {rest.length > 0 ? (
            <>
              <button
                type="button"
                className={styles['more']}
                aria-expanded={expanded}
                aria-controls={moreId}
                onClick={() => setExpanded((e) => !e)}
              >
                {expanded ? 'Fewer' : `${rest.length} more`}
                <Icon name="chevron-down" className={styles['chevron']} />
              </button>
              <div id={moreId} className={styles['extra']} hidden={!expanded}>
                {rest.map((m) => (
                  <div key={m.id} className={styles['item']} data-severity={m.severity}>
                    {m.icon ?? ICON[m.severity]}
                    <span>{m.text}</span>
                    <span />
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {popup}
    </div>
  )
}

/** Motion token in ms from the root style; 0 when reduced motion zeroes it or it is unset. */
function motionMs(name: string): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? (v.endsWith('ms') ? n : n * 1000) : 0
}

/**
 * Collapse `el` to zero height (and the field's row gap above it) with --motion-base and
 * --ease-standard. No animations when motion is reduced or the platform has no Web Animations.
 */
function collapse(el: HTMLElement | null, field: HTMLElement | null): Animation[] {
  if (!el || typeof el.animate !== 'function') return []
  const duration = motionMs('--motion-base')
  if (duration <= 0) return []
  const easing =
    getComputedStyle(document.documentElement).getPropertyValue('--ease-standard').trim() ||
    'ease-out'
  const style = getComputedStyle(el)
  const timing: KeyframeAnimationOptions = { duration, easing, fill: 'forwards' }
  const from: Keyframe = {
    height: `${el.getBoundingClientRect().height}px`,
    minHeight: '0px',
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    opacity: 1,
    overflow: 'hidden',
  }
  const to: Keyframe = {
    height: '0px',
    minHeight: '0px',
    paddingTop: '0px',
    paddingBottom: '0px',
    opacity: 0,
    overflow: 'hidden',
  }
  const animations = [el.animate([from, to], timing)]
  if (field) {
    const gap = getComputedStyle(field).rowGap
    animations.push(field.animate([{ rowGap: gap }, { rowGap: '0px' }], timing))
  }
  return animations
}
