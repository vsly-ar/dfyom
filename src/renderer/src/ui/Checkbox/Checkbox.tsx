// Checkbox with its label: amber box with a dark check (or dash when mixed) that scales in.
// Doc: docs/conventions/ui.md#buttons (toggles use the accent); look: ui-design-system.html (.check)
import { Checkbox as RadixCheckbox } from 'radix-ui'
import { useId, type Ref } from 'react'
import styles from './Checkbox.module.css'

export type CheckedState = boolean | 'indeterminate'

export interface CheckboxProps {
  label: string
  checked?: CheckedState
  defaultChecked?: CheckedState
  onCheckedChange?: (checked: CheckedState) => void
  disabled?: boolean
  id?: string
  'aria-describedby'?: string
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
  ref?: Ref<HTMLButtonElement>
}

export function Checkbox({ label, id, className, ref, ...rest }: CheckboxProps): React.JSX.Element {
  const autoId = useId()
  const boxId = id ?? autoId
  return (
    <span className={[styles['root'], className].filter(Boolean).join(' ')}>
      <RadixCheckbox.Root {...rest} ref={ref} id={boxId} className={styles['box']}>
        <RadixCheckbox.Indicator forceMount className={styles['indicator']} />
      </RadixCheckbox.Root>
      <label htmlFor={boxId} className={styles['label']}>
        {label}
      </label>
    </span>
  )
}
