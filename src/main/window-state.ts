// Where a new window starts and what its native title says (docs/conventions/ui.md#remembered-window-state-and-dialog-folders,
// #app-shell): kept free of Electron so it is unit-tested; src/main/index.ts wires it to
// window creation with the displays' work areas and the remembered state (settings/app-state.ts).
import type { WindowState } from './settings/app-state'
import { cascadeBounds, type Rect } from './window-open'

/** The app's name in the system: Dock, app menu, task switcher and window titles. */
export const APP_NAME = 'DFYOM'

/**
 * The native window title: the document title the renderer sets (project name, " — Edited"; the
 * app name without a project) followed by the app name and version.
 */
export function windowTitle(documentTitle: string, version: string): string {
  const app = `${APP_NAME} ${version}`
  const doc = documentTitle.trim()
  return doc === '' || doc === APP_NAME ? app : `${doc} — ${app}`
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** The work area that overlaps `r` most; `primary` when none does (its display is gone). */
export function workAreaOf(r: Rect, workAreas: readonly Rect[], primary: Rect): Rect {
  let best = primary
  let most = 0
  for (const area of workAreas) {
    const o = overlap(r, area)
    if (o > most) {
      most = o
      best = area
    }
  }
  return best
}

/**
 * `r` made fully visible: on the display it overlaps most (the primary display when its display
 * is gone), no larger than that work area and moved inside it.
 */
export function visibleBounds(r: Rect, workAreas: readonly Rect[], primary: Rect): Rect {
  const area = workAreaOf(r, workAreas, primary)
  const width = Math.min(r.width, area.width)
  const height = Math.min(r.height, area.height)
  const offDisplay = overlap(r, area) === 0
  const x = offDisplay
    ? area.x + Math.round((area.width - width) / 2)
    : Math.min(Math.max(r.x, area.x), area.x + area.width - width)
  const y = offDisplay
    ? area.y + Math.round((area.height - height) / 2)
    : Math.min(Math.max(r.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

export interface WindowStartInput {
  /** Normal bounds of the window it is opened from (the asking or focused window). */
  readonly source: Rect | undefined
  /** The remembered last window. */
  readonly saved: WindowState | undefined
  /** Whether any other window is open. */
  readonly othersOpen: boolean
  readonly workAreas: readonly Rect[]
  readonly primary: Rect
}

export interface WindowStart {
  /** Undefined: the default size, centred. */
  readonly bounds: Rect | undefined
  readonly maximized: boolean
  readonly fullScreen: boolean
}

/**
 * A new window's start: cascaded from its source window; without one, the remembered window made
 * visible, restored as it was (maximized, full screen) when no other window is open (launch, or
 * the first window after closing all on macOS), else cascaded from it; the default without a
 * remembered window. A cascaded window is never maximized or full screen.
 */
export function windowStart(i: WindowStartInput): WindowStart {
  const plain = (bounds: Rect | undefined): WindowStart => ({
    bounds,
    maximized: false,
    fullScreen: false,
  })
  if (i.source !== undefined)
    return plain(cascadeBounds(i.source, workAreaOf(i.source, i.workAreas, i.primary)))
  if (i.saved === undefined) return plain(undefined)
  const bounds = visibleBounds(i.saved.bounds, i.workAreas, i.primary)
  if (i.othersOpen) return plain(cascadeBounds(bounds, workAreaOf(bounds, i.workAreas, i.primary)))
  return { bounds, maximized: i.saved.maximized, fullScreen: i.saved.fullScreen }
}

/** The Library window's default size, centred (docs/conventions/ui-library-window.md, L1). */
export const LIBRARY_WINDOW_SIZE = { width: 1180, height: 760 } as const

/** The Shape Editor window's default size, centred (docs/conventions/ui.md#shape-editor-window-df94). */
export const SHAPE_EDITOR_WINDOW_SIZE = { width: 1180, height: 760 } as const

/**
 * The Library (or Shape Editor) window's start: its own remembered bounds made visible, restored as it was
 * (maximized, full screen); without a record, the default size, centred.
 */
export function libraryWindowStart(
  saved: WindowState | undefined,
  workAreas: readonly Rect[],
  primary: Rect,
): WindowStart {
  if (saved === undefined) return { bounds: undefined, maximized: false, fullScreen: false }
  return {
    bounds: visibleBounds(saved.bounds, workAreas, primary),
    maximized: saved.maximized,
    fullScreen: saved.fullScreen,
  }
}
