// Open modal dialogs, innermost last, so a toast's Escape can close the dialog first (hardening
// U1): Radix makes a toast that appears over a dialog the highest dismissable layer, so its Escape
// would dismiss the toast and the dialog would need a second press. Doc: docs/conventions/ui.md#confirmations
import { useEffect, useRef, type RefObject } from 'react'
import { MODAL_ATTR as MODAL_DIALOG_ATTR } from '../ApplyButton/ApplyScope'

/** Marks a modal dialog's footer: a context menu opened in the dialog never covers it (R21). */
export const DIALOG_FOOTER_ATTR = 'data-dialog-footer'

/**
 * Where a menu opened on `el` may go: inside the modal dialog around it, above its footer (design
 * review R21: the Shapes dialog's row menu covered Done). Undefined outside a modal dialog.
 */
export function dialogCollision(
  el: Element,
  margin = 8,
):
  | { boundary: Element; padding: { top: number; right: number; bottom: number; left: number } }
  | undefined {
  const dialog = el.closest(`[${MODAL_DIALOG_ATTR}]`)
  if (dialog === null) return undefined
  const footer = dialog.querySelector(`[${DIALOG_FOOTER_ATTR}]`)
  const bottom = footer === null ? 0 : footer.getBoundingClientRect().height
  // only the footer's edge binds: up and sideways the menu may leave the dialog (negative padding
  // grows the boundary to the window's edge less the margin), so it stays beside the pointer and
  // flips up rather than over to the dialog's far side
  const r = dialog.getBoundingClientRect()
  return {
    boundary: dialog,
    padding: {
      top: Math.min(margin, margin - r.top),
      right: Math.min(margin, margin - (window.innerWidth - r.right)),
      bottom: bottom + margin,
      left: Math.min(margin, margin - r.left),
    },
  }
}

interface OpenModal {
  readonly content: RefObject<HTMLElement | null>
  close(): void
}

const stack: OpenModal[] = []

/**
 * Closes the innermost open modal dialog when `focused` (the element Escape was pressed in) lies
 * inside it; true when one was closed. Focus elsewhere (in the toast, in a list portalled out of the
 * dialog) closes nothing, so that layer keeps its own Escape.
 */
export function closeTopModal(focused: Element | null): boolean {
  const top = stack.at(-1)
  const el = top?.content.current
  if (top === undefined || el == null || focused === null || !el.contains(focused)) return false
  top.close()
  return true
}

/** Registers an open modal dialog (its content element and how to close it) while `open`. */
export function useModalStack(
  open: boolean,
  content: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  const closer = useRef(close)
  closer.current = close
  useEffect(() => {
    if (!open) return
    const entry: OpenModal = { content, close: () => closer.current() }
    stack.push(entry)
    return () => {
      const i = stack.indexOf(entry)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [open, content])
}
