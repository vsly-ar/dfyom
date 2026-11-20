// Toolbar: a row of IconButtons with separators; one tab stop, arrow keys move between buttons
// (Radix Toolbar roving focus). `floating` is the viewport toolbar look (--shadow-1).
// Doc: docs/conventions/ui.md#radix-wrapping-pattern, #layout
import { Toolbar as RadixToolbar } from 'radix-ui'
import type { ReactNode } from 'react'
import { IconButton, type IconButtonProps } from '../IconButton/IconButton'
import styles from './Toolbar.module.css'

export interface ToolbarProps {
  /** Accessible name ("Tools", "View"). */
  label: string
  children: ReactNode
  orientation?: 'horizontal' | 'vertical'
  /** Floating viewport toolbar: raised, translucent, small shadow. */
  floating?: boolean
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
}

export function Toolbar({
  label,
  children,
  orientation = 'horizontal',
  floating = false,
  className,
}: ToolbarProps): React.JSX.Element {
  return (
    <RadixToolbar.Root
      aria-label={label}
      orientation={orientation}
      data-floating={floating || undefined}
      className={[styles['toolbar'], className].filter(Boolean).join(' ')}
    >
      {children}
    </RadixToolbar.Root>
  )
}

/** An IconButton that takes part in the toolbar's roving focus. */
export function ToolbarButton(props: IconButtonProps): React.JSX.Element {
  return (
    <RadixToolbar.Button asChild>
      <IconButton {...props} />
    </RadixToolbar.Button>
  )
}

export function ToolbarSeparator(): React.JSX.Element {
  return <RadixToolbar.Separator className={styles['separator']} />
}
