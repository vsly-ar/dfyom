// Tabs: sections of one panel (inspector sections where needed). Text tabs with an amber underline
// that slides to the selected tab; the mode switcher is its own component (decision 23).
// Radix Tabs (tablist, roving arrow keys, tabpanels). Doc: docs/conventions/ui.md#inventory-v01
import { Tabs as RadixTabs } from 'radix-ui'
import { useRef, useState, type ReactNode } from 'react'
import { useSlidingIndicator } from '../useSlidingIndicator'
import styles from './Tabs.module.css'

export interface TabItem<V extends string> {
  value: V
  label: string
  content: ReactNode
  disabled?: boolean
}

export interface TabsProps<V extends string> {
  /** Accessible name of the tab list ("Pocket sections"). */
  label: string
  items: readonly TabItem<V>[]
  /** Controlled selection; otherwise `defaultValue` (default: the first item). */
  value?: V
  defaultValue?: V
  onValueChange?: (value: V) => void
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
}

export function Tabs<V extends string>({
  label,
  items,
  value,
  defaultValue,
  onValueChange,
  className,
}: TabsProps<V>): React.JSX.Element {
  const [inner, setInner] = useState<V | undefined>(defaultValue ?? items[0]?.value)
  const current = value ?? inner
  const list = useRef<HTMLDivElement>(null)
  const indicator = useSlidingIndicator(list, '[data-state="active"]', current)
  return (
    <RadixTabs.Root
      {...(current !== undefined ? { value: current } : {})}
      onValueChange={(v) => {
        const item = items.find((i) => i.value === v)
        if (!item) return
        setInner(item.value)
        onValueChange?.(item.value)
      }}
      className={[styles['root'], className].filter(Boolean).join(' ')}
    >
      <RadixTabs.List ref={list} aria-label={label} className={styles['list']}>
        {items.map((i) => (
          <RadixTabs.Trigger
            key={i.value}
            value={i.value}
            disabled={i.disabled ?? false}
            className={styles['tab']}
          >
            {i.label}
          </RadixTabs.Trigger>
        ))}
        <span className={styles['indicator']} style={indicator} aria-hidden="true" />
      </RadixTabs.List>
      {items.map((i) => (
        <RadixTabs.Content key={i.value} value={i.value} className={styles['panel']}>
          {i.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  )
}
