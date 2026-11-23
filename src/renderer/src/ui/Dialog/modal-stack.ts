// Open modal dialogs, innermost last, so a toast's Escape can close the dialog first (hardening
// U1): Radix makes a toast that appears over a dialog the highest dismissable layer, so its Escape
// would dismiss the toast and the dialog would need a second press. Doc: docs/conventions/ui.md#confirmations
import { useEffect, useRef, type RefObject } from 'react'

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
