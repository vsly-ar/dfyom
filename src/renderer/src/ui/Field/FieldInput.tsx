// FieldInput: the plain input box of a Field (mono, tabular digits, muted unit suffix, a slot for
// the adjust pencil). QuantityInput (task 3.4) adds parsing, echo and steppers on top.
// Doc: docs/conventions/ui.md#field, #quantity-and-expression-input
import type { InputHTMLAttributes, ReactNode, Ref } from 'react'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './Field.module.css'

export interface FieldInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  /** Muted unit suffix of a bare number ("mm"). */
  unit?: string
  /** A `FieldAdjustButton` inside the box. */
  adjust?: ReactNode
  /** Layout only; appended to the box's class. */
  className?: string | undefined
  ref?: Ref<HTMLInputElement>
}

export function FieldInput({
  unit,
  adjust,
  className,
  type = 'text',
  ...rest
}: FieldInputProps): React.JSX.Element {
  return (
    <span
      className={[styles['box'], className].filter(Boolean).join(' ')}
      data-invalid={rest['aria-invalid'] === true || rest['aria-invalid'] === 'true' || undefined}
      data-readonly={rest.readOnly || undefined}
    >
      <input {...rest} type={type} className={styles['input']} spellCheck={false} />
      {unit ? (
        <span className={styles['unit']} aria-hidden="true">
          {unit}
        </span>
      ) : null}
      {adjust}
    </span>
  )
}

export interface FieldAdjustButtonProps {
  /** Accessible name, e.g. "Adjust Stepdown". */
  label: string
  /** A fix is available: the pencil turns amber. */
  fix?: boolean
  onClick?: () => void
  'aria-expanded'?: boolean
  ref?: Ref<HTMLButtonElement>
}

/** The pencil inside the input that opens the adjust popover (steps, recommended value; 3.4). */
export function FieldAdjustButton({
  label,
  fix = false,
  ...rest
}: FieldAdjustButtonProps): React.JSX.Element {
  return (
    <Tooltip content={label}>
      <button
        {...rest}
        type="button"
        aria-label={label}
        data-fix={fix || undefined}
        className={styles['pen']}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M11 2.5l2.5 2.5-7.5 7.5H3.5V10z" />
          <path data-accent="" d="M9.5 4l2.5 2.5" />
        </svg>
      </button>
    </Tooltip>
  )
}
