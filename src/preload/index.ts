// Preload bridge. Contract: src/shared/preload-api.ts
import { contextBridge, ipcRenderer } from 'electron'
import { flagValue, isLogLevel, LOG_IPC_CHANNEL, RENDERER_LOG_LEVEL_ARG } from '../shared/logging'
import {
  IPC,
  RUN_STATUS_IPC_CHANNEL,
  type AgentSessionInfo,
  type CallReply,
  type LocalHttpState,
  type PreloadApi,
} from '../shared/preload-api'
import type { RunStatus } from '../core/run/service'
import type { ActionEvent } from '../core/commands/action-log'

/** Subscribes to a main → renderer channel; returns the unsubscribe. */
function on<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, handler)
  return () => void ipcRenderer.removeListener(channel, handler)
}

const level = flagValue(process.argv, RENDERER_LOG_LEVEL_ARG)

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
  },
  agents: {
    list: () => ipcRenderer.invoke(IPC.agentsList) as Promise<readonly AgentSessionInfo[]>,
    onSessions: (listener) => on<readonly AgentSessionInfo[]>(IPC.agentSessions, listener),
    localHttp: () => ipcRenderer.invoke(IPC.localHttpGet) as Promise<LocalHttpState>,
    setLocalHttp: (enabled) => ipcRenderer.invoke(IPC.localHttpSet, enabled) as Promise<CallReply>,
  },
}

contextBridge.exposeInMainWorld('dfyom', api)
