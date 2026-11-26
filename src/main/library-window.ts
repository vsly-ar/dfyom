// The one Library window of the app instance (docs/conventions/ui-library-window.md, L1): opened
// or focused from any window (toolbar, Window → Library, context links), a session without a
// project (it calls the app-scope `library.*` commands), its context taken from the window that
// opened it (project, units, used items, followed live), library writes pushed to every window,
// and closing or quitting with an unsaved draft asking the window first (L3).
// Pure parts: src/main/library-context.ts. Contract: src/shared/preload-api.ts
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Dispatcher } from '../core/commands/dispatcher'
import type { LibraryTabKind } from '../core/library/item'
import {
  IPC,
  type LibraryCloseRequest,
  type LibraryContext,
  type LibraryProjectContext,
  type LibraryTarget,
} from '../shared/preload-api'
import type { AppHost } from './host/app-host'
import type { WindowSessions } from './ipc'
import {
  libraryProjectContext,
  parseLibraryTarget,
  parseLibraryWindowState,
  sameProjectContext,
} from './library-context'

/** Window creation, owned by src/main/index.ts (bounds, preload, hidden test runs). */
export interface LibraryWindowFactory {
  /** The Library window, not shown yet. */
  create(): BrowserWindow
  /** Shows it once ready (never in hidden test runs). */
  reveal(win: BrowserWindow): void
  /** Brings it to the front (not in hidden test runs). */
  focus(win: BrowserWindow): void
}

export interface LibraryWindows {
  /** Opens or focuses the window on `target`, with `from`'s project as its context. */
  open(from: BrowserWindow | undefined, target?: LibraryTarget): void
  isLibrary(win: BrowserWindow | null | undefined): boolean
  /**
   * Before quitting: true when nothing holds the quit. With a draft, asks the window (Save /
   * Discard / Cancel) and returns false; the app quits once the window closed.
   */
  readyToQuit(): boolean
}

export function createLibraryWindows(
  host: AppHost,
  sessions: WindowSessions,
  factory: LibraryWindowFactory,
): LibraryWindows {
  let win: BrowserWindow | undefined
  let draft: string | null = null
  let tab: LibraryTabKind = 'tool'
  let target: LibraryContext['target'] = null
  let seq = 0
  /** The web contents of the window that opened it last (its project is the context). */
  let opener: number | undefined
  let project: LibraryProjectContext | null = null
  let followed: Dispatcher | undefined
  let unfollow: (() => void) | undefined
  /** The user chose Save or Discard: the next close goes through. */
  let closeApproved = false
  let quitAfterClose = false

  const live = (): BrowserWindow | undefined =>
    win !== undefined && !win.isDestroyed() ? win : undefined
  const context = (): LibraryContext => ({ project, target, tab })
  const push = () => live()?.webContents.send(IPC.libraryContextChanged, context())

  /** The opener's project now; re-follows its action log when its runtime changed. */
  const refresh = (pushAlways: boolean) => {
    const bound = opener === undefined ? undefined : sessions.boundProject(opener)
    if (bound?.dispatcher !== followed) {
      unfollow?.()
      unfollow = undefined
      followed = bound?.dispatcher
      // a commit may add or drop a snapshot (tool picked, plan created): recompute "used"
      if (followed !== undefined) unfollow = followed.log.subscribe({}, () => refresh(false))
    }
    const next = bound === undefined ? null : libraryProjectContext(bound.key, bound.dispatcher.doc)
    const changed = !sameProjectContext(project, next)
    project = next
    if (changed || pushAlways) push()
  }
  host.onProjectsChanged(() => refresh(false))

  // library writes by anyone reach every window (lists, tool candidates, the editor's conflict)
  host.library.subscribe((change) => {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send(IPC.libraryChanged, change)
  })

  const fromLibrary = (event: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    live() !== undefined && event.sender.id === live()!.webContents.id

  const open = (from: BrowserWindow | undefined, t: LibraryTarget = {}) => {
    if (from !== undefined && !from.isDestroyed() && from !== live()) opener = from.webContents.id
    seq += 1
    target = { ...t, seq }
    if (t.kind !== undefined) tab = t.kind
    const existing = live()
    if (existing !== undefined) {
      refresh(true)
      factory.focus(existing)
      return
    }
    const created = factory.create()
    win = created
    draft = null
    closeApproved = false
    quitAfterClose = false
    sessions.attachLibrary(created)
    refresh(false)
    created.on('close', (event) => {
      if (closeApproved || draft === null) return
      event.preventDefault()
      ask(false)
    })
    created.on('closed', () => {
      win = undefined
      draft = null
      const quit = quitAfterClose
      quitAfterClose = false
      if (quit) app.quit()
    })
    factory.reveal(created)
  }

  const ask = (quit: boolean) => {
    const w = live()
    if (w === undefined || draft === null) return
    factory.reveal(w)
    factory.focus(w)
    const request: LibraryCloseRequest = { name: draft, quit }
    w.webContents.send(IPC.libraryCloseRequest, request)
  }

  ipcMain.handle(IPC.libraryOpen, (event, raw: unknown) => {
    if (!sessions.isWindow(event.sender.id)) return
    open(BrowserWindow.fromWebContents(event.sender) ?? undefined, parseLibraryTarget(raw))
  })
  ipcMain.handle(IPC.libraryContext, (event): LibraryContext | null =>
    fromLibrary(event) ? context() : null,
  )
  ipcMain.on(IPC.libraryState, (event, raw: unknown) => {
    const state = parseLibraryWindowState(raw)
    if (!fromLibrary(event) || state === undefined) return
    draft = state.draft
    tab = state.tab
  })
  // the reply to a close request: Save or Discard closes, and quits when the request was a quit
  ipcMain.handle(IPC.libraryClose, (event, quit: unknown) => {
    const w = live()
    if (!fromLibrary(event) || w === undefined) return
    closeApproved = true
    quitAfterClose = quit === true
    w.close()
  })

  return {
    open,
    isLibrary: (w) => w != null && w === live(),
    readyToQuit() {
      if (live() === undefined || draft === null) return true
      ask(true)
      return false
    },
  }
}
