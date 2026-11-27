// The machine host in an Electron utility process (the app; ADR 0016), and the run-status push
// to renderers. Doc: docs/modes/run-v0.1.md#processes, #status
import { BrowserWindow, ipcMain, powerSaveBlocker, utilityProcess } from 'electron'
import type { MachineClient, MachineHostFactory } from '../../core/run/host/client'
import type { RunProgram, RunStatus } from '../../core/run/service'
import type { RunJournal } from '../../core/run/journal'
import type { AppErrorData } from '../../shared/errors/app-error'
import { IPC, RUN_STATUS_IPC_CHANNEL } from '../../shared/preload-api'

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

/**
 * DF84: answers a DFYOM window's `window.dfyom.run.program(jobId)` with the program the run job
 * streamed, or null (docs/modes/run.md#gcode-panel-df84). Renderer only: no command, no agent tool.
 */
export function registerRunProgramIpc(
  machine: Pick<MachineClient, 'program'>,
  isWindow: (webContentsId: number) => boolean,
): void {
  ipcMain.handle(IPC.runProgram, (event, jobId: unknown): RunProgram | null =>
    isWindow(event.sender.id) && typeof jobId === 'string'
      ? (machine.program(jobId) ?? null)
      : null,
  )
}

/**
 * DF129 RC4: answers a DFYOM window's `run.reconnect(action)` ("Stop trying", "Simulate a lost
 * connection") and `run.record()` (the run record). Renderer only: no command, no agent tool
 * (docs/modes/run-recovery.md#implementation-rc4).
 */
export function registerRunRecoveryIpc(
  machine: Pick<MachineClient, 'cancelReconnect' | 'simulateConnectionLoss' | 'runRecord'>,
  isWindow: (webContentsId: number) => boolean,
): void {
  ipcMain.handle(IPC.runReconnect, async (event, action: unknown): Promise<AppErrorData | null> => {
    if (!isWindow(event.sender.id)) return null
    if (action === 'cancel') {
      machine.cancelReconnect()
      return null
    }
    if (action !== 'simulate') return null
    const r = await machine.simulateConnectionLoss()
    return r.isOk() ? null : r.unwrapErr().toWireData()
  })
  ipcMain.handle(IPC.runRecord, (event): RunJournal | null =>
    isWindow(event.sender.id) ? (machine.runRecord() ?? null) : null,
  )
}

/**
 * DF129: keeps the computer from sleeping while a run streams on a real connection (system sleep
 * suspends USB, a classic cause of mid-job disconnects); `prevent-app-suspension` lets the
 * display sleep (docs/modes/run-recovery.md#what-can-go-wrong-and-how-dfyom-notices).
 */
export function keepAwake(): (on: boolean) => void {
  let id: number | undefined
  return (on) => {
    if (on && id === undefined) id = powerSaveBlocker.start('prevent-app-suspension')
    else if (!on && id !== undefined) {
      powerSaveBlocker.stop(id)
      id = undefined
    }
  }
}

/** Pushes every status change to all windows (renderers subscribe through the preload). */
export function pushRunStatus(status: RunStatus): void {
  for (const win of BrowserWindow.getAllWindows())
    if (!win.isDestroyed()) win.webContents.send(RUN_STATUS_IPC_CHANNEL, status)
}
