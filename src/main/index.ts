// Electron main process entry. Process model: docs/architecture/overview.md
import { app, BrowserWindow } from 'electron'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { RENDERER_LOG_LEVEL_ARG, type Logger, type LogLevel } from '../shared/logging'
import { startLogging } from './logging/electron'
import { resolveAppData } from './persistence/paths'
import { createProjectStorage } from './persistence/storage'
import { MACHINE_UTILITY_ENTRY_PATH } from './machine/bundled'
import { pushRunStatus, utilityHostFactory } from './machine/electron'
import { createMachineClient } from './machine/spawn'
import { WORKER_ENTRY_PATH } from './workers/bundled'
import { createNodeWorkerPool } from './workers/node'

function createMainWindow(log: Logger, level: LogLevel): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    title: 'DFYOM',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Read by the preload: renderers forward entries at the instance level.
      additionalArguments: [`${RENDERER_LOG_LEVEL_ARG}=${level}`],
    },
  })
  log.debug({ win: win.id }, 'window created')

  win.once('ready-to-show', () => win.show())

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(async () => {
  const { log, level, instance, forward } = await startLogging()
  // The app-wide compute pool (docs/architecture/workers.md#lanes-and-pool). Workers spawn lazily;
  // the geometry worker is prewarmed when the first project opens (project IPC, tasks 3.x).
  const workers = createNodeWorkerPool({
    entryPath: WORKER_ENTRY_PATH,
    log,
    logLevel: level,
    forward,
  })
  app.on('will-quit', () => workers.terminate())
  // The app instance's one machine connection (docs/modes/run-v0.1.md#processes): the host runs in
  // a utility process started by run.connection.open; it becomes `services.machine` of every
  // project dispatcher once project IPC exists (tasks 3.x). Its status is pushed to renderers.
  const machine = createMachineClient({
    factory: utilityHostFactory(MACHINE_UTILITY_ENTRY_PATH),
    log,
    logLevel: level,
    forward,
    proc: 'utility',
  })
  machine.onStatus(pushRunStatus)
  // Quit ends the connection under control first: the host stops a running job (hold, reset:
  // spindle off, buffers flushed) and closes the controller; at most 3 s, then the host is killed.
  let machineClosed = false
  app.on('will-quit', (event) => {
    if (machineClosed) return
    event.preventDefault()
    void machine.shutdown(3000).finally(() => {
      machineClosed = true
      app.quit()
    })
  })
  // Persistence smoke check until project IPC exists (tasks 3.3+): scan for recoverable projects.
  const storage = createProjectStorage({
    appData: resolveAppData(process.argv, app.getPath('userData')) ?? app.getPath('userData'),
    appVersion: app.getVersion(),
    owner: { instanceId: instance, pid: process.pid, host: hostname() },
    log,
  })
  void storage.listRecoverable().then((r) => {
    if (r.isOk()) log.info({ count: r.unwrap().length }, 'recoverable projects found')
    else log.warn({ err: r.unwrapErr().toJSON() }, 'recovery scan failed')
  })
  const windows = log.child({ scope: 'windows' })
  createMainWindow(windows, level)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(windows, level)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
