// The Shape Editor windows (docs/conventions/ui.md#shape-editor-window-df94, DF94): one per open
// project, opened or focused from its project window on a part's shape, a session bound to the
// same project (so its edits are the same commands with the project's one undo history), closed
// with its project and never closing it. Pure parts: src/main/shape-editor-context.ts. Contract:
// src/shared/preload-api.ts
import { BrowserWindow, ipcMain } from 'electron'
import { IPC, type ShapeEditorTarget } from '../shared/preload-api'
import type { AppHost } from './host/app-host'
import type { WindowSessions } from './ipc'
import {
  closedProjects,
  parseShapeEditorRequest,
  shapeEditorTarget,
  type ShapeEditorRequest,
} from './shape-editor-context'

/** Window creation, owned by src/main/index.ts (bounds, preload, hidden test runs). */
export interface ShapeEditorWindowFactory {
  /** A Shape Editor window, not shown yet. */
  create(): BrowserWindow
  /** Shows it once ready (never in hidden test runs). */
  reveal(win: BrowserWindow): void
  /** Brings it to the front (not in hidden test runs). */
  focus(win: BrowserWindow): void
}

export interface ShapeEditorWindows {
  /** Opens or focuses the Shape Editor window of `from`'s project on the request. */
  open(from: BrowserWindow, request: ShapeEditorRequest): void
  isShapeEditor(win: BrowserWindow | null | undefined): boolean
  /** The project window of a Shape Editor window's project (menu items it passes on). */
  projectWindowOf(win: BrowserWindow): BrowserWindow | undefined
}

interface Editor {
  readonly win: BrowserWindow
  target: ShapeEditorTarget
}

export function createShapeEditorWindows(
  host: AppHost,
  sessions: WindowSessions,
  factory: ShapeEditorWindowFactory,
): ShapeEditorWindows {
  /** By project key. */
  const editors = new Map<string, Editor>()
  /** The last target per open project, kept after its window closed (Window → Shape Editor). */
  const last = new Map<string, ShapeEditorTarget>()
  let seq = 0

  const live = (e: Editor | undefined): e is Editor => e !== undefined && !e.win.isDestroyed()
  const editorOf = (contentsId: number): Editor | undefined =>
    [...editors.values()].find((e) => live(e) && e.win.webContents.id === contentsId)

  // a closed project closes its editor (File → Close, or its project window closed it)
  host.onProjectsChanged(() => {
    const open = host.list().map((p) => p.key)
    for (const key of closedProjects(last.keys(), open)) last.delete(key)
    for (const key of closedProjects(editors.keys(), open)) {
      const e = editors.get(key)
      editors.delete(key)
      if (live(e)) e.win.close()
    }
  })

  const open = (from: BrowserWindow, request: ShapeEditorRequest) => {
    if (from.isDestroyed()) return
    const key = sessions.boundProject(from.webContents.id)?.key
    if (key === undefined) return
    seq += 1
    const target = shapeEditorTarget(last.get(key), request, seq)
    last.set(key, target)
    const existing = editors.get(key)
    if (live(existing)) {
      existing.target = target
      existing.win.webContents.send(IPC.shapeEditorTargetChanged, target)
      factory.reveal(existing.win)
      factory.focus(existing.win)
      return
    }
    const win = factory.create()
    const editor: Editor = { win, target }
    editors.set(key, editor)
    sessions.attachShapeEditor(win, key)
    win.on('closed', () => {
      if (editors.get(key) === editor) editors.delete(key)
    })
    factory.reveal(win)
  }

  ipcMain.handle(IPC.shapeEditorOpen, (event, raw: unknown) => {
    const request = parseShapeEditorRequest(raw)
    const from = BrowserWindow.fromWebContents(event.sender)
    if (request === undefined || from === null || !sessions.isProjectWindow(event.sender.id)) return
    open(from, request)
  })
  ipcMain.handle(
    IPC.shapeEditorTarget,
    (event): ShapeEditorTarget | null => editorOf(event.sender.id)?.target ?? null,
  )

  return {
    open,
    isShapeEditor: (w) => w != null && !w.isDestroyed() && editorOf(w.webContents.id)?.win === w,
    projectWindowOf(win) {
      const key = win.isDestroyed() ? undefined : sessions.boundProject(win.webContents.id)?.key
      return key === undefined ? undefined : sessions.projectWindow(key)
    },
  }
}
