// Shell keyboard shortcuts: modes (Ctrl/Cmd+1/2/3), undo/redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z,
// Ctrl+Y off macOS), F6 / Shift+F6 between shell regions. None fires while typing in a field
// (there the keys edit the text). Doc: docs/conventions/ui.md#mode-switching, #undo-and-redo,
// #accessibility
import { useEffect, useRef } from 'react'
import { APP_MODES, type AppMode } from '../../../core/modes'
import { noteKeyAction } from './key-echo'

export const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Shortcut text for tooltips: "⌘1" on macOS, "Ctrl+1" elsewhere. */
export function shortcutLabel(key: string, opts: { shift?: boolean } = {}): string {
  if (IS_MAC) return `${opts.shift ? '⇧' : ''}⌘${key}`
  return `Ctrl+${opts.shift ? 'Shift+' : ''}${key}`
}

/** Apply's shortcut text: "⌘↵" on macOS, "Ctrl+Enter" elsewhere (apply.md#tooltip). */
export const APPLY_SHORTCUT = IS_MAC ? '⌘↵' : 'Ctrl+Enter'
/** Apply's `aria-keyshortcuts`. */
export const APPLY_KEY_SHORTCUTS = IS_MAC ? 'Meta+Enter' : 'Control+Enter'

/** Typing targets: inputs, text areas, editable content and ARIA text boxes. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'reset', 'submit', 'color', 'file'].includes(
      target.type,
    )
  }
  return target.closest('[role="textbox"], [role="combobox"], [role="spinbutton"]') !== null
}

/** Attribute that marks a shell region for F6 cycling; `data-collapsed` skips it. */
export const REGION_ATTR = 'data-shell-region'

const TABBABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Moves focus to the next (or previous) visible shell region: its first control, or itself. */
export function cycleRegion(root: ParentNode, backwards: boolean): void {
  const regions = [...root.querySelectorAll<HTMLElement>(`[${REGION_ATTR}]`)].filter(
    (r) => !r.hasAttribute('data-collapsed'),
  )
  if (regions.length === 0) return
  const active = document.activeElement
  const at = regions.findIndex((r) => active !== null && r.contains(active))
  const step = backwards ? -1 : 1
  const next = regions[(at + step + regions.length) % regions.length] ?? regions[0]
  if (next === undefined) return
  const target = next.querySelector<HTMLElement>(TABBABLE) ?? next
  target.focus()
}

export interface ShellShortcutHandlers {
  onMode(mode: AppMode): void
  onUndo(): void
  onRedo(): void
}

export function useShellShortcuts(handlers: ShellShortcutHandlers): void {
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F6' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        cycleRegion(document, e.shiftKey)
        return
      }
      const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!mod || e.altKey || isEditableTarget(e.target)) return
      const h = latest.current
      const mode = APP_MODES[Number(e.key) - 1]
      if (/^[1-3]$/.test(e.key) && mode !== undefined && !e.shiftKey) {
        e.preventDefault()
        noteKeyAction(`mode.${mode}`)
        h.onMode(mode)
      } else if (e.key.toLowerCase() === 'z') {
        e.preventDefault()
        noteKeyAction(e.shiftKey ? 'edit.redo' : 'edit.undo')
        if (e.shiftKey) h.onRedo()
        else h.onUndo()
      } else if (!IS_MAC && e.key.toLowerCase() === 'y' && !e.shiftKey) {
        e.preventDefault()
        noteKeyAction('edit.redo')
        h.onRedo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
