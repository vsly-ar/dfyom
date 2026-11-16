// Preload bridge. Contract: src/shared/preload-api.ts
import { contextBridge } from 'electron'
import type { PreloadApi } from '../shared/preload-api'

const api: PreloadApi = {
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
  },
}

contextBridge.exposeInMainWorld('dfyom', api)
