// Path of the bundled worker entry: electron-vite builds `entry.ts` as its own main-process chunk
// (`?modulePath`). Kept apart from node.ts so Vitest never sees the build-only import.
// Doc: docs/architecture/workers.md#lanes-and-pool
/// <reference types="electron-vite/node" />
import entryPath from './entry?modulePath'

export const WORKER_ENTRY_PATH: string = entryPath
