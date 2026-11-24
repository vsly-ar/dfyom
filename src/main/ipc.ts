// Project and agent IPC of the GUI: every window is a session of the app host (source
// `ui:win-<id>`), so windows open, edit and save projects through the same routing as MCP.
// Also the replica snapshot, the settings, closing a project with its last window and the window
// choice for New / Open (one window per project).
// Doc: docs/architecture/llm-api.md#processes-and-hosting, docs/conventions/ui.md#app-shell,
// docs/conventions/ui.md#project-files
// Contract: src/shared/preload-api.ts
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { agentError } from '../core/agent/results'
import type { AgentSession, SessionInfo } from '../core/agent/session'
import { sourceKey } from '../core/commands/context'
import type { AppErrorData } from '../shared/errors/app-error'
import type { AppResult } from '../shared/result'
import {
  IPC,
  type AgentSessionInfo,
  type CallReply,
  type ConnectInfo,
  type LocalHttpState,
  type OpenedWindow,
  type ProjectSnapshot,
  type ReferenceMeshReply,
  type ReferenceSectionReply,
  type WindowCloseRequest,
} from '../shared/preload-api'
import type { Dispatcher } from '../core/commands/dispatcher'
import type { OpenProjectInfo } from '../core/project/lifecycle'
import { connectInfo, type Installation } from './connect-agent'
import { evaluationView, followEvaluations, planEvaluationView } from './evaluation-push'
import {
  chooseExportFile,
  chooseOpenFile,
  chooseReferenceFile,
  chooseSvgFile,
  chooseSaveFile,
  type DialogFolders,
} from './file-dialogs'
import type { AppHost } from './host/app-host'
import type { LocalHttpControl } from './mcp/http'
import type { SettingsStore } from './settings/store'
import type { SaveAllOutcome } from './quit'
import { closeNeedsProject } from './window-close'
import { isOpeningCommand, openTarget } from './window-open'

interface WindowSession {
  readonly win: BrowserWindow
  readonly session: AgentSession
  /** The runtime whose log the window follows (identity: a reopened project is another). */
  following: Dispatcher | undefined
  unsubscribe: (() => void) | undefined
  /** Stops the part evaluation push of the followed project (task 3.6). */
  unfollowEvaluations: (() => void) | undefined
  /** Its project was closed (or it has none to close): the next `close` goes through. */
  closeApproved: boolean
  /** A project close for this window is in flight. */
  closing: boolean
}

const NOT_A_WINDOW_ERROR: AppErrorData = {
  code: 'input.malformed',
  message: 'not a DFYOM window',
  issues: [],
  frames: [],
}
const NOT_A_WINDOW: CallReply = { ok: false, error: NOT_A_WINDOW_ERROR, retryable: false }

/** The `gesture` of `call`'s options, if a short string (anything else is ignored). */
function gestureOf(opts: unknown): string | undefined {
  const g = isPlainObject(opts) ? opts['gesture'] : undefined
  return typeof g === 'string' && g.length > 0 && g.length <= 200 ? g : undefined
}

function reply(r: AppResult<{ value: unknown; revision: number }>): CallReply {
  if (r.isOk()) return { ok: true, ...r.unwrap() }
  return { ok: false, ...agentError(r.unwrapErr()) }
}

/** Agent sessions only (the indicator names them, not windows or CLI runs). */
function agentSessions(sessions: readonly SessionInfo[]): AgentSessionInfo[] {
  return sessions
    .filter((s) => s.source.kind === 'agent')
    .map((s) => ({
      source: sourceKey(s.source),
      ...(s.client === undefined ? {} : { client: s.client }),
      ...(s.key === undefined ? {} : { key: s.key }),
    }))
}

/** Window creation, owned by src/main/index.ts (size, preload, hidden test runs). */
export interface WindowFactory {
  /** A new window, not shown yet; cascaded from `from` (docs/conventions/ui.md#project-files). */
  create(from?: BrowserWindow): BrowserWindow
  /** Shows the window once it is ready to show (never in hidden test runs). */
  reveal(win: BrowserWindow): void
  /** Brings the window to the front (not in hidden test runs). */
  focus(win: BrowserWindow): void
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A successful opening reply with the window that shows the project. */
function inWindow(r: CallReply, window: OpenedWindow): CallReply {
  if (!r.ok) return r
  return { ...r, value: { ...(isPlainObject(r.value) ? r.value : {}), window } }
}

export interface WindowSessions {
  /**
   * A new window as a session, bound to `key` if given, shown when ready; ended when the window
   * closes. Cascaded from the focused window. Returns the window.
   */
  open(key?: string): BrowserWindow
  /**
   * The app quits now (every quit question answered, src/main/index.ts): windows close without
   * closing their project first; host.shutdown closes them (unsaved changes stay recoverable).
   */
  markQuitting(): void
  /**
   * "Save all" on quit (docs/conventions/ui.md#confirmations): saves each project to its file; an
   * untitled one asks for a file with the save dialog (on its window). Stops at the first
   * cancelled dialog or failed save.
   */
  saveAll(projects: readonly OpenProjectInfo[]): Promise<SaveAllOutcome>
  /**
   * Makes the Library window a session without a project (it calls the app-scope `library.*`
   * commands; docs/conventions/ui-library-window.md), ended when it closes.
   */
  attachLibrary(win: BrowserWindow): void
  /** Whether a DFYOM window (project or Library) owns these web contents. */
  isWindow(webContentsId: number): boolean
  /** The project a window shows: its key and runtime, if bound. */
  boundProject(webContentsId: number): { key: string; dispatcher: Dispatcher } | undefined
}

export function registerProjectIpc(
  host: AppHost,
  http: LocalHttpControl,
  settings: SettingsStore,
  windows: WindowFactory,
  folders: DialogFolders,
  installation: Installation,
): WindowSessions {
  const byContents = new Map<number, WindowSession>()
  // App quit closes every project itself (host.shutdown, unsaved changes stay recoverable); set
  // only once the quit questions are answered, so a cancelled quit leaves window closing as it was.
  let quitting = false

  /**
   * Re-subscribes the window to its project's action log when its bound runtime changed (bound,
   * unbound, or the project was closed: the session unbinds from a runtime that ended).
   */
  const follow = (ws: WindowSession) => {
    const bound = ws.session.bound()
    const d = bound.isSome() ? bound.unwrap() : undefined
    if (d === ws.following) return
    ws.unsubscribe?.()
    ws.unsubscribe = undefined
    ws.unfollowEvaluations?.()
    ws.unfollowEvaluations = undefined
    ws.following = d
    if (d !== undefined)
      ws.unsubscribe = d.log.subscribe({ withPatches: true }, (e) => {
        if (!ws.win.isDestroyed()) ws.win.webContents.send(IPC.projectEvent, e)
      })
    const key = ws.session.boundKey
    if (d !== undefined && key !== undefined)
      ws.unfollowEvaluations = followEvaluations(host, key, (view) => {
        if (!ws.win.isDestroyed()) ws.win.webContents.send(IPC.evaluationChanged, view)
      })
    // after subscribing: the snapshot the window takes now is followed by every later event
    if (!ws.win.isDestroyed())
      ws.win.webContents.send(IPC.projectBound, ws.session.boundKey ?? null)
  }
  host.onProjectsChanged(() => {
    for (const ws of byContents.values()) follow(ws)
  })

  /** Only a known window's main frame may call (no subframes, no navigated-away frames). */
  const sessionOf = (event: IpcMainInvokeEvent): WindowSession | undefined => {
    const frame = event.senderFrame
    const main = event.sender.mainFrame
    if (frame === null || frame.processId !== main.processId || frame.routingId !== main.routingId)
      return undefined
    return byContents.get(event.sender.id)
  }

  ipcMain.handle(
    IPC.call,
    async (event, name: unknown, args: unknown, opts: unknown): Promise<CallReply> => {
      const ws = sessionOf(event)
      if (ws === undefined || typeof name !== 'string') return NOT_A_WINDOW
      const gesture = gestureOf(opts)
      const r = await ws.session.call(name, args ?? {}, gesture === undefined ? {} : { gesture })
      follow(ws)
      const out = reply(r.result)
      // Stop works from every window (ui.md#run-mode-safety-ui): a run job belongs to its
      // project's dispatcher, so a window without that project (another project, the Library
      // window) aborts it there.
      if (!out.ok && name === 'job.abort') return abortElsewhere(args, ws, out)
      return out
    },
  )

  /** `job.abort` through each other open project until one knows the job; else `refused`. */
  const abortElsewhere = async (
    args: unknown,
    ws: WindowSession,
    refused: CallReply,
  ): Promise<CallReply> => {
    const session = host.openSession({ kind: 'ui', id: `stop-${ws.win.id}` })
    try {
      for (const p of host.list()) {
        if (p.key === ws.session.boundKey || session.bind(p.key).isErr()) continue
        const r = reply((await session.call('job.abort', args ?? {})).result)
        if (r.ok) return r
      }
      return refused
    } finally {
      session.end()
    }
  }

  // Same sender check for every handler: only a DFYOM window's main frame.
  ipcMain.handle(IPC.agentsList, (event) =>
    sessionOf(event) === undefined ? [] : agentSessions(host.sessions()),
  )
  ipcMain.handle(IPC.localHttpGet, (event): LocalHttpState => {
    if (sessionOf(event) === undefined || http.server === undefined) return { enabled: false }
    return { enabled: true, port: http.server.port }
  })
  // Help → Connect an agent… (docs/conventions/ui.md#connect-an-agent-hardening-a4)
  ipcMain.handle(IPC.agentsConnectInfo, (event): ConnectInfo | null =>
    sessionOf(event) === undefined ? null : connectInfo(installation, http.server !== undefined),
  )
  ipcMain.handle(IPC.projectSnapshot, (event): ProjectSnapshot | null => {
    const ws = sessionOf(event)
    if (ws === undefined) return null
    follow(ws)
    const bound = ws.session.bound()
    const key = ws.session.boundKey
    if (bound.isNone() || key === undefined) return null
    const d = bound.unwrap()
    const info = host.list().find((p) => p.key === key)
    return {
      key,
      doc: d.doc,
      revision: d.revision,
      seq: d.log.lastSeq,
      file: info?.file ?? null,
      dirty: info?.dirty ?? false,
    }
  })

  // Part evaluations for the viewport (renderer only) and the native file dialogs (task 3.6).
  ipcMain.handle(IPC.evaluationGet, (event, partId: unknown) => {
    const ws = sessionOf(event)
    const key = ws?.session.boundKey
    if (key === undefined || typeof partId !== 'string') return null
    return evaluationView(host, key, partId)
  })
  ipcMain.handle(IPC.evaluationPlanGet, (event, planId: unknown) => {
    const ws = sessionOf(event)
    const key = ws?.session.boundKey
    if (key === undefined || typeof planId !== 'string') return null
    return planEvaluationView(host, key, planId)
  })
  ipcMain.handle(IPC.fileChooseOpen, (event) => {
    const ws = sessionOf(event)
    return ws === undefined ? null : chooseOpenFile(ws.win, folders)
  })
  ipcMain.handle(IPC.fileChooseSave, (event, name: unknown) => {
    const ws = sessionOf(event)
    return ws === undefined
      ? null
      : chooseSaveFile(ws.win, folders, typeof name === 'string' ? name : '')
  })
  // the export paths each window chose: the only files "Show in Finder" reveals (DF48)
  const exportedPaths = new WeakMap<WebContents, Set<string>>()
  ipcMain.handle(IPC.fileChooseExport, async (event, name: unknown) => {
    const ws = sessionOf(event)
    if (ws === undefined) return null
    const path = await chooseExportFile(ws.win, folders, typeof name === 'string' ? name : '')
    if (path !== null) {
      const paths = exportedPaths.get(event.sender) ?? new Set<string>()
      paths.add(path)
      exportedPaths.set(event.sender, paths)
    }
    return path
  })
  ipcMain.handle(IPC.fileShowInFolder, (event, path: unknown): boolean => {
    if (typeof path !== 'string' || exportedPaths.get(event.sender)?.has(path) !== true)
      return false
    shell.showItemInFolder(path)
    return true
  })

  ipcMain.handle(IPC.fileChooseReference, (event) => {
    const ws = sessionOf(event)
    return ws === undefined ? null : chooseReferenceFile(ws.win, folders)
  })
  ipcMain.handle(IPC.fileChooseSvg, (event) => {
    const ws = sessionOf(event)
    return ws === undefined ? null : chooseSvgFile(ws.win, folders)
  })
  // The ghost's triangles (task R3): read by the worker, copied once to the renderer, which keeps
  // them per asset (docs/modes/reference-model.md#ghost-mesh-task-r3).
  ipcMain.handle(
    IPC.referenceMesh,
    async (event, referenceId: unknown): Promise<ReferenceMeshReply> => {
      const ws = sessionOf(event)
      const key = ws?.session.boundKey
      if (key === undefined || typeof referenceId !== 'string')
        return { ok: false, error: NOT_A_WINDOW_ERROR }
      const r = await host.referenceMesh(key, referenceId)
      return r.isOk()
        ? { ok: true, positions: r.unwrap().positions, edges: r.unwrap().edges }
        : { ok: false, error: agentError(r.unwrapErr()).error }
    },
  )
  // The reference section for the Shape Editor (task U3): cut in the worker, segments copied once
  // (docs/modes/design-v0.3.md#implementation-u3).
  ipcMain.handle(
    IPC.referenceSection,
    async (event, request: unknown): Promise<ReferenceSectionReply> => {
      const ws = sessionOf(event)
      const key = ws?.session.boundKey
      const req = request as {
        referenceId?: unknown
        matrix?: unknown
        level?: unknown
        fit?: unknown
      } | null
      if (
        key === undefined ||
        typeof req?.referenceId !== 'string' ||
        !Array.isArray(req.matrix) ||
        typeof req.level !== 'number'
      )
        return { ok: false, error: NOT_A_WINDOW_ERROR }
      const r = await host.referenceSection(
        key,
        req.referenceId,
        req.matrix,
        req.level,
        req.fit === true,
      )
      if (r.isErr()) return { ok: false, error: agentError(r.unwrapErr()).error }
      const { segments, loops } = r.unwrap()
      return loops === undefined ? { ok: true, segments } : { ok: true, segments, loops }
    },
  )

  ipcMain.handle(IPC.settingsUpdate, (event, patch: unknown): CallReply => {
    if (sessionOf(event) === undefined) return NOT_A_WINDOW
    return reply(settings.update(patch).map((value) => ({ value, revision: 0 })))
  })
  settings.onChange((next) => {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send(IPC.settingsChanged, next)
  })

  /**
   * Closes the window's project (if this is its last window), then the window. A refusal is sent
   * to the window: unsaved changes ask for confirmation, other errors (a run) are shown.
   */
  const closeWindow = async (ws: WindowSession, confirm: boolean): Promise<CallReply> => {
    const key = closeNeedsProject(ws.session.boundKey, otherKeys(ws))
    if (key === undefined) {
      ws.closeApproved = true
      ws.win.close()
      return { ok: true, value: {}, revision: 0 }
    }
    ws.closing = true
    const r = await ws.session.call('project.close', { key, confirm })
    ws.closing = false
    const out = reply(r.result)
    if (out.ok) {
      ws.closeApproved = true
      if (!ws.win.isDestroyed()) ws.win.close()
      return out
    }
    if (!ws.win.isDestroyed()) {
      const unsaved = out.error.issues.some((i) => i.rule === 'unsavedChanges')
      const name = host.list().find((p) => p.key === key)?.name ?? key
      const request: WindowCloseRequest = unsaved
        ? { kind: 'unsavedChanges', name }
        : { kind: 'refused', error: out.error }
      ws.win.webContents.send(IPC.windowCloseRequest, request)
    }
    return out
  }
  const otherKeys = (ws: WindowSession): (string | undefined)[] =>
    [...byContents.values()].filter((o) => o !== ws).map((o) => o.session.boundKey)

  ipcMain.handle(IPC.windowClose, async (event, confirm: unknown): Promise<CallReply> => {
    const ws = sessionOf(event)
    if (ws === undefined) return NOT_A_WINDOW
    return closeWindow(ws, confirm === true)
  })

  host.onSessions((sessions) => {
    const agents = agentSessions(sessions)
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send(IPC.agentSessions, agents)
  })

  /** Makes `win` a session, bound to `key` if given; ended when the window closes. */
  const attach = (win: BrowserWindow, key?: string): WindowSession => {
    const session = host.openSession({ kind: 'ui', id: `win-${win.id}` })
    const ws: WindowSession = {
      win,
      session,
      following: undefined,
      unsubscribe: undefined,
      unfollowEvaluations: undefined,
      closeApproved: false,
      closing: false,
    }
    if (key !== undefined) session.bind(key)
    const contentsId = win.webContents.id
    byContents.set(contentsId, ws)
    follow(ws)
    // Closing the last window of a project closes the project (docs/conventions/ui.md#app-shell).
    win.on('close', (event) => {
      if (quitting || ws.closeApproved) return
      if (closeNeedsProject(ws.session.boundKey, otherKeys(ws)) === undefined) return
      event.preventDefault()
      if (!ws.closing) void closeWindow(ws, false)
    })
    win.on('closed', () => {
      ws.unsubscribe?.()
      ws.unfollowEvaluations?.()
      session.end()
      byContents.delete(contentsId)
    })
    return ws
  }

  /** A window bound to `key`, other than `except`, if any. */
  const showing = (key: string, except?: WindowSession): WindowSession | undefined =>
    [...byContents.values()].find(
      (o) => o !== except && o.session.boundKey === key && !o.win.isDestroyed(),
    )

  const focused = (target: WindowSession, asking: WindowSession, key: string): CallReply => {
    windows.focus(target.win)
    return {
      ok: true,
      value: { key, alreadyOpen: true, window: target === asking ? 'this' : 'other' },
      revision: target.session
        .bound()
        .map((d) => d.revision)
        .unwrapOr(0),
    }
  }

  // New / Open / Restore (docs/conventions/ui.md#project-files): one window per project. The
  // command runs through the session of the window that will show the project, so it binds that
  // window exactly as `call` binds the asking one.
  ipcMain.handle(
    IPC.windowOpenProject,
    async (event, name: unknown, args: unknown): Promise<CallReply> => {
      const ws = sessionOf(event)
      if (ws === undefined || !isOpeningCommand(name)) return NOT_A_WINDOW
      const a = isPlainObject(args) ? args : {}
      const file = name === 'project.open' && typeof a['file'] === 'string' ? a['file'] : undefined
      const target = openTarget({
        name,
        senderKey: ws.session.boundKey,
        openKey: file === undefined ? undefined : await host.openKey(file),
        windowKeys: [...byContents.values()].map((o) => o.session.boundKey),
        bindsNone: name === 'project.recovery.resolve' && a['action'] === 'discard',
      })
      let kind = target.kind
      if (target.kind === 'focus') {
        const other = showing(target.key)
        if (other !== undefined) return focused(other, ws, target.key)
        kind = ws.session.boundKey === undefined ? 'here' : 'newWindow' // closed meanwhile
      }
      if (kind !== 'newWindow') {
        const r = await ws.session.call(name, args ?? {})
        follow(ws)
        return inWindow(reply(r.result), 'this')
      }
      // Hidden until the command succeeded: a refusal (recovery, lock, error) closes it unseen and
      // the asking window shows the answer.
      const win = windows.create(ws.win)
      const created = attach(win, undefined)
      const r = await created.session.call(name, args ?? {})
      follow(created)
      const out = reply(r.result)
      const key = created.session.boundKey
      const other = key === undefined ? undefined : showing(key, created)
      if (!out.ok || key === undefined || other !== undefined) {
        created.closeApproved = true
        win.destroy()
        // opened meanwhile by another window (the check above raced with it)
        if (out.ok && key !== undefined && other !== undefined) return focused(other, ws, key)
        return out
      }
      windows.reveal(win)
      return inWindow(out, 'new')
    },
  )

  const windowOf = (key: string): BrowserWindow | null =>
    [...byContents.values()].find((ws) => ws.session.boundKey === key && !ws.win.isDestroyed())
      ?.win ??
    BrowserWindow.getFocusedWindow() ??
    null

  return {
    markQuitting() {
      quitting = true
    },
    async saveAll(projects) {
      // its own session, so no window's binding changes; the save reaches the windows' replicas
      // through the project log like any other session's save
      const session = host.openSession({ kind: 'ui', id: 'quit' })
      try {
        for (const p of projects) {
          let args: { target?: string; confirm?: boolean } = {}
          if (p.file === null) {
            const target = await chooseSaveFile(windowOf(p.key), folders, p.name)
            if (target === null) return { kind: 'cancelled' }
            // the OS dialog already asked before replacing a file (ui.md#project-files)
            args = { target, confirm: true }
          }
          const bound = session.bind(p.key)
          const r = bound.isErr() ? bound : (await session.call('project.save', args)).result
          if (r.isErr()) return { kind: 'failed', name: p.name, message: r.unwrapErr().message }
        }
        return { kind: 'saved' }
      } finally {
        session.end()
      }
    },
    open(key) {
      const win = windows.create(BrowserWindow.getFocusedWindow() ?? undefined)
      attach(win, key)
      windows.reveal(win)
      return win
    },
    attachLibrary(win) {
      attach(win, undefined)
    },
    isWindow: (id) => byContents.has(id),
    boundProject(id) {
      const ws = byContents.get(id)
      const key = ws?.session.boundKey
      const bound = ws?.session.bound()
      if (key === undefined || bound === undefined || bound.isNone()) return undefined
      return { key, dispatcher: bound.unwrap() }
    },
  }
}
