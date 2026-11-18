// Preload bridge. Contract: src/shared/preload-api.ts
import { contextBridge, ipcRenderer } from 'electron'
import { flagValue, isLogLevel, LOG_IPC_CHANNEL, RENDERER_LOG_LEVEL_ARG } from '../shared/logging'
import { RUN_STATUS_IPC_CHANNEL, type PreloadApi } from '../shared/preload-api'
import type { RunStatus } from '../core/run/service'

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
    onStatus: (listener) => {
      const handler = (_e: Electron.IpcRendererEvent, status: RunStatus) => listener(status)
      ipcRenderer.on(RUN_STATUS_IPC_CHANNEL, handler)
      return () => void ipcRenderer.removeListener(RUN_STATUS_IPC_CHANNEL, handler)
    },
  },
}

contextBridge.exposeInMainWorld('dfyom', api)
