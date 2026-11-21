// Electron main process entry. Process model: docs/architecture/overview.md
// The app host (projects, library, dispatchers) is shared with the headless CLI/MCP entry
// (src/main/cli); the GUI adds windows, project IPC and local HTTP (docs/architecture/llm-api.md).
import { app, BrowserWindow, dialog } from 'electron'
import { join, resolve } from 'node:path'
import { RENDERER_LOG_LEVEL_ARG, type Logger, type LogLevel } from '../shared/logging'
import { SETTINGS_ARG } from '../shared/preload-api'
import type { AppSettings } from '../shared/settings'
import { createAppHost } from './host/app-host'
import { registerProjectIpc, type WindowSessions } from './ipc'
import { startLogging } from './logging/electron'
import { MACHINE_UTILITY_ENTRY_PATH } from './machine/bundled'
import { pushRunStatus, utilityHostFactory } from './machine/electron'
import { createMachineClient } from './machine/spawn'
import { createLocalHttpControl, localHttpSetting } from './mcp/http'
import { installAppMenu } from './menu'
import { createExportFiles } from './persistence/export-file'
import { resolveAppData } from './persistence/paths'
import { createSettingsStore, loadSettings } from './settings/store'
import { WORKER_ENTRY_PATH } from './workers/bundled'
import { createNodeWorkerPool } from './workers/node'

// End-to-end tests run the app with its windows never shown (docs/conventions/testing.md#app-playwright-for-electron),
// so a test run does not cover the developer's screen or take focus. Ignored in packaged builds.
const hideWindows = !app.isPackaged && process.env['DFYOM_HIDE_WINDOWS'] === '1'
if (hideWindows && process.platform === 'darwin') app.setActivationPolicy('accessory')

function createMainWindow(log: Logger, level: LogLevel, settings: AppSettings): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    // docs/conventions/ui.md#app-shell
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'DFYOM',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // a hidden test window must keep rendering and running timers at full rate
      backgroundThrottling: !hideWindows,
      // Read by the preload: renderers forward entries at the instance level, and apply the
      // settings (theme, motion, layout) before the first render.
      additionalArguments: [
        `${RENDERER_LOG_LEVEL_ARG}=${level}`,
        `${SETTINGS_ARG}=${encodeURIComponent(JSON.stringify(settings))}`,
      ],
    },
  })
  log.debug({ win: win.id }, 'window created')

  if (!hideWindows) win.once('ready-to-show', () => win.show())

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

// `--data-dir` (docs/architecture/persistence.md#files-and-folders) moves all app data: Electron's
// `userData` (Chromium profile) and the log folder too, so one flag isolates a run (the end-to-end
// tests use it). Must be set before `ready`.
const dataDir = resolveAppData(process.argv)
if (dataDir !== undefined) {
  app.setPath('userData', resolve(dataDir))
  app.setAppLogsPath(join(resolve(dataDir), 'logs'))
}

void app.whenReady().then(async () => {
  const { log, level, instance, forward, report } = await startLogging()
  // The app-wide compute pool (docs/architecture/workers.md#lanes-and-pool). Workers spawn lazily;
  // the host prewarms the geometry worker when the first project opens.
  const workers = createNodeWorkerPool({
    entryPath: WORKER_ENTRY_PATH,
    log,
    logLevel: level,
    forward,
  })
  // The app instance's one machine connection (docs/modes/run-v0.1.md#processes): the host runs in
  // a utility process started by run.connection.open; it is `services.machine` of every project
  // dispatcher. Its status is pushed to renderers.
  const machine = createMachineClient({
    factory: utilityHostFactory(MACHINE_UTILITY_ENTRY_PATH),
    log,
    logLevel: level,
    forward,
    proc: 'utility',
  })
  machine.onStatus(pushRunStatus)
  const created = await createAppHost({
    appData: app.getPath('userData'),
    appVersion: app.getVersion(),
    instanceId: instance,
    log,
    report,
    workers,
    machine,
    exportFiles: createExportFiles(),
  })
  if (created.isErr()) {
    report(created.unwrapErr(), { kind: 'system', name: 'app.start' })
    app.exit(1)
    return
  }
  const host = created.unwrap()
  void host.listRecovery().then((r) => {
    if (r.isOk()) log.info({ count: r.unwrap().length }, 'recoverable projects found')
    else log.warn({ err: r.unwrapErr().toJSON() }, 'recovery scan failed')
  })

  // App settings (docs/conventions/ui.md#settings), before anything that depends on them.
  const appData = app.getPath('userData')
  const settings = createSettingsStore({
    appData,
    initial: await loadSettings(appData, log),
    log: log.child({ scope: 'settings' }),
  })

  // Local HTTP for agents: on by default, loopback only, token, Host/Origin checks
  // (docs/architecture/llm-api.md#local-http). The "Allow local agents to connect" setting
  // switches it; `--mcp-http=off|<port>` overrides the setting at start for one run.
  const httpSetting = localHttpSetting(process.argv, settings.get().allowLocalAgents)
  const http = createLocalHttpControl({
    host,
    appVersion: app.getVersion(),
    log,
    machine,
    ...(httpSetting.port === undefined ? {} : { port: httpSetting.port }),
  })
  const switchHttp = (enabled: boolean) =>
    void http.setEnabled(enabled).then((r) => {
      if (r.isErr()) report(r.unwrapErr(), { kind: 'system', name: 'mcp.http' })
    })
  if (httpSetting.enabled) switchHttp(true)
  settings.onChange((next, previous) => {
    if (next.allowLocalAgents !== previous.allowLocalAgents) switchHttp(next.allowLocalAgents)
  })

  installAppMenu()
  const windowLog = log.child({ scope: 'windows' })
  const sessions: WindowSessions = registerProjectIpc(host, http, settings)
  const openWindow = (key?: string) =>
    sessions.attach(createMainWindow(windowLog, level, settings.get()), key)
  // A project an agent opens gets its own window, which stays open after the session ends.
  host.onProjectOpened((key, source) => {
    if (source.kind === 'agent') openWindow(key)
  })
  openWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })

  // Quitting during a run asks first (docs/modes/run-v0.1.md#machine-host-and-protocol); quitting
  // anyway stops the run under control below (hold, then reset), never by just closing the port.
  let quitConfirmed = false
  app.on('before-quit', (event) => {
    const job = machine.status().job
    if (quitConfirmed || job === undefined || ['done', 'failed', 'stopped'].includes(job.phase))
      return
    event.preventDefault()
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      type: 'warning' as const,
      message: 'A run is in progress',
      detail: 'Quitting stops the run: DFYOM holds the feed, then resets the machine.',
      buttons: ['Cancel', 'Stop run and quit'],
      defaultId: 0,
      cancelId: 0,
    }
    void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).then((r) => {
      if (r.response !== 1) return
      quitConfirmed = true
      app.quit()
    })
  })

  // Quit: end agent sessions, close projects (unsaved changes stay recoverable), then the machine
  // connection under control (the host stops a running job: hold, reset; at most 3 s) and workers.
  let stopped = false
  app.on('will-quit', (event) => {
    if (stopped) return
    event.preventDefault()
    void (async () => {
      await http.setEnabled(false)
      await settings.flush()
      await host.shutdown()
      await machine.shutdown(3000)
      workers.terminate()
    })().finally(() => {
      stopped = true
      app.quit()
    })
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
