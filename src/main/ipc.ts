// Project and agent IPC of the GUI: every window is a session of the app host (source
// `ui:win-<id>`), so windows open, edit and save projects through the same routing as MCP.
// Also the replica snapshot, the settings and closing a project with its last window.
// Doc: docs/architecture/llm-api.md#processes-and-hosting, docs/conventions/ui.md#app-shell
// Contract: src/shared/preload-api.ts
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { agentError } from '../core/agent/results'
import type { AgentSession, SessionInfo } from '../core/agent/session'
import { sourceKey } from '../core/commands/context'
import type { AppResult } from '../shared/result'
import {
  IPC,
  type AgentSessionInfo,
  type CallReply,
  type LocalHttpState,
  type ProjectSnapshot,
  type WindowCloseRequest,
} from '../shared/preload-api'
import type { Dispatcher } from '../core/commands/dispatcher'
import type { OpenProjectInfo } from '../core/project/lifecycle'
import { evaluationView, followEvaluations } from './evaluation-push'
import { chooseOpenFile, chooseSaveFile } from './file-dialogs'
import type { AppHost } from './host/app-host'
import type { LocalHttpControl } from './mcp/http'
import type { SettingsStore } from './settings/store'
import type { SaveAllOutcome } from './quit'
import { closeNeedsProject } from './window-close'

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

const NOT_A_WINDOW: CallReply = {
  ok: false,
  error: { code: 'input.malformed', message: 'not a DFYOM window', issues: [], frames: [] },
  retryable: false,
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

export interface WindowSessions {
  /** Makes `win` a session, bound to `key` if given; ended when the window closes. */
  attach(win: BrowserWindow, key?: string): void
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
}

export function registerProjectIpc(
  host: AppHost,
  http: LocalHttpControl,
  settings: SettingsStore,
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

  ipcMain.handle(IPC.call, async (event, name: unknown, args: unknown): Promise<CallReply> => {
    const ws = sessionOf(event)
    if (ws === undefined || typeof name !== 'string') return NOT_A_WINDOW
    const r = await ws.session.call(name, args ?? {})
    follow(ws)
    return reply(r.result)
  })

  // Same sender check for every handler: only a DFYOM window's main frame.
  ipcMain.handle(IPC.agentsList, (event) =>
    sessionOf(event) === undefined ? [] : agentSessions(host.sessions()),
  )
  ipcMain.handle(IPC.localHttpGet, (event): LocalHttpState => {
    if (sessionOf(event) === undefined || http.server === undefined) return { enabled: false }
    return { enabled: true, port: http.server.port }
  })
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
  ipcMain.handle(IPC.fileChooseOpen, (event) => {
    const ws = sessionOf(event)
    return ws === undefined ? null : chooseOpenFile(ws.win)
  })
  ipcMain.handle(IPC.fileChooseSave, (event, name: unknown) => {
    const ws = sessionOf(event)
    return ws === undefined ? null : chooseSaveFile(ws.win, typeof name === 'string' ? name : '')
  })

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
            const target = await chooseSaveFile(windowOf(p.key), p.name)
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
    attach(win, key) {
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
    },
  }
}
