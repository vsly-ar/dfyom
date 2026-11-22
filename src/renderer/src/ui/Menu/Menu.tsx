// Menu: row and viewport actions in a dropdown, with shortcuts; destructive items in --danger-text.
// v0.4 (task U1): labelled groups ("Operations", "Features") and items disabled with a stated
// reason (`aria-disabled`, still focusable, the reason under the label and in its description).
// Doc: docs/conventions/ui.md#radix-wrapping-pattern, #inventory-v01, #feature-rows-and-add
import { DropdownMenu } from 'radix-ui'
import { useId, type ReactElement, type ReactNode } from 'react'
import { usePortalContainer } from '../UiProvider/UiProvider'
import styles from './Menu.module.css'

export interface MenuItem {
  label: string
  onSelect: () => void
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  /**
   * Why the item can't be chosen now: it stays focusable (`aria-disabled`), choosing it does
   * nothing, and the reason shows under its label (ui.md: disabled actions say why).
   */
  disabledReason?: string | undefined
}

/** A labelled group of items (`role="group"` named by its label). */
export interface MenuGroup {
  group: string
  items: readonly MenuItem[]
}

export type MenuEntry = MenuItem | MenuGroup | 'separator'

export interface MenuProps {
  /** One focusable element; it becomes the trigger (Radix `asChild`). */
  children: ReactElement
  items: readonly MenuEntry[]
  /** Accessible name of the menu (defaults to the trigger's name). */
  label?: string
  align?: 'start' | 'center' | 'end'
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Modal by default (outside clicks only close it); the gallery shows menus non-modal. */
  modal?: boolean
}

export function Menu({
  children,
  items,
  label,
  align = 'start',
  open,
  defaultOpen,
  onOpenChange,
  modal = true,
}: MenuProps): React.JSX.Element {
  const container = usePortalContainer()
  return (
    <DropdownMenu.Root
      modal={modal}
      {...(open !== undefined ? { open } : {})}
      {...(defaultOpen !== undefined ? { defaultOpen } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal container={container}>
        <DropdownMenu.Content
          className={styles['content']}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          {...(label ? { 'aria-label': label } : {})}
        >
          {items.map((item, i) =>
            item === 'separator' ? (
              <DropdownMenu.Separator key={`sep-${i}`} className={styles['separator']} />
            ) : 'group' in item ? (
              <Group key={`group-${item.group}`} group={item} />
            ) : (
              <Item key={item.label} item={item} />
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function Group({ group }: { group: MenuGroup }): React.JSX.Element {
  const id = useId()
  return (
    <DropdownMenu.Group className={styles['group']} aria-labelledby={id}>
      <DropdownMenu.Label id={id} className={styles['label']}>
        {group.group}
      </DropdownMenu.Label>
      {group.items.map((item) => (
        <Item key={item.label} item={item} />
      ))}
    </DropdownMenu.Group>
  )
}

function Item({ item }: { item: MenuItem }): React.JSX.Element {
  const reasonId = useId()
  const reason = item.disabledReason
  return (
    <DropdownMenu.Item
      className={styles['item']}
      data-danger={item.danger || undefined}
      data-reason={reason !== undefined || undefined}
      disabled={item.disabled ?? false}
      {...(reason !== undefined
        ? {
            'aria-label': item.label,
            'aria-disabled': true,
            'aria-describedby': reasonId,
            'data-disabled': '',
          }
        : {})}
      onSelect={(e) => {
        // a disabled item with a reason stays focusable; choosing it keeps the menu open
        if (reason !== undefined) return e.preventDefault()
        item.onSelect()
      }}
    >
      {item.icon}
      <span className={styles['text']}>
        {item.label}
        {reason !== undefined ? (
          <span id={reasonId} className={styles['reason']}>
            {reason}
          </span>
        ) : null}
      </span>
      {item.shortcut ? <kbd className={styles['kbd']}>{item.shortcut}</kbd> : null}
    </DropdownMenu.Item>
  )
}
