// Paths of the bundled machine host entries: electron-vite builds each as its own main-process
// chunk (`?modulePath`). Kept apart so Vitest never sees the build-only imports.
// Doc: docs/modes/run-v0.1.md#processes
/// <reference types="electron-vite/node" />
import nodeWorkerPath from './node-worker?modulePath'
import utilityPath from './utility?modulePath'

export const MACHINE_UTILITY_ENTRY_PATH: string = utilityPath
export const MACHINE_WORKER_ENTRY_PATH: string = nodeWorkerPath
