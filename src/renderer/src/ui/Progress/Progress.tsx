// Progress: determinate when the total is known, indeterminate otherwise (amber bar). Shown only
// after --delay-indicator by its caller (jobs). Under reduced motion the indeterminate bar is static.
// Doc: docs/conventions/ui.md#jobs-and-progress, #motion
import { Progress as RadixProgress } from 'radix-ui'
import styles from './Progress.module.css'

export interface ProgressProps {
  /** Accessible name ("Toolpath generation"). */
  label: string
  /** Done so far; `null` = indeterminate. */
  value: number | null
  max?: number
  /** Readable value text, e.g. "Line 1 884 of 3 020". */
  valueText?: string
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
}

export function Progress({
  label,
  value,
  max = 100,
  valueText,
  className,
}: ProgressProps): React.JSX.Element {
  const pct = value === null ? null : Math.min(100, Math.max(0, (value / max) * 100))
  return (
    <RadixProgress.Root
      aria-label={label}
      value={value}
      max={max}
      {...(valueText ? { getValueLabel: () => valueText } : {})}
      className={[styles['track'], className].filter(Boolean).join(' ')}
    >
      <RadixProgress.Indicator
        className={styles['bar']}
        style={pct === null ? undefined : { width: `${pct}%` }}
      />
    </RadixProgress.Root>
  )
}
