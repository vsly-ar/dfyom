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
  type MenuAction,
  type PartEvaluationView,
  type PreloadApi,
  type ProjectSnapshot,
  type ReferenceMeshReply,
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
  call: (name, args, opts) => ipcRenderer.invoke(IPC.call, name, args, opts) as Promise<CallReply>,
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
  evaluation: {
    get: (partId) =>
      ipcRenderer.invoke(IPC.evaluationGet, partId) as Promise<PartEvaluationView | null>,
    getPlan: (planId) =>
      ipcRenderer.invoke(IPC.evaluationPlanGet, planId) as Promise<PartEvaluationView | null>,
    onChange: (listener) => on<PartEvaluationView>(IPC.evaluationChanged, listener),
  },
  files: {
    chooseOpen: () => ipcRenderer.invoke(IPC.fileChooseOpen) as Promise<string | null>,
    chooseSave: (defaultName) =>
      ipcRenderer.invoke(IPC.fileChooseSave, defaultName) as Promise<string | null>,
    chooseExport: (defaultName) =>
      ipcRenderer.invoke(IPC.fileChooseExport, defaultName) as Promise<string | null>,
    chooseReference: () => ipcRenderer.invoke(IPC.fileChooseReference) as Promise<string | null>,
  },
  reference: {
    mesh: (referenceId) =>
      ipcRenderer.invoke(IPC.referenceMesh, referenceId) as Promise<ReferenceMeshReply>,
  },
  menu: {
    onAction: (listener) => on<MenuAction>(IPC.menuAction, listener),
  },
  window: {
    onCloseRequest: (listener) => on<WindowCloseRequest>(IPC.windowCloseRequest, listener),
    close: (confirm) => ipcRenderer.invoke(IPC.windowClose, confirm) as Promise<CallReply>,
    openProject: (name, args) =>
      ipcRenderer.invoke(IPC.windowOpenProject, name, args) as Promise<CallReply>,
  },
}

contextBridge.exposeInMainWorld('dfyom', api)
