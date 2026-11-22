// The Library window's plumbing kept free of Electron so it is unit-tested: the context it gets
// from the window that opened it (project, units, used items), the open request and state it is
// sent, and which menu actions it handles itself. src/main/library-window.ts wires them.
// Doc: docs/conventions/ui-library-window.md
import { LIBRARY_ITEM_KINDS, type LibraryItemKind } from '../core/library/item'
import { usedLibraryItemIds } from '../core/library/used'
import type { ProjectDoc } from '../core/project/document'
import type {
  LibraryProjectContext,
  LibraryTarget,
  LibraryWindowState,
  MenuAction,
} from '../shared/preload-api'

const isKind = (v: unknown): v is LibraryItemKind =>
  (LIBRARY_ITEM_KINDS as readonly unknown[]).includes(v)

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** An open request from a renderer: a known tab and a short item id, anything else dropped. */
export function parseLibraryTarget(raw: unknown): LibraryTarget {
  if (!isPlainObject(raw)) return {}
  const kind = isKind(raw['kind']) ? raw['kind'] : undefined
  const itemId =
    typeof raw['itemId'] === 'string' && raw['itemId'].length > 0 && raw['itemId'].length <= 200
      ? raw['itemId']
      : undefined
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(itemId === undefined ? {} : { itemId }),
  }
}

/** The state the Library window reports; undefined when malformed (ignored). */
export function parseLibraryWindowState(raw: unknown): LibraryWindowState | undefined {
  if (!isPlainObject(raw) || !isKind(raw['tab'])) return undefined
  const draft = raw['draft']
  if (draft !== null && (typeof draft !== 'string' || draft.length > 200)) return undefined
  return { draft, tab: raw['tab'] }
}

/** The opening window's project as the Library window sees it. */
export function libraryProjectContext(key: string, doc: ProjectDoc): LibraryProjectContext {
  return { key, name: doc.name, unitSystem: doc.unitSystem, used: usedLibraryItemIds(doc) }
}

/** Whether two project contexts show the same (no push needed). */
export function sameProjectContext(
  a: LibraryProjectContext | null,
  b: LibraryProjectContext | null,
): boolean {
  if (a === null || b === null) return a === b
  return (
    a.key === b.key &&
    a.name === b.name &&
    a.unitSystem === b.unitSystem &&
    a.used.length === b.used.length &&
    a.used.every((id, i) => b.used[i] === id)
  )
}

/**
 * Menu items the focused Library window runs itself: Save (its draft), Apply's key (Save too, L3),
 * text undo / redo and the shortcut list. Every other item goes to the last focused project
 * window, so File → New project or View → Plan still act on a project.
 */
export const LIBRARY_MENU_ACTIONS: readonly MenuAction[] = [
  'project.save',
  'project.apply',
  'edit.undo',
  'edit.redo',
  'help.shortcuts',
]

export function libraryHandlesMenuAction(action: MenuAction): boolean {
  return LIBRARY_MENU_ACTIONS.includes(action)
}
