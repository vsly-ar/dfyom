// IconButton: icon-only control with an accessible name and a tooltip of the same text plus its
// shortcut. As a toggle (`pressed`), the icon's accent part turns amber.
// Doc: docs/conventions/ui.md#radix-wrapping-pattern, #buttons, #icons
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './IconButton.module.css'

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'aria-label' | 'aria-pressed' | 'children'
> {
  /** Accessible name and tooltip text (sentence case, e.g. "Rectangle"). */
  label: string
  icon: ReactNode
  /** Shown in the tooltip after the label. */
  shortcut?: string
  /** Toggle state (tool selection, view options); omit for plain actions. */
  pressed?: boolean
  size?: 'md' | 'lg'
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
  ref?: Ref<HTMLButtonElement>
}

export function IconButton({
  label,
  icon,
  shortcut,
  pressed,
  size = 'md',
  tooltipSide,
  className,
  type = 'button',
  ...rest
}: IconButtonProps): React.JSX.Element {
  return (
    <Tooltip
      content={label}
      {...(shortcut ? { shortcut } : {})}
      {...(tooltipSide ? { side: tooltipSide } : {})}
    >
      <button
        {...rest}
        type={type}
        aria-label={label}
        {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
        data-size={size}
        className={[styles['button'], className].filter(Boolean).join(' ')}
      >
        {icon}
      </button>
    </Tooltip>
  )
}
