// Project and agent IPC of the GUI: every window is a session of the app host (source
// `ui:win-<id>`), so windows open, edit and save projects through the same routing as MCP.
// Doc: docs/architecture/llm-api.md#processes-and-hosting · contract: src/shared/preload-api.ts
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
} from '../shared/preload-api'
import type { Dispatcher } from '../core/commands/dispatcher'
import type { AppHost } from './host/app-host'
import type { LocalHttpControl } from './mcp/http'

interface WindowSession {
  readonly win: BrowserWindow
  readonly session: AgentSession
  /** The runtime whose log the window follows (identity: a reopened project is another). */
  following: Dispatcher | undefined
  unsubscribe: (() => void) | undefined
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
}

export function registerProjectIpc(host: AppHost, http: LocalHttpControl): WindowSessions {
  const byContents = new Map<number, WindowSession>()

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
    ws.following = d
    if (d === undefined) return
    ws.unsubscribe = d.log.subscribe({ withPatches: true }, (e) => {
      if (!ws.win.isDestroyed()) ws.win.webContents.send(IPC.projectEvent, e)
    })
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
  ipcMain.handle(IPC.localHttpSet, async (event, enabled: unknown): Promise<CallReply> => {
    if (sessionOf(event) === undefined) return NOT_A_WINDOW
    const r = await http.setEnabled(enabled === true)
    return reply(r.map(() => ({ value: {}, revision: 0 })))
  })

  host.onSessions((sessions) => {
    const agents = agentSessions(sessions)
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed()) win.webContents.send(IPC.agentSessions, agents)
  })

  return {
    attach(win, key) {
      const session = host.openSession({ kind: 'ui', id: `win-${win.id}` })
      const ws: WindowSession = { win, session, following: undefined, unsubscribe: undefined }
      if (key !== undefined) session.bind(key)
      const contentsId = win.webContents.id
      byContents.set(contentsId, ws)
      follow(ws)
      win.on('closed', () => {
        ws.unsubscribe?.()
        session.end()
        byContents.delete(contentsId)
      })
    },
  }
}
