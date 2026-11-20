// SegmentedControl: one choice of a few (strategy, unit system, inspector sections); amber thumb
// with dark text slides to the selection. Radix ToggleGroup (radiogroup, roving arrow keys).
// Doc: docs/conventions/ui.md#inventory-v01, #design-system (thumb stays amber)
import { ToggleGroup } from 'radix-ui'
import { useRef } from 'react'
import { useSlidingIndicator } from '../useSlidingIndicator'
import styles from './SegmentedControl.module.css'

export interface SegmentedOption<V extends string> {
  value: V
  label: string
  disabled?: boolean
}

export interface SegmentedControlProps<V extends string> {
  /** Accessible name of the group (e.g. "Cut direction"). */
  label: string
  options: readonly SegmentedOption<V>[]
  value: V
  onValueChange: (value: V) => void
  size?: 'sm' | 'md'
  disabled?: boolean
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
}

export function SegmentedControl<V extends string>({
  label,
  options,
  value,
  onValueChange,
  size = 'md',
  disabled = false,
  className,
}: SegmentedControlProps<V>): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const thumb = useSlidingIndicator(root, '[data-state="on"]', value)
  return (
    <ToggleGroup.Root
      ref={root}
      type="single"
      aria-label={label}
      value={value}
      // a single choice is always set: ignore Radix's deselect (empty value)
      onValueChange={(v) => {
        if (v) onValueChange(v as V)
      }}
      disabled={disabled}
      data-size={size}
      className={[styles['root'], className].filter(Boolean).join(' ')}
    >
      <span className={styles['thumb']} style={thumb} aria-hidden="true" />
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled ?? false}
          className={styles['item']}
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
