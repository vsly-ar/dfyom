// Menu: row and viewport actions in a dropdown, with shortcuts; destructive items in --danger.
// Doc: docs/conventions/ui.md#radix-wrapping-pattern, #inventory-v01
import { DropdownMenu } from 'radix-ui'
import type { ReactElement, ReactNode } from 'react'
import { usePortalContainer } from '../UiProvider/UiProvider'
import styles from './Menu.module.css'

export type MenuEntry =
  | {
      label: string
      onSelect: () => void
      icon?: ReactNode
      shortcut?: string
      danger?: boolean
      disabled?: boolean
    }
  | 'separator'

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
            ) : (
              <DropdownMenu.Item
                key={item.label}
                className={styles['item']}
                data-danger={item.danger || undefined}
                disabled={item.disabled ?? false}
                onSelect={item.onSelect}
              >
                {item.icon}
                <span className={styles['text']}>{item.label}</span>
                {item.shortcut ? <kbd className={styles['kbd']}>{item.shortcut}</kbd> : null}
              </DropdownMenu.Item>
            ),
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
