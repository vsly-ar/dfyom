// Building blocks of the library forms (ToolFields, MachineFields, StockFields): a labelled group,
// a quantity field over a stored quantity DTO (shown in the window's unit system, L5), the name
// and notes fields. Doc: docs/conventions/ui-library-window.md#layout
import { useId, type ReactNode } from 'react'
import type { UnitSystem } from '../../../core/project/document'
import type { QuantityDTO } from '../../../core/quantity/quantity.dto'
import type { QuantityKind } from '../../../core/quantity/units'
import { libraryMessages } from '../messages/library'
import {
  Field,
  FieldIcon,
  FieldInput,
  QuantityInput,
  type FieldIconName,
  type FieldMessage,
} from '../ui'
import { displayQuantity, libraryUnit, type QDto } from './form'
import styles from './LibraryForm.module.css'

/** What every library form component gets. */
export interface FormProps<V> {
  readonly values: V
  readonly onChange: (next: V) => void
  readonly units: UnitSystem
  /** The issues at a field (dotted path below the values) as field messages. */
  readonly messages: (field: string) => FieldMessage[]
  /** `quick`: the fields the add dialogs need (v0.1); `full`: every field (Library window). */
  readonly variant: 'quick' | 'full'
  /** Focus entered a field (the tool drawing highlights its dimension). */
  readonly onFocusField?: ((field: string | undefined) => void) | undefined
}

export function Group({
  title,
  children,
  aside,
}: {
  title: string
  children: ReactNode
  /** Beside the fields in wide containers (the tool drawing). */
  aside?: ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <section aria-labelledby={id} className={styles['group']}>
      <h3 id={id} className={styles['legend']}>
        {title}
      </h3>
      {aside === undefined ? (
        children
      ) : (
        <div className={styles['withAside']}>
          <div className={styles['fields']}>{children}</div>
          <div className={styles['aside']}>{aside}</div>
        </div>
      )}
    </section>
  )
}

/** A field that reports focus by its key (the drawing's highlighted dimension). */
export function Focusable({
  field,
  onFocusField,
  children,
}: {
  field: string
  onFocusField?: ((field: string | undefined) => void) | undefined
  children: ReactNode
}): React.JSX.Element {
  if (onFocusField === undefined) return <>{children}</>
  return (
    <div
      className={styles['focusable']}
      onFocus={() => onFocusField(field)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onFocusField(undefined)
      }}
    >
      {children}
    </div>
  )
}

export function QuantityField<K extends QuantityKind>({
  field,
  label,
  kind,
  value,
  units,
  icon,
  messages,
  note,
  optional = false,
  onChange,
  onFocusField,
}: {
  field: string
  label: string
  kind: K
  value: QuantityDTO | undefined
  units: UnitSystem
  icon: FieldIconName
  messages: (field: string) => FieldMessage[]
  note?: string | undefined
  /** Emptying it removes the value (an optional library field). */
  optional?: boolean
  onChange: (value: QDto<K> | undefined) => void
  onFocusField?: ((field: string | undefined) => void) | undefined
}): React.JSX.Element {
  const shown = [
    ...messages(field),
    ...(note === undefined ? [] : [{ id: `${field}-note`, severity: 'note' as const, text: note }]),
  ]
  const common = {
    label,
    kind,
    defaultUnit: libraryUnit(kind, units),
    value: displayQuantity(value, units),
    illustration: <FieldIcon name={icon} />,
    messages: shown,
  }
  return (
    <Focusable field={field} onFocusField={onFocusField}>
      {optional ? (
        <QuantityInput
          {...common}
          optional
          onCommit={(q) => onChange(q?.toDTO() as QDto<K> | undefined)}
        />
      ) : (
        <QuantityInput {...common} onCommit={(q) => onChange(q.toDTO() as QDto<K>)} />
      )}
    </Focusable>
  )
}

export function NameField({
  value,
  onChange,
  messages,
  label = libraryMessages.name,
}: {
  value: string
  onChange: (name: string) => void
  messages: FieldMessage[]
  label?: string
}): React.JSX.Element {
  return (
    <Field label={label} messages={messages}>
      <FieldInput value={value} maxLength={120} onChange={(e) => onChange(e.target.value)} />
    </Field>
  )
}

export function NotesField({
  value,
  onChange,
  messages,
}: {
  value: string | undefined
  onChange: (notes: string | undefined) => void
  messages: FieldMessage[]
}): React.JSX.Element {
  return (
    <Field
      label={libraryMessages.notes}
      messages={[
        ...messages,
        { id: 'notes-hint', severity: 'note' as const, text: libraryMessages.notesHint },
      ]}
    >
      <textarea
        className={styles['notes']}
        rows={4}
        maxLength={4000}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      />
    </Field>
  )
}

/** A fixed value shown as read-only text in the field grid (controller, tool changer). */
export function FixedField({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <Field label={label} readOnly>
      <FieldInput value={value} readOnly />
    </Field>
  )
}
