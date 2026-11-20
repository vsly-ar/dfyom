// Toast: undo offers and neutral notices ("Removed Pocket 2 · Undo"), announced politely; never
// for errors that need action. ToastRegion is placed once (shell, 3.3b) and holds the viewport.
// Doc: docs/conventions/ui.md#undo-and-redo, #errors, #radix-wrapping-pattern
import { Toast as RadixToast } from 'radix-ui'
import type { ReactNode } from 'react'
import { Button } from '../Button/Button'
import styles from './Toast.module.css'

export interface ToastRegionProps {
  children?: ReactNode
  /** Render the viewport in the flow instead of fixed bottom-right (gallery). */
  inline?: boolean
}

/** Provider + viewport. Toasts rendered inside its children appear in the viewport. */
export function ToastRegion({ children, inline = false }: ToastRegionProps): React.JSX.Element {
  return (
    <RadixToast.Provider duration={6000} label="Notifications">
      {children}
      <RadixToast.Viewport className={styles['viewport']} data-inline={inline || undefined} />
    </RadixToast.Provider>
  )
}

export interface ToastProps {
  message: ReactNode
  /** One action, usually "Undo"; `altText` says how to do it without the toast. */
  action?: { label: string; altText: string; onClick: () => void }
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** ms; `Infinity` keeps it open. */
  duration?: number
}

export function Toast({
  message,
  action,
  open,
  defaultOpen,
  onOpenChange,
  duration,
}: ToastProps): React.JSX.Element {
  return (
    <RadixToast.Root
      className={styles['toast']}
      {...(open !== undefined ? { open } : {})}
      {...(defaultOpen !== undefined ? { defaultOpen } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
      {...(duration !== undefined ? { duration } : {})}
    >
      <RadixToast.Description className={styles['message']}>{message}</RadixToast.Description>
      {action ? (
        <RadixToast.Action asChild altText={action.altText}>
          <Button size="sm" variant="ghost" onClick={action.onClick}>
            {action.label}
          </Button>
        </RadixToast.Action>
      ) : null}
    </RadixToast.Root>
  )
}
