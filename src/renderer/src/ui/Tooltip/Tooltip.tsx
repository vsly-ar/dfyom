// Tooltip: short help with an optional shortcut, inverted surface (--text on --bg-app), after
// --delay-tooltip on hover and at once on keyboard focus. A pressed trigger keeps it down until the
// pointer re-enters it or focus moves to another control (DF48: no tooltip over the menu or dialog
// the trigger opened, none when focus returns from it). Doc: docs/conventions/ui.md#radix-wrapping-pattern
import { Tooltip as RadixTooltip } from 'radix-ui'
import { useRef, useState, type ReactElement, type ReactNode } from 'react'
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
  align?: 'start' | 'center' | 'end'
  /** Rich tooltip: a block of several lines (title, explanation, list), wider (Apply button). */
  rich?: boolean
  /** Controlled open state (the gallery shows tooltips open). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/** Where focus goes when a trigger opens something: its tooltip stays down meanwhile. */
const POPUP = '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]'

export function Tooltip({
  content,
  shortcut,
  children,
  side = 'bottom',
  align = 'center',
  rich = false,
  open,
  onOpenChange,
}: TooltipProps): React.JSX.Element {
  const container = usePortalContainer()
  const [inner, setInner] = useState(false)
  // the trigger was pressed: no tooltip until a new hover or focus on another control (DF48)
  const pressed = useRef(false)
  const change = (o: boolean) => {
    if (o && pressed.current) return
    setInner(o)
    onOpenChange?.(o)
  }
  const press = () => {
    pressed.current = true
    change(false)
  }
  return (
    <RadixTooltip.Root open={open ?? inner} onOpenChange={change}>
      <RadixTooltip.Trigger
        asChild
        onPointerDown={press}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') press()
        }}
        onPointerEnter={() => {
          pressed.current = false
        }}
        onBlur={(e) => {
          // focus went to another control, not into the menu or dialog the trigger opened
          const to = e.relatedTarget
          if (to instanceof Element && to.closest(POPUP) === null) pressed.current = false
        }}
      >
        {children}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal container={container}>
        <RadixTooltip.Content
          className={styles['content']}
          side={side}
          align={align}
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
