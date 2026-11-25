// The Shape Editor window's plumbing kept free of Electron so it is unit-tested: the open request
// a project window sends, the target the window shows (the last one when the request names no
// shape), which windows close with their project, and which menu actions the window runs itself.
// src/main/shape-editor-window.ts wires them.
// Doc: docs/conventions/ui.md#shape-editor-window-df94
import type { MenuAction, ShapeEditorTarget } from '../shared/preload-api'

/** What a project window asks to open: a part and, optionally, one of its shapes. */
export interface ShapeEditorRequest {
  readonly partId: string
  readonly shapeId: string | null
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200

/** An open request from a renderer; undefined when malformed (ignored). */
export function parseShapeEditorRequest(raw: unknown): ShapeEditorRequest | undefined {
  if (!isPlainObject(raw) || !isId(raw['partId'])) return undefined
  const shapeId = raw['shapeId']
  if (shapeId !== null && shapeId !== undefined && !isId(shapeId)) return undefined
  return { partId: raw['partId'], shapeId: isId(shapeId) ? shapeId : null }
}

/**
 * The target an open request leads to: the requested shape; without one (Window → Shape Editor),
 * the last target of the project, else the requested part with no shape chosen.
 */
export function shapeEditorTarget(
  last: ShapeEditorTarget | undefined,
  request: ShapeEditorRequest,
  seq: number,
): ShapeEditorTarget {
  if (request.shapeId === null && last !== undefined) return { ...last, seq }
  return { partId: request.partId, shapeId: request.shapeId, seq }
}

/** The projects whose Shape Editor windows close: no longer open in the app. */
export function closedProjects(
  editorKeys: Iterable<string>,
  openKeys: readonly string[],
): string[] {
  return [...editorKeys].filter((k) => !openKeys.includes(k))
}

/**
 * Menu items the focused Shape Editor window runs itself: undo / redo (the project's one history,
 * or the text in a field) and Window → Shape Editor (it is already there). Every other item goes to
 * its project's window, so Save or Apply act on the project being edited.
 */
export const SHAPE_EDITOR_MENU_ACTIONS: readonly MenuAction[] = [
  'edit.undo',
  'edit.redo',
  'window.shapeEditor',
]

export function shapeEditorHandlesMenuAction(action: MenuAction): boolean {
  return SHAPE_EDITOR_MENU_ACTIONS.includes(action)
}
