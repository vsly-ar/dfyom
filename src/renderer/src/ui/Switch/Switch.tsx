// Switch: on/off setting that applies at once; amber track when on, the knob stretches on press.
// Doc: docs/conventions/ui.md#buttons (toggles use the accent); look: ui-design-system.html (.switch)
import { Switch as RadixSwitch } from 'radix-ui'
import { useId, type Ref } from 'react'
import styles from './Switch.module.css'

export interface SwitchProps {
  /** Accessible name; shown before the switch unless `hideLabel` (then it is `aria-label`). */
  label: string
  hideLabel?: boolean
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  id?: string
  'aria-describedby'?: string
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
  ref?: Ref<HTMLButtonElement>
}

export function Switch({
  label,
  hideLabel = false,
  id,
  className,
  ref,
  ...rest
}: SwitchProps): React.JSX.Element {
  const autoId = useId()
  const switchId = id ?? autoId
  const control = (
    <RadixSwitch.Root
      {...rest}
      ref={ref}
      id={switchId}
      {...(hideLabel ? { 'aria-label': label } : {})}
      className={[styles['track'], hideLabel ? className : undefined].filter(Boolean).join(' ')}
    >
      <RadixSwitch.Thumb className={styles['thumb']} />
    </RadixSwitch.Root>
  )
  if (hideLabel) return control
  return (
    <span className={[styles['row'], className].filter(Boolean).join(' ')}>
      <label htmlFor={switchId} className={styles['label']}>
        {label}
      </label>
      {control}
    </span>
  )
}
