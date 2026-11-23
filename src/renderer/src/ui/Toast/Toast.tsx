// Toast: undo offers and neutral notices ("Removed Pocket 2 · Undo"), announced politely; never
// for errors that need action. ToastRegion holds the provider and the list; the list shows in the
// mounted ToastAnchor (the shell's 3D view, bottom-centre: never over the side panels, DF45), else
// fixed bottom-right (gallery, tests). Toasts close after 6 s, paused while hovered or focused.
// Escape closes an open modal dialog before the toast (U1, ui/Dialog/modal-stack.ts).
// Doc: docs/conventions/ui.md#undo-and-redo, #errors, #radix-wrapping-pattern
import { Toast as RadixToast } from 'radix-ui'
import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../Button/Button'
import { closeTopModal } from '../Dialog/modal-stack'
import styles from './Toast.module.css'

/** How long a toast stays without hover or focus (ui.md#undo-and-redo, DF45). */
export const TOAST_DURATION_MS = 6000

// The one mounted anchor (the shell's viewport region); a module store, as there is one per window.
let anchor: HTMLElement | null = null
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
const setAnchor = (el: HTMLElement | null) => {
  anchor = el
  for (const l of listeners) l()
}

/**
 * Where toasts show: place it inside the region they belong over (the 3D view). It fills that
 * region without taking pointer events; `insetRight` keeps the list clear of an overlay on the
 * region's right edge (the narrow window's inspector).
 */
export function ToastAnchor({ insetRight = 0 }: { insetRight?: number }): React.JSX.Element {
  const style = insetRight > 0 ? ({ right: insetRight } satisfies CSSProperties) : undefined
  return <div ref={setAnchor} className={styles['anchor']} style={style} data-toast-anchor="" />
}

export interface ToastRegionProps {
  children?: ReactNode
  /** Render the viewport in the flow instead of in the anchor or fixed bottom-right (gallery). */
  inline?: boolean
}

/** Provider + viewport. Toasts rendered inside its children appear in the viewport. */
export function ToastRegion({ children, inline = false }: ToastRegionProps): React.JSX.Element {
  const target = useSyncExternalStore(
    subscribe,
    () => anchor,
    () => null,
  )
  const viewport = (
    <RadixToast.Viewport
      className={styles['viewport']}
      data-inline={inline || undefined}
      data-anchored={(!inline && target !== null) || undefined}
    />
  )
  return (
    <RadixToast.Provider duration={TOAST_DURATION_MS} label="Notifications">
      {children}
      {!inline && target !== null ? createPortal(viewport, target) : viewport}
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
      // a toast over a modal dialog: Escape closes the dialog first, the toast stays (U1)
      onEscapeKeyDown={(e) => {
        if (closeTopModal(document.activeElement)) e.preventDefault()
      }}
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
