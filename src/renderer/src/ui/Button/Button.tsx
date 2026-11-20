// Button: neutral surface in every variant; primary differs by a semibold label, a stronger
// outline and an amber icon (never a coloured fill); danger colours label and icon only.
// Doc: docs/conventions/ui.md#buttons (decision 19), wrapping pattern: ui.md#radix-wrapping-pattern
import { Slot } from 'radix-ui'
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import styles from './Button.module.css'

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

interface BaseProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  size?: ButtonSize
  /** Layout only (margin, grid placement); appended to the wrapper's class. */
  className?: string | undefined
  /** Render the child element (e.g. a link) with the button's look. */
  asChild?: boolean
  ref?: Ref<HTMLButtonElement>
}

/** Every primary button has an icon (decision 19), so `icon` is required for it. */
export type ButtonProps = BaseProps &
  (
    | { variant: 'primary'; icon: ReactNode }
    | { variant?: Exclude<ButtonVariant, 'primary'>; icon?: ReactNode }
  )

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  className,
  asChild = false,
  type = 'button',
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      {...rest}
      type={asChild ? undefined : type}
      data-variant={variant}
      data-size={size}
      className={[styles['button'], className].filter(Boolean).join(' ')}
    >
      {asChild ? (
        children
      ) : (
        <>
          {icon}
          {children}
        </>
      )}
    </Comp>
  )
}
