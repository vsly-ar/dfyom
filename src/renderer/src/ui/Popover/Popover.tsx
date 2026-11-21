// Popover: a raised panel anchored to its trigger (pickers, the field's adjust popover in 3.4);
// scales in from the trigger, focus returns to it on close.
// Doc: docs/conventions/ui.md#radix-wrapping-pattern, #motion
import { Popover as RadixPopover } from 'radix-ui'
import type { ReactElement, ReactNode } from 'react'
import { usePortalContainer } from '../UiProvider/UiProvider'
import styles from './Popover.module.css'

export interface PopoverProps {
  /** One focusable element; it becomes the trigger (Radix `asChild`). */
  children: ReactElement
  content: ReactNode
  /** Accessible name of the popover (dialog role), e.g. "Adjust Width". */
  label: string
  /** Optional title row. */
  title?: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Escape is closing it (called before `onOpenChange(false)`), e.g. to cancel instead of keep. */
  onEscapeKeyDown?: () => void
  /** Non-modal by default: the rest of the window stays usable. */
  modal?: boolean
}

export function Popover({
  children,
  content,
  label,
  title,
  side = 'bottom',
  align = 'end',
  open,
  defaultOpen,
  onOpenChange,
  onEscapeKeyDown,
  modal = false,
}: PopoverProps): React.JSX.Element {
  const container = usePortalContainer()
  return (
    <RadixPopover.Root
      modal={modal}
      {...(open !== undefined ? { open } : {})}
      {...(defaultOpen !== undefined ? { defaultOpen } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <RadixPopover.Trigger asChild>{children}</RadixPopover.Trigger>
      <RadixPopover.Portal container={container}>
        <RadixPopover.Content
          aria-label={label}
          className={styles['content']}
          side={side}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          {...(onEscapeKeyDown ? { onEscapeKeyDown: () => onEscapeKeyDown() } : {})}
        >
          {title ? <div className={styles['title']}>{title}</div> : null}
          {content}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  )
}
