// Preload bridge. Contract: src/shared/preload-api.ts
import { contextBridge, ipcRenderer } from 'electron'
import { flagValue, isLogLevel, LOG_IPC_CHANNEL, RENDERER_LOG_LEVEL_ARG } from '../shared/logging'
import {
  IPC,
  RUN_STATUS_IPC_CHANNEL,
  SETTINGS_ARG,
  type AgentSessionInfo,
  type CallReply,
  type ConnectInfo,
  type LocalHttpState,
  type MenuAction,
  type PartEvaluationView,
  type PreloadApi,
  type ProjectSnapshot,
  type ReferenceMeshReply,
  type ReferenceSectionReply,
  type WindowCloseRequest,
  WINDOW_KIND_ARG,
  type LibraryCloseRequest,
  type LibraryContext,
} from '../shared/preload-api'
import type { LibraryChange } from '../core/library/library'
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

/**
 * Files main hands this window to open (hardening U5). Main sends them once the page loaded, which
 * can be before the shell subscribes, so they wait here for the first listener.
 */
const openFiles: { queued: string[]; listener?: (file: string) => void } = { queued: [] }
ipcRenderer.on(IPC.windowOpenFile, (_e, file: unknown) => {
  if (typeof file !== 'string') return
  if (openFiles.listener === undefined) openFiles.queued.push(file)
  else openFiles.listener(file)
})

const api: PreloadApi = {
  windowKind: flagValue(process.argv, WINDOW_KIND_ARG) === 'library' ? 'library' : 'project',
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
    connectInfo: () => ipcRenderer.invoke(IPC.agentsConnectInfo) as Promise<ConnectInfo>,
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
    chooseSvg: () => ipcRenderer.invoke(IPC.fileChooseSvg) as Promise<string | null>,
  },
  reference: {
    mesh: (referenceId) =>
      ipcRenderer.invoke(IPC.referenceMesh, referenceId) as Promise<ReferenceMeshReply>,
    section: (request) =>
      ipcRenderer.invoke(IPC.referenceSection, request) as Promise<ReferenceSectionReply>,
  },
  library: {
    open: (target) => ipcRenderer.invoke(IPC.libraryOpen, target ?? {}) as Promise<void>,
    onChanged: (listener) => on<LibraryChange>(IPC.libraryChanged, listener),
    context: () => ipcRenderer.invoke(IPC.libraryContext) as Promise<LibraryContext>,
    onContext: (listener) => on<LibraryContext>(IPC.libraryContextChanged, listener),
    report: (state) => ipcRenderer.send(IPC.libraryState, state),
    onCloseRequest: (listener) => on<LibraryCloseRequest>(IPC.libraryCloseRequest, listener),
    close: (quit) => ipcRenderer.invoke(IPC.libraryClose, quit === true) as Promise<void>,
  },
  menu: {
    onAction: (listener) => on<MenuAction>(IPC.menuAction, listener),
  },
  window: {
    onCloseRequest: (listener) => on<WindowCloseRequest>(IPC.windowCloseRequest, listener),
    close: (confirm) => ipcRenderer.invoke(IPC.windowClose, confirm) as Promise<CallReply>,
    openProject: (name, args) =>
      ipcRenderer.invoke(IPC.windowOpenProject, name, args) as Promise<CallReply>,
    onOpenFile(listener) {
      openFiles.listener = listener
      for (const file of openFiles.queued.splice(0)) listener(file)
      return () => {
        if (openFiles.listener === listener) delete openFiles.listener
      }
    },
  },
}

contextBridge.exposeInMainWorld('dfyom', api)
