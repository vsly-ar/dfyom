// Tabs: sections of one panel (inspector sections where needed). Text tabs with an amber underline
// that slides to the selected tab; the mode switcher is its own component (decision 23).
// Radix Tabs (tablist, roving arrow keys, tabpanels). In an inspector (DF110): every panel stays
// mounted, the inactive ones hidden (field state and in-flight edits survive), a tab with a
// problem shows a severity dot, the selected tab is remembered per inspector kind (`rememberKey`),
// the strip can stick to the top of a scrolling body, and a revealed field selects its tab.
// Docs: docs/conventions/ui.md#inventory-v01, docs/conventions/inspector-layout.md#tabs
import { Tabs as RadixTabs } from 'radix-ui'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { inspectorMessages } from '../../messages/inspector'
import { REVEAL_EVENT, useInspectorMemory, useRememberedTab } from '../InspectorGroup/memory'
import { useSlidingIndicator } from '../useSlidingIndicator'
import styles from './Tabs.module.css'

export interface TabItem<V extends string> {
  value: V
  label: string
  content: ReactNode
  disabled?: boolean
  /** A problem in this tab's fields: a dot after the label (and its text for screen readers). */
  severity?: 'error' | 'warning' | undefined
}

export interface TabsProps<V extends string> {
  /** Accessible name of the tab list ("Pocket sections"). */
  label: string
  items: readonly TabItem<V>[]
  /** Controlled selection; otherwise `defaultValue` (default: the first item). */
  value?: V
  defaultValue?: V
  onValueChange?: (value: V) => void
  /**
   * Remember the selected tab under this key (`plan.op`) in the app settings, across selections
   * and launches (uncontrolled use only).
   */
  rememberKey?: string | undefined
  /** The tab strip sticks to the top of the scrolling container (long inspectors). */
  sticky?: boolean
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
}

export function Tabs<V extends string>({
  label,
  items,
  value,
  defaultValue,
  onValueChange,
  rememberKey,
  sticky = false,
  className,
}: TabsProps<V>): React.JSX.Element {
  const memory = useInspectorMemory()
  const remembered = useRememberedTab(rememberKey)
  const [inner, setInner] = useState<V | undefined>(defaultValue ?? items[0]?.value)
  const rememberedItem = items.find((i) => i.value === remembered && i.disabled !== true)?.value
  const current = value ?? (rememberKey !== undefined ? (rememberedItem ?? inner) : inner)
  const list = useRef<HTMLDivElement>(null)
  const indicator = useSlidingIndicator(list, '[data-state="active"]', current)
  const select = (v: string) => {
    const item = items.find((i) => i.value === v)
    if (!item) return
    setInner(item.value)
    if (rememberKey !== undefined && value === undefined) memory.setTab(rememberKey, item.value)
    onValueChange?.(item.value)
  }
  const selectRef = useRef(select)
  useEffect(() => {
    selectRef.current = select
  })
  // a field revealed in a hidden panel selects its tab first (a message's target, a pick)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = root.current
    if (el === null) return
    const reveal = (e: Event) => {
      const panel = (e.target as Element | null)?.closest<HTMLElement>('[role="tabpanel"]')
      const v = panel?.dataset['value']
      if (panel?.parentElement !== el || v === undefined || !panel.hidden) return
      flushSync(() => selectRef.current(v))
    }
    el.addEventListener(REVEAL_EVENT, reveal)
    return () => el.removeEventListener(REVEAL_EVENT, reveal)
  }, [])
  return (
    <RadixTabs.Root
      ref={root}
      {...(current !== undefined ? { value: current } : {})}
      onValueChange={select}
      className={[styles['root'], className].filter(Boolean).join(' ')}
    >
      <RadixTabs.List
        ref={list}
        aria-label={label}
        className={styles['list']}
        data-sticky={sticky || undefined}
      >
        {items.map((i) => (
          <RadixTabs.Trigger
            key={i.value}
            value={i.value}
            disabled={i.disabled ?? false}
            className={styles['tab']}
          >
            {i.label}
            {i.severity !== undefined ? (
              <>
                <span className={styles['dot']} data-severity={i.severity} aria-hidden="true" />
                <span className={styles['srOnly']}>
                  {`, ${inspectorMessages.severity[i.severity]}`}
                </span>
              </>
            ) : null}
          </RadixTabs.Trigger>
        ))}
        <span className={styles['indicator']} style={indicator} aria-hidden="true" />
      </RadixTabs.List>
      {items.map((i) => (
        <RadixTabs.Content
          key={i.value}
          value={i.value}
          forceMount
          hidden={i.value !== current}
          data-value={i.value}
          className={styles['panel']}
        >
          {i.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  )
}
