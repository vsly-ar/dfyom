// Electron main process entry. Process model: docs/architecture/overview.md
// The app host (projects, library, dispatchers) is shared with the headless CLI/MCP entry
// (src/main/cli); the GUI adds windows, project IPC and local HTTP (docs/architecture/llm-api.md).
import { app, BrowserWindow, dialog, screen } from 'electron'
import { join, resolve } from 'node:path'
import { RENDERER_LOG_LEVEL_ARG, type Logger, type LogLevel } from '../shared/logging'
import { SETTINGS_ARG } from '../shared/preload-api'
import type { AppSettings } from '../shared/settings'
import { createAppHost } from './host/app-host'
import { registerProjectIpc, type WindowFactory, type WindowSessions } from './ipc'
import { startLogging } from './logging/electron'
import { MACHINE_UTILITY_ENTRY_PATH } from './machine/bundled'
import { pushRunStatus, utilityHostFactory } from './machine/electron'
import { createMachineClient } from './machine/spawn'
import { createLocalHttpControl, localHttpSetting } from './mcp/http'
import { installAppMenu } from './menu'
import { createExportFiles } from './persistence/export-file'
import { resolveAppData } from './persistence/paths'
import {
  quitSteps,
  runIsActive,
  saveAllLetsQuit,
  saveFailedDialog,
  STOP_RUN_DIALOG,
  stopRunConfirmed,
  unsavedChangesDialog,
  unsavedChoice,
  type QuitDialog,
} from './quit'
import { createSettingsStore, loadSettings } from './settings/store'
import { cascadeBounds } from './window-open'
import { WORKER_ENTRY_PATH } from './workers/bundled'
import { createNodeWorkerPool } from './workers/node'

// End-to-end tests run the app with its windows never shown (docs/conventions/testing.md#app-playwright-for-electron),
// so a test run does not cover the developer's screen or take focus. Ignored in packaged builds.
const hideWindows = !app.isPackaged && process.env['DFYOM_HIDE_WINDOWS'] === '1'
if (hideWindows && process.platform === 'darwin') app.setActivationPolicy('accessory')

/** Windows that fired `ready-to-show` (true) or not yet (false). */
const ready = new WeakMap<BrowserWindow, boolean>()

/**
 * A main window, not shown yet (`windowFactory` shows it). Cascaded from `from` with its size
 * (docs/conventions/ui.md#project-files); the default size, centred, without one.
 */
function createMainWindow(
  log: Logger,
  level: LogLevel,
  settings: AppSettings,
  from: BrowserWindow | undefined,
): BrowserWindow {
  const source = from === undefined || from.isDestroyed() ? undefined : from.getBounds()
  const bounds =
    source === undefined
      ? undefined
      : cascadeBounds(source, screen.getDisplayMatching(source).workArea)
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    ...bounds,
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
  log.debug({ win: win.id, from: from?.id }, 'window created')
  ready.set(win, false)
  win.once('ready-to-show', () => ready.set(win, true))

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/** Creates, shows and focuses windows; hidden test runs never show or focus one. */
function windowFactory(log: Logger, level: LogLevel, settings: () => AppSettings): WindowFactory {
  return {
    create: (from) => createMainWindow(log, level, settings(), from),
    reveal(win) {
      if (hideWindows || win.isDestroyed()) return
      if (ready.get(win) === true) win.show()
      else win.once('ready-to-show', () => win.show())
    },
    focus(win) {
      if (hideWindows || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.focus()
    },
  }
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

  const windows = windowFactory(log.child({ scope: 'windows' }), level, () => settings.get())
  const sessions: WindowSessions = registerProjectIpc(host, http, settings, windows)
  // New / Open without any window (macOS): an empty window, whose start panel offers both.
  installAppMenu(() => sessions.open())
  // A project an agent opens gets its own window, which stays open after the session ends; the
  // user's New / Open choose their window in ipc.ts (docs/conventions/ui.md#project-files).
  host.onProjectOpened((key, source) => {
    if (source.kind === 'agent') sessions.open(key)
  })
  sessions.open()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) sessions.open()
  })

  // Quitting asks first (docs/conventions/ui.md#confirmations): during a run whether to stop it
  // (docs/modes/run-v0.1.md#machine-host-and-protocol; quitting anyway stops it under control
  // below: hold, then reset, never by just closing the port), then one confirmation for every
  // project with unsaved changes. Each question is asked only if still needed when its turn comes.
  // Paths that skip `before-quit` (app.exit after a failed start or a crash) never ask; the
  // headless CLI has its own entry (src/main/cli).
  let quitConfirmed = false
  let asking = false
  const unsavedProjects = () => host.list().filter((p) => p.dirty)
  const ask = (options: QuitDialog) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    return (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).then(
      (r) => r.response,
    )
  }
  const confirmQuit = async (): Promise<boolean> => {
    if (runIsActive(machine.status().job?.phase) && !stopRunConfirmed(await ask(STOP_RUN_DIALOG)))
      return false
    const unsaved = unsavedProjects()
    if (unsaved.length === 0) return true
    const choice = unsavedChoice(await ask(unsavedChangesDialog(unsaved.map((p) => p.name))))
    if (choice !== 'saveAll') return choice === 'discard'
    const saved = await sessions.saveAll(unsavedProjects())
    if (saved.kind === 'failed') await ask(saveFailedDialog(saved.name, saved.message))
    return saveAllLetsQuit(saved)
  }
  app.on('before-quit', (event) => {
    const steps = quitSteps({
      runActive: runIsActive(machine.status().job?.phase),
      unsaved: unsavedProjects(),
    })
    if (quitConfirmed || steps.length === 0) {
      sessions.markQuitting()
      return
    }
    event.preventDefault()
    if (asking) return
    asking = true
    void confirmQuit()
      .then((ok) => {
        if (!ok) return
        quitConfirmed = true
        app.quit()
      })
      .finally(() => {
        asking = false
      })
  })

  // Quit: end agent sessions, close projects (unsaved changes not saved above stay recoverable), then the machine
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
