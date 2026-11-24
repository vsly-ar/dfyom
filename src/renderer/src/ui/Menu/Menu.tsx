// Menu: row and viewport actions in a dropdown, with shortcuts; destructive items in --danger-text.
// v0.4 (task U1): labelled groups ("Operations", "Features") and items disabled with a stated
// reason (`aria-disabled`, still focusable, the reason under the label and in its description).
// Dogfood DF18: an item's one-line `description` shows as a tooltip beside it while highlighted. DF16:
// `ContextMenu` (right-click; same entries and look) and `openContextMenu` (Shift+F10 / Menu key).
// Doc: docs/conventions/ui.md#radix-wrapping-pattern, #inventory-v01, #feature-rows-and-add
import { ContextMenu as RadixContextMenu, DropdownMenu } from 'radix-ui'
import { useId, type ComponentType, type ReactElement, type ReactNode } from 'react'
import { Icon } from '../icons/Icon'
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
  /**
   * One line on what the item does: a tooltip beside the item while it is highlighted (hover or
   * keyboard focus) and its accessible description (DF18). Drawn by the menu itself, not a Radix
   * tooltip, so a single Escape still closes the menu.
   */
  description?: string | undefined
  /**
   * One of a choice (the part menu's parts, split parts S0): `menuitemradio` with `aria-checked`,
   * a check mark at the end while true.
   */
  checked?: boolean | undefined
  /** React key when labels may repeat (two parts of the same name); default the label. */
  id?: string | undefined
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
          <Entries p={DROPDOWN} items={items} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export interface ContextMenuProps {
  /** The element right-click (or `openContextMenu`) opens the menu on (Radix `asChild`). */
  children: ReactElement
  items: readonly MenuEntry[]
  /** Accessible name of the menu. */
  label: string
  /** Where focus goes when the menu closes (the row it was opened on). */
  onCloseAutoFocus?: (e: Event) => void
}

/** The right-click menu of an element: the same entries and look as `Menu`, at the pointer. */
export function ContextMenu({
  children,
  items,
  label,
  onCloseAutoFocus,
}: ContextMenuProps): React.JSX.Element {
  const container = usePortalContainer()
  return (
    <RadixContextMenu.Root>
      <RadixContextMenu.Trigger asChild>{children}</RadixContextMenu.Trigger>
      <RadixContextMenu.Portal container={container}>
        <RadixContextMenu.Content
          className={`${styles['content']} ${styles['context']}`}
          collisionPadding={8}
          aria-label={label}
          {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
        >
          <Entries p={CONTEXT} items={items} />
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  )
}

/**
 * Opens the `ContextMenu` of `el` from the keyboard (`Shift+F10`, the Menu key): a `contextmenu`
 * event at its start edge, as a right-click there would send (macOS Chromium sends none itself).
 */
export function openContextMenu(el: Element): void {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + Math.min(24, r.width / 2),
      clientY: r.top + r.height,
    }),
  )
}

/** `Shift+F10` or the Menu key: the key that opens a context menu. */
export const isContextMenuKey = (e: { key: string; shiftKey: boolean }): boolean =>
  e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)

/** The Radix parts an entry renders with (DropdownMenu's and ContextMenu's share their props). */
interface Parts {
  Item: ComponentType<DropdownMenu.DropdownMenuItemProps>
  Group: ComponentType<DropdownMenu.DropdownMenuGroupProps>
  Label: ComponentType<DropdownMenu.DropdownMenuLabelProps>
  Separator: ComponentType<DropdownMenu.DropdownMenuSeparatorProps>
}
const DROPDOWN: Parts = DropdownMenu
const CONTEXT = RadixContextMenu as unknown as Parts

function Entries({ p, items }: { p: Parts; items: readonly MenuEntry[] }): React.JSX.Element {
  return (
    <>
      {items.map((item, i) =>
        item === 'separator' ? (
          <p.Separator key={`sep-${i}`} className={styles['separator']} />
        ) : 'group' in item ? (
          <Group key={`group-${item.group}`} p={p} group={item} />
        ) : (
          <Item key={item.id ?? item.label} p={p} item={item} />
        ),
      )}
    </>
  )
}

function Group({ p, group }: { p: Parts; group: MenuGroup }): React.JSX.Element {
  const id = useId()
  return (
    <p.Group className={styles['group']} aria-labelledby={id}>
      <p.Label id={id} className={styles['label']}>
        {group.group}
      </p.Label>
      {group.items.map((item) => (
        <Item key={item.id ?? item.label} p={p} item={item} />
      ))}
    </p.Group>
  )
}

function Item({ p, item }: { p: Parts; item: MenuItem }): React.JSX.Element {
  const reasonId = useId()
  const descriptionId = useId()
  const reason = item.disabledReason
  const description = item.description
  return (
    <p.Item
      className={styles['item']}
      data-danger={item.danger || undefined}
      data-reason={reason !== undefined || undefined}
      disabled={item.disabled ?? false}
      {...(item.checked !== undefined
        ? { role: 'menuitemradio', 'aria-checked': item.checked }
        : {})}
      {...(description !== undefined && reason === undefined
        ? { 'aria-describedby': descriptionId }
        : {})}
      {...(description !== undefined ? { 'aria-label': item.label } : {})}
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
      {item.checked === true ? (
        <span className={styles['check']} aria-hidden="true">
          <Icon name="check" size="sm" />
        </span>
      ) : null}
      {description !== undefined ? (
        <span id={descriptionId} role="tooltip" className={styles['description']}>
          {description}
        </span>
      ) : null}
    </p.Item>
  )
}
