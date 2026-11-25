// The native application menu (ui.md decision 12): the macOS app menu (with Settings… Cmd+,), File
// (Settings… Ctrl+, on Windows and Linux), Edit, View, Window (with Library and Shape Editor), Help (with
// Connect an agent…, Open-source licences) with accelerators. Items that act on a project or the shell are sent to the focused window (`IPC.menuAction`), which
// runs them like the matching button or key, so menu, toolbar and shortcuts dispatch the same
// commands. Text editing (cut, copy, paste, select all) and window items use Electron's roles.
// Without any window (macOS), New / Open open an empty window; other items do nothing.
// Doc: docs/conventions/ui.md#app-shell, #keyboard-shortcuts, #project-files
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { IPC, type MenuAction } from '../shared/preload-api'

/** Menu actions that open an empty window when there is none (its start panel offers both). */
const WITHOUT_WINDOW: readonly MenuAction[] = ['project.new', 'project.open']
/** Menu actions that open a dialog: their window comes to the front (it may not be the focused one). */
const TO_FRONT: readonly MenuAction[] = ['app.settings', 'help.connectAgent']

/** What the menu needs from the app (src/main/index.ts). */
export interface MenuHooks {
  /** New / Open chosen while no window is open: an empty window. */
  readonly noWindow: () => void
  /** Window → Library (docs/conventions/ui-library-window.md, L2). */
  readonly openLibrary: () => void
  /** Help → Open-source licences: the notices window (src/main/licences-window.ts, PK1). */
  readonly openLicences?: () => void
  /**
   * The window that runs `action`: the focused one, except that the Library window passes the
   * items it does not handle to a project window. Default: the focused, else the first window.
   */
  readonly target?: (action: MenuAction) => BrowserWindow | undefined
}

const focusedOrFirst = (): BrowserWindow | undefined =>
  BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]

/** Sends `action` to its target window; without one, New / Open call `noWindow`. */
export function sendMenuAction(
  action: MenuAction,
  noWindow: () => void,
  target: (action: MenuAction) => BrowserWindow | undefined = focusedOrFirst,
): void {
  const win = target(action)
  if (win !== undefined && !win.isDestroyed()) {
    // a hidden window (test runs, DFYOM_HIDE_WINDOWS) stays hidden
    if (TO_FRONT.includes(action) && win.isVisible() && !win.isFocused()) win.focus()
    win.webContents.send(IPC.menuAction, action)
  } else if (WITHOUT_WINDOW.includes(action)) noWindow()
}

const NO_HOOKS: MenuHooks = { noWindow: () => {}, openLibrary: () => {} }

/** The menu template; `dev` adds reload and the developer tools. */
export function menuTemplate(
  platform: NodeJS.Platform,
  dev: boolean,
  hooks: MenuHooks = NO_HOOKS,
): MenuItemConstructorOptions[] {
  const noWindow = hooks.noWindow
  const mac = platform === 'darwin'
  const item = (
    label: string,
    action: MenuAction,
    accelerator?: string,
  ): MenuItemConstructorOptions => ({
    label,
    click: () => sendMenuAction(action, noWindow, hooks.target),
    ...(accelerator === undefined ? {} : { accelerator }),
  })
  // Settings… opens the settings dialog like the toolbar button (ui.md#keyboard-shortcuts)
  const settings = item('Settings…', 'app.settings', 'CmdOrCtrl+,')
  const template: MenuItemConstructorOptions[] = []
  if (mac)
    template.push({
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settings,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  template.push(
    {
      label: 'File',
      submenu: [
        item('New project…', 'project.new', 'CmdOrCtrl+N'),
        item('Open project…', 'project.open', 'CmdOrCtrl+O'),
        { type: 'separator' },
        item('Save', 'project.save', 'CmdOrCtrl+S'),
        item('Save as…', 'project.saveAs', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        ...(mac ? [] : [settings, { type: 'separator' } satisfies MenuItemConstructorOptions]),
        mac ? { role: 'close', label: 'Close window' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // the window decides: text undo in a field, history undo elsewhere (ui.md#undo-and-redo)
        item('Undo', 'edit.undo', 'CmdOrCtrl+Z'),
        item('Redo', 'edit.redo', mac ? 'CmdOrCtrl+Shift+Z' : 'Ctrl+Y'),
        { type: 'separator' },
        // the window applies the project's pending changes (docs/architecture/apply.md#keyboard)
        item('Apply changes', 'project.apply', 'CmdOrCtrl+Enter'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Design', 'mode.design', 'CmdOrCtrl+1'),
        item('Plan', 'mode.plan', 'CmdOrCtrl+2'),
        item('Run', 'mode.run', 'CmdOrCtrl+3'),
        { type: 'separator' },
        item('Navigator', 'view.navigator'),
        item('Inspector', 'view.inspector'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(dev
          ? ([
              { type: 'separator' },
              { role: 'reload' },
              { role: 'toggleDevTools' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      role: 'windowMenu',
      submenu: [
        { role: 'minimize' },
        ...(mac ? ([{ role: 'zoom' }] satisfies MenuItemConstructorOptions[]) : []),
        { type: 'separator' },
        // the one Library window, from every window and without a project (L2)
        { label: 'Library', accelerator: 'CmdOrCtrl+Shift+L', click: () => hooks.openLibrary() },
        // the project's Shape Editor window, run by the project window (ui.md § DF94)
        item('Shape Editor', 'window.shapeEditor', 'CmdOrCtrl+Shift+E'),
        ...(mac
          ? ([{ type: 'separator' }, { role: 'front' }] satisfies MenuItemConstructorOptions[])
          : [{ role: 'close' } satisfies MenuItemConstructorOptions]),
      ],
    },
    {
      role: 'help',
      submenu: [
        item('Keyboard shortcuts', 'help.shortcuts'),
        // the `claude mcp add` lines with this installation's launcher (ui.md#connect-an-agent-hardening-a4)
        item('Connect an agent…', 'help.connectAgent'),
        { type: 'separator' },
        { label: 'Open-source licences', click: () => hooks.openLicences?.() },
      ],
    },
  )
  return template
}

export function installAppMenu(hooks: MenuHooks): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(menuTemplate(process.platform, !app.isPackaged, hooks)),
  )
}
