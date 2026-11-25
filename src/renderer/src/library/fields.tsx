// Building blocks of the library forms (ToolFields, MachineFields, StockFields): fields beside
// an aside, a quantity field over a stored quantity DTO (shown in the window's unit system, L5), the name
// and notes fields. Doc: docs/conventions/ui-library-window.md#layout
import type { ReactNode } from 'react'
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
  type StepKind,
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

/**
 * The fields beside an aside in wide containers (the tool drawing); stacked in narrow ones. The
 * group around it is the shared `InspectorGroup` (DF110).
 */
export function WithAside({
  aside,
  children,
}: {
  aside: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className={styles['withAside']}>
      <div className={styles['fields']}>{children}</div>
      <div className={styles['aside']}>{aside}</div>
    </div>
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
  info,
  stepKind,
  stepMax,
  optional = false,
  placeholder,
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
  /** Static explanation: the (i) tip on the title row (inspector-layout.md § Info tips). */
  info?: string | undefined
  /** What the field measures, for its adjust steps (inspector-layout.md § Step kinds). */
  stepKind: StepKind
  /** The field's maximum (count fields): the step ladder stops at half of it. */
  stepMax?: number
  /** Emptying it removes the value (an optional library field). */
  optional?: boolean
  /** Shown while empty (an optional field: what empty means, "0: pointed"). */
  placeholder?: string | undefined
  onChange: (value: QDto<K> | undefined) => void
  onFocusField?: ((field: string | undefined) => void) | undefined
}): React.JSX.Element {
  const common = {
    label,
    kind,
    defaultUnit: libraryUnit(kind, units),
    value: displayQuantity(value, units),
    illustration: <FieldIcon name={icon} />,
    messages: messages(field),
    stepKind,
    stepKey: `library.${field}`,
    ...(stepMax !== undefined ? { stepMax } : {}),
    ...(info !== undefined ? { info } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
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
