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

const { sendMenuAction } = await import('./menu')

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
})
