// FieldInput: the plain input box of a Field (mono, tabular digits, muted unit suffix). Nothing
// else sits in the box since DF9 (the adjust panel opens under the field on focus), so Tab goes
// from field to field. QuantityInput (task 3.4) adds parsing, echo, steppers and the panel.
// Doc: docs/conventions/ui.md#field, #quantity-and-expression-input
import type { InputHTMLAttributes, ReactNode, Ref } from 'react'
import styles from './Field.module.css'

export interface FieldInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  /** Muted unit suffix of a bare number ("mm"). */
  unit?: string
  /**
   * Decoration drawn over the text, aligned with it (same font, `aria-hidden`): QuantityInput's
   * error underline and the muted computed value after the source.
   */
  overlay?: ReactNode
  /** Layout only; appended to the box's class. */
  className?: string | undefined
  ref?: Ref<HTMLInputElement>
}

export function FieldInput({
  unit,
  overlay,
  className,
  type = 'text',
  ...rest
}: FieldInputProps): React.JSX.Element {
  const input = <input {...rest} type={type} className={styles['input']} spellCheck={false} />
  return (
    <span
      className={[styles['box'], className].filter(Boolean).join(' ')}
      data-invalid={rest['aria-invalid'] === true || rest['aria-invalid'] === 'true' || undefined}
      data-readonly={rest.readOnly || undefined}
    >
      {overlay === undefined ? (
        input
      ) : (
        <span className={styles['slot']}>
          {input}
          <span className={styles['overlay']} aria-hidden="true">
            {overlay}
          </span>
        </span>
      )}
      {unit ? (
        <span className={styles['unit']} aria-hidden="true">
          {unit}
        </span>
      ) : null}
    </span>
  )
}
