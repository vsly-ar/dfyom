// Tooltip: short help with an optional shortcut, inverted surface (--text on --bg-app), after
// --delay-tooltip on hover and at once on keyboard focus. Doc: docs/conventions/ui.md#radix-wrapping-pattern
import { Tooltip as RadixTooltip } from 'radix-ui'
import type { ReactElement, ReactNode } from 'react'
import { usePortalContainer } from '../UiProvider/UiProvider'
import styles from './Tooltip.module.css'

export interface TooltipProps {
  /** The tooltip text; for icon-only controls the same text as their `aria-label`. */
  content: ReactNode
  /** Keyboard shortcut shown after the text (e.g. "R", "⌘Z"). */
  shortcut?: string
  /** One focusable element; it becomes the trigger (Radix `asChild`). */
  children: ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** Rich tooltip: a block of several lines (title, explanation, list), wider (Apply button). */
  rich?: boolean
  /** Controlled open state (the gallery shows tooltips open). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function Tooltip({
  content,
  shortcut,
  children,
  side = 'bottom',
  rich = false,
  open,
  onOpenChange,
}: TooltipProps): React.JSX.Element {
  const container = usePortalContainer()
  return (
    <RadixTooltip.Root
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal container={container}>
        <RadixTooltip.Content
          className={styles['content']}
          side={side}
          sideOffset={6}
          data-rich={rich || undefined}
        >
          {content}
          {shortcut && !rich ? <kbd className={styles['kbd']}>{shortcut}</kbd> : null}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}
