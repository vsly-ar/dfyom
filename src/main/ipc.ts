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
import type { AppHost } from './host/app-host'
import type { LocalHttpControl } from './mcp/http'

interface WindowSession {
  readonly session: AgentSession
  boundKey: string | undefined
  unsubscribe: (() => void) | undefined
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

  /** Re-subscribes the window to its project's action log when its binding changed. */
  const follow = (win: BrowserWindow, ws: WindowSession) => {
    const key = ws.session.boundKey
    if (key === ws.boundKey) return
    ws.unsubscribe?.()
    ws.unsubscribe = undefined
    ws.boundKey = key
    const d = key === undefined ? undefined : host.project(key)
    if (d === undefined || d.isNone()) return
    ws.unsubscribe = d.unwrap().log.subscribe({ withPatches: true }, (e) => {
      if (!win.isDestroyed()) win.webContents.send(IPC.projectEvent, e)
    })
  }

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
    const win = BrowserWindow.fromWebContents(event.sender)
    if (ws === undefined || win === null || typeof name !== 'string')
      return {
        ok: false,
        error: { code: 'input.malformed', message: 'not a DFYOM window', issues: [], frames: [] },
        retryable: false,
      }
    const r = await ws.session.call(name, args ?? {})
    follow(win, ws)
    return reply(r.result)
  })

  ipcMain.handle(IPC.agentsList, () => agentSessions(host.sessions()))
  ipcMain.handle(IPC.localHttpGet, (): LocalHttpState =>
    http.server === undefined ? { enabled: false } : { enabled: true, port: http.server.port },
  )
  ipcMain.handle(IPC.localHttpSet, async (_event, enabled: unknown): Promise<CallReply> => {
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
      const ws: WindowSession = { session, boundKey: undefined, unsubscribe: undefined }
      if (key !== undefined) session.bind(key)
      const contentsId = win.webContents.id
      byContents.set(contentsId, ws)
      follow(win, ws)
      win.on('closed', () => {
        ws.unsubscribe?.()
        session.end()
        byContents.delete(contentsId)
      })
    },
  }
}
