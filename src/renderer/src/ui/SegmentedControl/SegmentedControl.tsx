// SegmentedControl: one choice of a few (strategy, unit system, inspector sections); amber thumb
// with dark text slides to the selection. Radix ToggleGroup (radiogroup, roving arrow keys).
// Doc: docs/conventions/ui.md#inventory-v01, #design-system (thumb stays amber)
import { ToggleGroup } from 'radix-ui'
import { useRef, type ReactNode } from 'react'
import { useSlidingIndicator } from '../useSlidingIndicator'
import styles from './SegmentedControl.module.css'

export interface SegmentedOption<V extends string> {
  value: V
  label: string
  disabled?: boolean
  /** A small icon before the label (decorative: the label names the option; hole types, v0.4). */
  icon?: ReactNode
  /**
   * The full name when `label` is a shortened one (a fourth hole type, H1): the option's
   * accessible name and its native tip.
   */
  fullLabel?: string
}

export interface SegmentedControlProps<V extends string> {
  /** Accessible name of the group (e.g. "Cut direction"). */
  label: string
  options: readonly SegmentedOption<V>[]
  value: V
  onValueChange: (value: V) => void
  size?: 'sm' | 'md'
  disabled?: boolean
  /**
   * False: the options are out of the Tab order and arrow keys are left to the owner, which moves
   * focus itself (the field's adjust panel, ui.md#field). Default true: Radix roving focus.
   */
  tabbable?: boolean
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
  /** Set by a wrapping `Field` (DF45): its support area (hint, status) describes the group. */
  id?: string
  'aria-describedby'?: string
}

export function SegmentedControl<V extends string>({
  label,
  options,
  value,
  onValueChange,
  size = 'md',
  disabled = false,
  tabbable = true,
  className,
  id,
  'aria-describedby': describedBy,
}: SegmentedControlProps<V>): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const thumb = useSlidingIndicator(root, '[data-state="on"]', value)
  return (
    <ToggleGroup.Root
      ref={root}
      type="single"
      aria-label={label}
      {...(id === undefined ? {} : { id })}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
      value={value}
      // a single choice is always set: ignore Radix's deselect (empty value)
      onValueChange={(v) => {
        if (v) onValueChange(v as V)
      }}
      disabled={disabled}
      rovingFocus={tabbable}
      data-size={size}
      className={[styles['root'], className].filter(Boolean).join(' ')}
    >
      <span className={styles['thumb']} style={thumb} aria-hidden="true" />
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled ?? false}
          {...(tabbable ? {} : { tabIndex: -1 })}
          {...(o.fullLabel === undefined ? {} : { 'aria-label': o.fullLabel, title: o.fullLabel })}
          className={styles['item']}
        >
          {o.icon !== undefined ? (
            <span className={styles['icon']} aria-hidden="true">
              {o.icon}
            </span>
          ) : null}
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
