// Menu actions without a window: New / Open open an empty window, other items do nothing.
// Doc: docs/conventions/ui.md#project-files
import { describe, expect, it, vi } from 'vitest'

const windows = vi.hoisted(() => ({
  list: [] as { isDestroyed(): boolean; webContents: { send: (...a: unknown[]) => void } }[],
}))
vi.mock('electron', () => ({
  app: {},
  Menu: {},
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => windows.list,
  },
}))

const { menuTemplate, sendMenuAction } = await import('./menu')

describe('menu actions', () => {
  it('without a window, New and Open open an empty one; other items do nothing', () => {
    windows.list = []
    const noWindow = vi.fn()
    sendMenuAction('project.new', noWindow)
    sendMenuAction('project.open', noWindow)
    sendMenuAction('project.save', noWindow)
    sendMenuAction('mode.plan', noWindow)
    expect(noWindow).toHaveBeenCalledTimes(2)
  })

  it('with a window, every item goes to it', () => {
    const send = vi.fn()
    windows.list = [{ isDestroyed: () => false, webContents: { send } }]
    const noWindow = vi.fn()
    sendMenuAction('project.open', noWindow)
    expect(send).toHaveBeenCalledWith('dfyom:menu.action', 'project.open')
    expect(noWindow).not.toHaveBeenCalled()
  })

  it('goes to the window the target picks (the Library window passes items on)', () => {
    const send = vi.fn()
    const other = { isDestroyed: () => false, webContents: { send } }
    windows.list = []
    sendMenuAction('mode.plan', vi.fn(), () => other as never)
    expect(send).toHaveBeenCalledWith('dfyom:menu.action', 'mode.plan')
  })

  it('Window → Library opens the Library window with Ctrl/Cmd+Shift+L', () => {
    const openLibrary = vi.fn()
    const template = menuTemplate('darwin', false, { noWindow: vi.fn(), openLibrary })
    const windowMenu = template.find((m) => m.role === 'windowMenu')
    const items = windowMenu?.submenu as {
      label?: string
      accelerator?: string
      click?: () => void
    }[]
    const item = items.find((i) => i.label === 'Library')
    expect(item?.accelerator).toBe('CmdOrCtrl+Shift+L')
    item?.click?.()
    expect(openLibrary).toHaveBeenCalledOnce()
  })

  it('Settings… (Ctrl/Cmd+,): the macOS app menu, else File; it sends app.settings', () => {
    type Item = {
      label?: string
      accelerator?: string
      role?: string
      submenu?: unknown
      click?: () => void
    }
    const find = (items: Item[]) => items.find((i) => i.label === 'Settings…')
    const mac = menuTemplate('darwin', false) as Item[]
    const appMenu = mac.find((m) => m.role === 'appMenu')
    const macItem = find(appMenu?.submenu as Item[])
    expect(macItem?.accelerator).toBe('CmdOrCtrl+,')
    expect(find(mac.find((m) => m.label === 'File')?.submenu as Item[])).toBeUndefined()
    const win = menuTemplate('win32', false) as Item[]
    expect(win.find((m) => m.role === 'appMenu')).toBeUndefined()
    const winItem = find(win.find((m) => m.label === 'File')?.submenu as Item[])
    expect(winItem?.accelerator).toBe('CmdOrCtrl+,')
    const send = vi.fn()
    windows.list = [{ isDestroyed: () => false, webContents: { send } }]
    Object.assign(windows.list[0]!, { isVisible: () => false, isFocused: () => false })
    winItem?.click?.()
    expect(send).toHaveBeenCalledWith('dfyom:menu.action', 'app.settings')
  })

  it('Settings brings its window to the front unless it is hidden', () => {
    const focus = vi.fn()
    const target = (visible: boolean) =>
      ({
        isDestroyed: () => false,
        isVisible: () => visible,
        isFocused: () => false,
        focus,
        webContents: { send: vi.fn() },
      }) as never
    sendMenuAction('app.settings', vi.fn(), () => target(false))
    expect(focus).not.toHaveBeenCalled()
    sendMenuAction('app.settings', vi.fn(), () => target(true))
    expect(focus).toHaveBeenCalledOnce()
    sendMenuAction('mode.plan', vi.fn(), () => target(true))
    expect(focus).toHaveBeenCalledOnce()
  })
})
