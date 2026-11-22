// Electron main process entry. Process model: docs/architecture/overview.md
// The app host (projects, library, dispatchers) is shared with the headless CLI/MCP entry
// (src/main/cli); the GUI adds windows, project IPC and local HTTP (docs/architecture/llm-api.md).
import { app, BrowserWindow, dialog, screen } from 'electron'
import { join, resolve } from 'node:path'
import { RENDERER_LOG_LEVEL_ARG, type Logger, type LogLevel } from '../shared/logging'
import { SETTINGS_ARG, WINDOW_KIND_ARG, type WindowKind } from '../shared/preload-api'
import type { AppSettings } from '../shared/settings'
import { createAppHost } from './host/app-host'
import { registerProjectIpc, type WindowFactory, type WindowSessions } from './ipc'
import { startLogging } from './logging/electron'
import { MACHINE_UTILITY_ENTRY_PATH } from './machine/bundled'
import { pushRunStatus, utilityHostFactory } from './machine/electron'
import { createMachineClient } from './machine/spawn'
import { createLocalHttpControl, localHttpSetting } from './mcp/http'
import { libraryHandlesMenuAction } from './library-context'
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
import { createAppStateStore, loadAppState, type AppStateStore } from './settings/app-state'
import { createSettingsStore, loadSettings } from './settings/store'
import { createLibraryWindows, type LibraryWindows } from './library-window'
import { createLicencesWindow, noticesPath } from './licences-window'
import {
  APP_NAME,
  LIBRARY_WINDOW_SIZE,
  libraryWindowStart,
  windowStart,
  windowTitle,
  type WindowStart,
} from './window-state'
import { WORKER_ENTRY_PATH } from './workers/bundled'
import { CAVALIER_WASM_PATH } from './region2d/bundled'
import { loadHostRegion2d } from './region2d/node'
import { createNodeWorkerPool } from './workers/node'

// End-to-end tests run the app with its windows never shown (docs/conventions/testing.md#app-playwright-for-electron),
// so a test run does not cover the developer's screen or take focus. Also honoured when packaged,
// for the packaged smoke test (docs/conventions/packaging.md#smoke-test).
const hideWindows = process.env['DFYOM_HIDE_WINDOWS'] === '1'
if (hideWindows && process.platform === 'darwin') app.setActivationPolicy('accessory')

/** Windows that fired `ready-to-show` (true) or not yet (false). */
const ready = new WeakMap<BrowserWindow, boolean>()
/** How each window starts; maximized / full screen apply when it is shown (never in hidden runs). */
const starts = new WeakMap<BrowserWindow, WindowStart>()

/**
 * A window, not shown yet (`windowFactory` shows it). A project window is cascaded from `from`
 * with its size (docs/conventions/ui.md#project-files); without one, the remembered last window
 * (#remembered-window-state-and-dialog-folders), else the default size, centred. The Library window
 * (docs/conventions/ui-library-window.md) starts from its own remembered bounds.
 */
function createAppWindow(
  log: Logger,
  level: LogLevel,
  settings: AppSettings,
  appState: AppStateStore,
  kind: WindowKind,
  from: BrowserWindow | undefined,
): BrowserWindow {
  const workAreas = screen.getAllDisplays().map((d) => d.workArea)
  const primary = screen.getPrimaryDisplay().workArea
  const library = kind === 'library'
  const start = library
    ? libraryWindowStart(appState.get().libraryWindow, workAreas, primary)
    : windowStart({
        source: from === undefined || from.isDestroyed() ? undefined : from.getNormalBounds(),
        saved: appState.get().window,
        othersOpen: BrowserWindow.getAllWindows().length > 0,
        workAreas,
        primary,
      })
  const version = app.getVersion()
  const win = new BrowserWindow({
    ...(library ? LIBRARY_WINDOW_SIZE : { width: 1440, height: 900 }),
    ...start.bounds,
    // docs/conventions/ui.md#app-shell; the Library window's list and editor need less
    minWidth: library ? 820 : 1024,
    minHeight: library ? 520 : 640,
    show: false,
    title: windowTitle(library ? 'Library' : APP_NAME, version),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // a hidden test window must keep rendering and running timers at full rate
      backgroundThrottling: !hideWindows,
      // Read by the preload: renderers forward entries at the instance level, and apply the
      // settings (theme, motion, layout) before the first render; the window kind picks the screen.
      additionalArguments: [
        `${RENDERER_LOG_LEVEL_ARG}=${level}`,
        `${SETTINGS_ARG}=${encodeURIComponent(JSON.stringify(settings))}`,
        `${WINDOW_KIND_ARG}=${kind}`,
      ],
    },
  })
  log.debug({ win: win.id, kind, from: from?.id }, 'window created')
  ready.set(win, false)
  starts.set(win, start)
  win.once('ready-to-show', () => ready.set(win, true))
  // The native title adds the app name and version to the document title (ui.md#app-shell).
  win.on('page-title-updated', (event, title) => {
    event.preventDefault()
    win.setTitle(windowTitle(title, version))
  })
  // The last moved, resized or closed window is remembered for the next launch; the Library
  // window has its own record.
  const remember = () => {
    if (win.isDestroyed() || win.isMinimized()) return
    const state = {
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    }
    if (library) appState.setLibraryWindow(state)
    else appState.setWindow(state)
  }
  win.on('resize', remember)
  win.on('move', remember)
  win.on('maximize', remember)
  win.on('unmaximize', remember)
  win.on('enter-full-screen', remember)
  win.on('leave-full-screen', remember)
  win.on('close', remember)

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

/** Creates, shows and focuses windows; hidden test runs never show or focus one. */
function windowFactory(
  log: Logger,
  level: LogLevel,
  settings: () => AppSettings,
  appState: AppStateStore,
  isLibrary: (win: BrowserWindow) => boolean,
): WindowFactory & { createLibrary(): BrowserWindow } {
  const show = (win: BrowserWindow) => {
    win.show()
    const start = starts.get(win)
    if (start?.maximized === true) win.maximize()
    if (start?.fullScreen === true) win.setFullScreen(true)
  }
  return {
    // a project window never cascades from the Library window (another size and place)
    create: (from) =>
      createAppWindow(
        log,
        level,
        settings(),
        appState,
        'project',
        from !== undefined && isLibrary(from) ? undefined : from,
      ),
    createLibrary: () => createAppWindow(log, level, settings(), appState, 'library', undefined),
    reveal(win) {
      if (hideWindows || win.isDestroyed()) return
      if (ready.get(win) === true) show(win)
      else win.once('ready-to-show', () => show(win))
    },
    focus(win) {
      if (hideWindows || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.focus()
    },
  }
}

// The app's name in the Dock, app menu and task switcher, and the default `userData` folder name;
// `productName` gives the same when run as `electron .`, but not when run on a built file
// (`electron out/main/index.js`, the end-to-end tests). In development the macOS bundle name
// still says "Electron" unless `npm run dev` renamed it (scripts/dev-app-name.mjs).
// Doc: docs/conventions/ui.md#app-name-and-icon. Must be set before `ready`.
app.setName(APP_NAME)

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
  // The 2D port: synchronously for the dispatcher, the same bytes for the worker lanes
  // (docs/architecture/shapes.md#where-the-2d-layer-runs). The module ships with the app.
  const region2d = loadHostRegion2d(CAVALIER_WASM_PATH, log)
  if (region2d.isErr()) {
    report(region2d.unwrapErr(), { kind: 'system', name: 'app.start' })
    app.exit(1)
    return
  }
  const { port: region2dPort, wasm: region2dWasm } = region2d.unwrap()
  // The app-wide compute pool (docs/architecture/workers.md#lanes-and-pool). Workers spawn lazily;
  // the host prewarms the geometry worker when the first project opens.
  const workers = createNodeWorkerPool({
    entryPath: WORKER_ENTRY_PATH,
    log,
    logLevel: level,
    forward,
    region2dWasm,
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
    region2d: region2dPort,
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
  // Remembered window bounds and dialog folders (docs/conventions/ui.md#remembered-window-state-and-dialog-folders).
  const appState = createAppStateStore({
    appData,
    initial: await loadAppState(appData, log),
    log: log.child({ scope: 'app-state' }),
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

  // set below; the factory asks it which window is the Library window
  const library: { current?: LibraryWindows } = {}
  const windows = windowFactory(
    log.child({ scope: 'windows' }),
    level,
    () => settings.get(),
    appState,
    (win) => library.current?.isLibrary(win) === true,
  )
  const sessions: WindowSessions = registerProjectIpc(host, http, settings, windows, appState)
  // The one Library window (docs/conventions/ui-library-window.md): created hidden, shown by the
  // factory (never in hidden test runs).
  const libraryWindows = createLibraryWindows(host, sessions, {
    create: () => windows.createLibrary(),
    reveal: (win) => windows.reveal(win),
    focus: (win) => windows.focus(win),
  })
  library.current = libraryWindows
  // Help → Open-source licences (docs/conventions/packaging.md#third-party-notices)
  const licences = createLicencesWindow({
    path: noticesPath(app.isPackaged, process.resourcesPath, app.getAppPath()),
    hidden: hideWindows,
  })
  // The last focused project window: menu items the Library window does not handle go there.
  let lastProjectWindow: BrowserWindow | undefined
  app.on('browser-window-focus', (_e, win) => {
    if (!libraryWindows.isLibrary(win) && !licences.isLicences(win)) lastProjectWindow = win
  })
  // New / Open without any window (macOS): an empty window, whose start panel offers both.
  installAppMenu({
    noWindow: () => sessions.open(),
    openLicences: () => licences.open(),
    openLibrary: () => {
      const focused = BrowserWindow.getFocusedWindow() ?? undefined
      libraryWindows.open(
        focused !== undefined && libraryWindows.isLibrary(focused) ? undefined : focused,
      )
    },
    target: (action) => {
      const focused =
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((w) => !licences.isLicences(w))
      if (focused === undefined) return undefined
      const library = libraryWindows.isLibrary(focused)
      // the licences window runs nothing; the Library window runs its own items
      if (!library && !licences.isLicences(focused)) return focused
      if (library && libraryHandlesMenuAction(action)) return focused
      const project =
        lastProjectWindow !== undefined && !lastProjectWindow.isDestroyed()
          ? lastProjectWindow
          : BrowserWindow.getAllWindows().find(
              (w) => !libraryWindows.isLibrary(w) && !licences.isLicences(w),
            )
      return project
    },
  })
  // A project an agent opens gets its own window, which stays open after the session ends; the
  // user's New / Open choose their window in ipc.ts (docs/conventions/ui.md#project-files).
  host.onProjectOpened((key, source) => {
    if (source.kind === 'agent') sessions.open(key)
  })
  sessions.open()
  app.on('activate', () => {
    // the licences window alone is not an app window
    if (BrowserWindow.getAllWindows().every((w) => licences.isLicences(w))) sessions.open()
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
    // the Library window's unsaved draft first: it asks Save / Discard / Cancel and quits after
    if (!quitConfirmed && !libraryWindows.readyToQuit()) {
      event.preventDefault()
      return
    }
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
      await appState.flush()
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
