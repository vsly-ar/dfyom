// Keys the window handled itself, so the native menu's accelerator echo of the same key is not
// run twice (platforms differ in whether the page or the menu sees a key first).
// Doc: docs/conventions/ui.md#keyboard-shortcuts
import type { MenuAction } from '../../../shared/preload-api'

/** A menu action this soon after the same key was handled is the accelerator echo. */
const ECHO_MS = 300
let lastKey: { action: MenuAction; at: number } | undefined

/** Records that the window handled the key of `action` itself. */
export function noteKeyAction(action: MenuAction): void {
  lastKey = { action, at: performance.now() }
}

export function isKeyEcho(action: MenuAction): boolean {
  return (
    lastKey !== undefined && lastKey.action === action && performance.now() - lastKey.at < ECHO_MS
  )
}
