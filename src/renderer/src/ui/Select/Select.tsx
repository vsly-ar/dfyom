// Select: one value from a list (strategy, tool). Looks like a Field input in the UI font with a
// chevron; the list is a raised menu, optionally in labelled groups (`on` by face direction).
// Doc: docs/conventions/ui.md#inventory-v01, #design-and-plan-controls-v02
import { Check, ChevronDown } from 'lucide-react'
import { Select as RadixSelect } from 'radix-ui'
import type { Ref } from 'react'
import { usePortalContainer } from '../UiProvider/UiProvider'
import styles from './Select.module.css'

export interface SelectOption<V extends string> {
  value: V
  label: string
  disabled?: boolean
  /** Group heading; options with the same group are listed together, in order of first use. */
  group?: string
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
  placeholder?: string
  /** Accessible name when no `<label>` points at it (a Field provides one via `id`). */
  'aria-label'?: string
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
  disabled?: boolean
  /** Layout only; appended to the trigger's class. */
  className?: string | undefined
  ref?: Ref<HTMLButtonElement>
}

function item<V extends string>(o: SelectOption<V>): React.JSX.Element {
  return (
    <RadixSelect.Item
      key={o.value}
      value={o.value}
      disabled={o.disabled ?? false}
      className={styles['item']}
    >
      <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
      <RadixSelect.ItemIndicator className={styles['indicator']}>
        <Check aria-hidden="true" />
      </RadixSelect.ItemIndicator>
    </RadixSelect.Item>
  )
}

export function Select<V extends string>({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  disabled = false,
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
      disabled={disabled}
    >
      <RadixSelect.Trigger
        {...aria}
        ref={ref}
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
