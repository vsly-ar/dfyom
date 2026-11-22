// Select: one value from a list (strategy, tool). Looks like a Field input in the UI font with a
// chevron; the list is a raised menu, optionally in labelled groups (`on` by face direction),
// options optionally with a second line (`description`: a tool's reasons, F5). `muted` shows a
// value that is about to change (the tool field's "Chosen again on Apply").
// Doc: docs/conventions/ui.md#inventory-v01, #design-and-plan-controls-v02
import { Check, ChevronDown } from 'lucide-react'
import { Select as RadixSelect } from 'radix-ui'
import { useId, type Ref } from 'react'
import { usePortalContainer } from '../UiProvider/UiProvider'
import styles from './Select.module.css'

export interface SelectOption<V extends string> {
  value: V
  label: string
  disabled?: boolean
  /** Group heading; options with the same group are listed together, in order of first use. */
  group?: string
  /** A second, smaller line in the list (not in the trigger); the option's accessible description. */
  description?: string
  /** A small picture before the label in the list (a shape's mini outline), never in the trigger. */
  icon?: React.ReactNode
}

/** Options by group, in order of first appearance (ungrouped ones under `undefined`). */
export function groupOptions<O extends { group?: string }>(
  options: readonly O[],
): { group: string | undefined; options: O[] }[] {
  const groups: { group: string | undefined; options: O[] }[] = []
  for (const o of options) {
    const g = groups.find((x) => x.group === o.group)
    if (g) g.options.push(o)
    else groups.push({ group: o.group, options: [o] })
  }
  return groups
}

export interface SelectProps<V extends string> {
  options: readonly SelectOption<V>[]
  value?: V
  defaultValue?: V
  onValueChange?: (value: V) => void
  /** The list opened or closed (e.g. to re-read options that change outside the document). */
  onOpenChange?: (open: boolean) => void
  placeholder?: string
  /** Accessible name when no `<label>` points at it (a Field provides one via `id`). */
  'aria-label'?: string
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
  disabled?: boolean
  /** The value shows muted (it is about to change); still operable. */
  muted?: boolean
  /** Layout only; appended to the trigger's class. */
  className?: string | undefined
  ref?: Ref<HTMLButtonElement>
}

function item<V extends string>(o: SelectOption<V>): React.JSX.Element {
  return <SelectItem key={o.value} option={o} />
}

function SelectItem<V extends string>({
  option: o,
}: {
  option: SelectOption<V>
}): React.JSX.Element {
  const id = useId()
  return (
    <RadixSelect.Item
      value={o.value}
      disabled={o.disabled ?? false}
      className={styles['item']}
      data-described={o.description !== undefined || undefined}
      data-icon={o.icon !== undefined || undefined}
      {...(o.description !== undefined ? { 'aria-describedby': id } : {})}
    >
      {o.icon !== undefined ? (
        <span className={styles['optionIcon']} aria-hidden="true">
          {o.icon}
        </span>
      ) : null}
      <ItemBody option={o} id={id} />
      <RadixSelect.ItemIndicator className={styles['indicator']}>
        <Check aria-hidden="true" />
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  )
}

/** The label and the optional description; wrapped in a column beside an icon. */
function ItemBody<V extends string>({
  option: o,
  id,
}: {
  option: SelectOption<V>
  id: string
}): React.JSX.Element {
  const body = (
    <>
      <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
      {o.description !== undefined ? (
        <span id={id} className={styles['description']}>
          {o.description}
        </span>
      ) : null}
    </>
  )
  return o.icon === undefined ? body : <span className={styles['optionText']}>{body}</span>
}

export function Select<V extends string>({
  options,
  value,
  defaultValue,
  onValueChange,
  onOpenChange,
  placeholder,
  disabled = false,
  muted = false,
  className,
  ref,
  ...aria
}: SelectProps<V>): React.JSX.Element {
  const container = usePortalContainer()
  return (
    <RadixSelect.Root
      {...(value !== undefined ? { value } : {})}
      {...(defaultValue !== undefined ? { defaultValue } : {})}
      {...(onValueChange ? { onValueChange: (v: string) => onValueChange(v as V) } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
      disabled={disabled}
    >
      <RadixSelect.Trigger
        {...aria}
        ref={ref}
        data-muted={muted || undefined}
        className={[styles['trigger'], className].filter(Boolean).join(' ')}
      >
        <span className={styles['value']}>
          <RadixSelect.Value {...(placeholder ? { placeholder } : {})} />
        </span>
        <RadixSelect.Icon className={styles['chevron']}>
          <ChevronDown aria-hidden="true" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal container={container}>
        <RadixSelect.Content className={styles['content']} position="popper" sideOffset={4}>
          <RadixSelect.Viewport className={styles['viewport']}>
            {groupOptions(options).map((g, i) =>
              g.group === undefined ? (
                g.options.map(item)
              ) : (
                <RadixSelect.Group key={`${i}:${g.group}`} className={styles['group']}>
                  <RadixSelect.Label className={styles['label']}>{g.group}</RadixSelect.Label>
                  {g.options.map(item)}
                </RadixSelect.Group>
              ),
            )}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
