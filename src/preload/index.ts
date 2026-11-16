// Preload bridge. Contract: src/shared/preload-api.ts
import { contextBridge, ipcRenderer } from 'electron'
import { flagValue, isLogLevel, LOG_IPC_CHANNEL, RENDERER_LOG_LEVEL_ARG } from '../shared/logging'
import type { PreloadApi } from '../shared/preload-api'

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
}

contextBridge.exposeInMainWorld('dfyom', api)
