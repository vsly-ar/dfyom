// Field: illustration + label, lock, the control, and one support area under the control that
// looks pulled out from under it (echo, the highest-severity status with its fix, further notes
// collapsed; a dismissed soft warning collapses to "1 dismissed · Show"). Wires the control's
// id, aria-describedby and aria-invalid. Structure only: the quantity behaviour is QuantityInput
// (task 3.4). Doc: docs/conventions/ui.md#field, severities: ui.md#warnings-and-dfm (decision 21)
import { Check, ChevronDown, CircleAlert, Info, TriangleAlert, X } from 'lucide-react'
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { Button } from '../Button/Button'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './Field.module.css'

/** Support-area tiers: error blocks Generate; hard and soft warn (soft can be dismissed). */
export type FieldSeverity = 'error' | 'hard' | 'soft' | 'info' | 'note'

export interface FieldMessage {
  /** Stable id (e.g. the check code) so a dismissal survives re-renders. */
  id: string
  severity: FieldSeverity
  text: ReactNode
  /** One-click fix ("Use 3.00"), dispatched as one command by the caller. */
  fix?: { label: string; onApply: () => void }
  /** Replaces the severity's icon (e.g. a lock for read-only notes). */
  icon?: ReactNode
}

const RANK: Record<FieldSeverity, number> = { error: 0, hard: 1, soft: 2, info: 3, note: 4 }

const ICON: Record<FieldSeverity, ReactNode> = {
  error: <CircleAlert aria-hidden="true" />,
  hard: <TriangleAlert aria-hidden="true" />,
  soft: <TriangleAlert aria-hidden="true" />,
  info: <Info aria-hidden="true" />,
  note: <Info aria-hidden="true" />,
}

/** Props the Field adds to its control (any element that spreads them onto its focusable node). */
export interface FieldControlProps {
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
  readOnly?: boolean
}

export interface FieldProps {
  label: ReactNode
  /** A `FieldIcon` (ui/icons/field); the measured part is the amber line. */
  illustration?: ReactNode
  /** Whether the value follows the recommendation; renders the lock between label and control. */
  lock?: { locked: boolean; onLockedChange: (locked: boolean) => void }
  /** How the input is read, while typing ("= 1.588 mm"). */
  echo?: ReactNode
  messages?: readonly FieldMessage[]
  /** Read-only look: desaturated illustration, dashed control, dimmed support area. */
  readOnly?: boolean
  /** `toggle` for fields without a value input (checkbox, switch, button): full-colour illustration. */
  kind?: 'value' | 'toggle'
  /** The control; receives `FieldControlProps`. */
  children: ReactElement<FieldControlProps>
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
  className,
}: FieldProps): React.JSX.Element {
  const base = useId()
  const controlId = children.props.id ?? `${base}-control`
  const echoId = `${base}-echo`
  const statusId = `${base}-status`
  const moreId = `${base}-more`

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

  const visible = messages
    .filter((m) => !(m.severity === 'soft' && dismissed.has(m.id)))
    .toSorted((a, b) => RANK[a.severity] - RANK[b.severity])
  const [primary, ...rest] = visible
  const dismissedCount = messages.filter((m) => m.severity === 'soft' && dismissed.has(m.id)).length
  const invalid = messages.some((m) => m.severity === 'error')
  const tier = primary && RANK[primary.severity] <= RANK.soft ? primary.severity : 'none'

  const describedBy = [
    children.props['aria-describedby'],
    echo !== undefined ? echoId : undefined,
    primary ? statusId : undefined,
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

  const hasSupport =
    echo !== undefined || primary !== undefined || dismissedCount > 0 || rest.length > 0

  return (
    <div
      data-kind={kind}
      data-readonly={readOnly || undefined}
      data-invalid={invalid || undefined}
      className={[styles['field'], className].filter(Boolean).join(' ')}
    >
      <label htmlFor={controlId} className={styles['label']}>
        {illustration ? <span className={styles['illustration']}>{illustration}</span> : null}
        {label}
      </label>
      {lock ? (
        <Tooltip content="Lock value">
          <button
            type="button"
            className={styles['lock']}
            aria-label="Lock value"
            aria-pressed={lock.locked}
            onClick={() => lock.onLockedChange(!lock.locked)}
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
        <div className={styles['support']} data-tier={tier}>
          {echo !== undefined ? (
            <div id={echoId} className={styles['item']} data-severity="echo">
              <span />
              <span>{echo}</span>
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
                      icon={<Check aria-hidden="true" />}
                      onClick={primary.fix.onApply}
                    >
                      {primary.fix.label}
                    </Button>
                  )
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
                      <X aria-hidden="true" />
                    </button>
                  </Tooltip>
                ) : null}
              </span>
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
              <TriangleAlert aria-hidden="true" />
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
                <ChevronDown aria-hidden="true" className={styles['chevron']} />
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
    </div>
  )
}
