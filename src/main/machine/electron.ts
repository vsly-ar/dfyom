// The machine host in an Electron utility process (the app; ADR 0016), and the run-status push
// to renderers. Doc: docs/modes/run-v0.1.md#processes, #status
import { BrowserWindow, utilityProcess } from 'electron'
import type { MachineHostFactory } from '../../core/run/host/client'
import type { RunStatus } from '../../core/run/service'
import { RUN_STATUS_IPC_CHANNEL } from '../../shared/preload-api'

/** Forks `entryPath` (the bundled utility.ts) per connection. */
export function utilityHostFactory(entryPath: string): MachineHostFactory {
  return (events) => {
    const child = utilityProcess.fork(entryPath, [], { serviceName: 'DFYOM machine host' })
    child.on('message', (m: unknown) => events.message(m))
    child.on('exit', (code) => events.exit(code))
    return {
      post: (message) => child.postMessage(message),
      terminate: () => void child.kill(),
    }
  }
}

/** Pushes every status change to all windows (renderers subscribe through the preload). */
export function pushRunStatus(status: RunStatus): void {
  for (const win of BrowserWindow.getAllWindows())
    if (!win.isDestroyed()) win.webContents.send(RUN_STATUS_IPC_CHANNEL, status)
}
