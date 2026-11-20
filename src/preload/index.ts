// Preload bridge. Contract: src/shared/preload-api.ts
import { contextBridge, ipcRenderer } from 'electron'
import { flagValue, isLogLevel, LOG_IPC_CHANNEL, RENDERER_LOG_LEVEL_ARG } from '../shared/logging'
import {
  IPC,
  RUN_STATUS_IPC_CHANNEL,
  SETTINGS_ARG,
  type AgentSessionInfo,
  type CallReply,
  type LocalHttpState,
  type PreloadApi,
  type ProjectSnapshot,
  type WindowCloseRequest,
} from '../shared/preload-api'
import type { AppSettings } from '../shared/settings'
import type { RunStatus } from '../core/run/service'
import type { ActionEvent } from '../core/commands/action-log'

/** Subscribes to a main → renderer channel; returns the unsubscribe. */
function on<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, handler)
  return () => void ipcRenderer.removeListener(channel, handler)
}

const level = flagValue(process.argv, RENDERER_LOG_LEVEL_ARG)

/** The settings main passed at window creation (validated by main; JSON, URI-encoded). */
function initialSettings(): AppSettings | undefined {
  const raw = flagValue(process.argv, SETTINGS_ARG)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(decodeURIComponent(raw)) as AppSettings
  } catch {
    return undefined
  }
}

const api: PreloadApi = {
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
  },
  log: {
    level: isLogLevel(level) ? level : 'info',
    send: (batch) => ipcRenderer.send(LOG_IPC_CHANNEL, batch),
  },
  run: {
    onStatus: (listener) => on<RunStatus>(RUN_STATUS_IPC_CHANNEL, listener),
  },
  call: (name, args) => ipcRenderer.invoke(IPC.call, name, args) as Promise<CallReply>,
  project: {
    onEvent: (listener) => on<ActionEvent>(IPC.projectEvent, listener),
    snapshot: () => ipcRenderer.invoke(IPC.projectSnapshot) as Promise<ProjectSnapshot | null>,
    onBound: (listener) => on<string | null>(IPC.projectBound, listener),
  },
  agents: {
    list: () => ipcRenderer.invoke(IPC.agentsList) as Promise<readonly AgentSessionInfo[]>,
    onSessions: (listener) => on<readonly AgentSessionInfo[]>(IPC.agentSessions, listener),
    localHttp: () => ipcRenderer.invoke(IPC.localHttpGet) as Promise<LocalHttpState>,
  },
  settings: {
    initial: initialSettings(),
    update: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch) as Promise<CallReply>,
    onChange: (listener) => on<AppSettings>(IPC.settingsChanged, listener),
  },
  window: {
    onCloseRequest: (listener) => on<WindowCloseRequest>(IPC.windowCloseRequest, listener),
    close: (confirm) => ipcRenderer.invoke(IPC.windowClose, confirm) as Promise<CallReply>,
  },
}

contextBridge.exposeInMainWorld('dfyom', api)
