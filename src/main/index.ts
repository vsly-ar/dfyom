// Electron main process entry. Process model: docs/architecture/overview.md
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { RENDERER_LOG_LEVEL_ARG, type Logger, type LogLevel } from '../shared/logging'
import { startLogging } from './logging/electron'

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
  const { log, level } = await startLogging()
  const windows = log.child({ scope: 'windows' })
  createMainWindow(windows, level)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(windows, level)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
