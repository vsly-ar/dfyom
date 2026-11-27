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
  type RecentProjectView,
  type ReferenceMeshReply,
  type ReferenceCompareViewReply,
  type ReferenceSectionReply,
  type RunFileOpened,
  type RunFileReadReply,
  type WindowCloseRequest,
  WINDOW_KIND_ARG,
  type LibraryCloseRequest,
  type LibraryContext,
  type ShapeEditorTarget,
  type WindowKind,
} from '../shared/preload-api'
import type { LibraryChange } from '../core/library/library'
import type { AppSettings } from '../shared/settings'
import type { RunProgram, RunStatus } from '../core/run/service'
import type { RunJournal } from '../core/run/journal'
import type { AppErrorData } from '../shared/errors/app-error'
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

/** DF93: gCode files main hands this window before Run mode subscribes wait here. */
const runFiles: { queued: string[]; listener?: (file: string) => void } = { queued: [] }
ipcRenderer.on(IPC.runFileShow, (_e, file: unknown) => {
  if (typeof file !== 'string') return
  if (runFiles.listener === undefined) runFiles.queued.push(file)
  else runFiles.listener(file)
})

/** DF129 RC6: main's "show the recovery panel" before Run mode subscribes waits here. */
const showRecovery: { queued: boolean; listener?: () => void } = { queued: false }
ipcRenderer.on(IPC.runShowRecovery, () => {
  if (showRecovery.listener === undefined) showRecovery.queued = true
  else showRecovery.listener()
})

/** The window argument as a kind; a project window when absent or unknown. */
function windowKind(raw: string | undefined): WindowKind {
  return raw === 'library' || raw === 'shapes' ? raw : 'project'
}

const api: PreloadApi = {
  windowKind: windowKind(flagValue(process.argv, WINDOW_KIND_ARG)),
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
    program: (jobId) => ipcRenderer.invoke(IPC.runProgram, jobId) as Promise<RunProgram | null>,
    openFile: (path) => ipcRenderer.invoke(IPC.runFileOpen, path) as Promise<RunFileOpened | null>,
    onShowFile(listener) {
      runFiles.listener = listener
      for (const file of runFiles.queued.splice(0)) listener(file)
      return () => {
        if (runFiles.listener === listener) delete runFiles.listener
      }
    },
    readFile: (path) => ipcRenderer.invoke(IPC.runFileRead, path) as Promise<RunFileReadReply>,
    recentFiles: () => ipcRenderer.invoke(IPC.runFileRecent) as Promise<readonly string[]>,
    reconnect: (action) =>
      ipcRenderer.invoke(IPC.runReconnect, action) as Promise<AppErrorData | null>,
    record: () => ipcRenderer.invoke(IPC.runRecord) as Promise<RunJournal | null>,
    recovery: (action) =>
      ipcRenderer.invoke(IPC.runRecovery, action) as Promise<AppErrorData | null>,
    onShowRecovery(listener) {
      showRecovery.listener = listener
      if (showRecovery.queued) {
        showRecovery.queued = false
        listener()
      }
      return () => {
        if (showRecovery.listener === listener) delete showRecovery.listener
      }
    },
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
    showInFolder: (path) => ipcRenderer.invoke(IPC.fileShowInFolder, path) as Promise<boolean>,
    recent: () => ipcRenderer.invoke(IPC.fileRecent) as Promise<readonly RecentProjectView[]>,
    forgetRecent: (path) => ipcRenderer.invoke(IPC.fileForgetRecent, path) as Promise<void>,
  },
  reference: {
    mesh: (referenceId) =>
      ipcRenderer.invoke(IPC.referenceMesh, referenceId) as Promise<ReferenceMeshReply>,
    section: (request) =>
      ipcRenderer.invoke(IPC.referenceSection, request) as Promise<ReferenceSectionReply>,
    compareView: (request) =>
      ipcRenderer.invoke(IPC.referenceCompareView, request) as Promise<ReferenceCompareViewReply>,
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
  shapeEditor: {
    open: (target) => ipcRenderer.invoke(IPC.shapeEditorOpen, target) as Promise<void>,
    target: () => ipcRenderer.invoke(IPC.shapeEditorTarget) as Promise<ShapeEditorTarget | null>,
    onTarget: (listener) => on<ShapeEditorTarget>(IPC.shapeEditorTargetChanged, listener),
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
