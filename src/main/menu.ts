// The native application menu (ui.md decision 12): File, Edit, View, Help with accelerators. Items
// that act on a project or the shell are sent to the focused window (`IPC.menuAction`), which
// runs them like the matching button or key, so menu, toolbar and shortcuts dispatch the same
// commands. Text editing (cut, copy, paste, select all) and window items use Electron's roles.
// Doc: docs/conventions/ui.md#app-shell, #keyboard-shortcuts
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { IPC, type MenuAction } from '../shared/preload-api'

function send(action: MenuAction): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (win !== undefined && !win.isDestroyed()) win.webContents.send(IPC.menuAction, action)
}

const item = (
  label: string,
  action: MenuAction,
  accelerator?: string,
): MenuItemConstructorOptions => ({
  label,
  click: () => send(action),
  ...(accelerator === undefined ? {} : { accelerator }),
})

/** The menu template; `dev` adds reload and the developer tools. */
export function menuTemplate(
  platform: NodeJS.Platform,
  dev: boolean,
): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin'
  const template: MenuItemConstructorOptions[] = []
  if (mac) template.push({ role: 'appMenu' })
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
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [item('Keyboard shortcuts', 'help.shortcuts')],
    },
  )
  return template
}

export function installAppMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(process.platform, !app.isPackaged)))
}
