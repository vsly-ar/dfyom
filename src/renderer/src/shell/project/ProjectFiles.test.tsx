// Project files in the window: New / Open / Save through the app-scope commands, the native
// dialogs (faked), the recovery prompt, a foreign lock, New / Open with a project open (main picks
// the window: src/main/window-open.ts), the menu and the shortcut list.
// Doc: docs/conventions/ui.md#project-files
import { act, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../App'
import {
  createFakeBridge,
  designDispatcher,
  errorReply,
  fixtureDispatcher,
  type FakeBridge,
} from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { createShell, ShellProvider } from '../ShellContext'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

function renderApp(bridge: FakeBridge) {
  const shell = createShell(bridge)
  return {
    shell,
    ...renderUi(
      <ShellProvider shell={shell}>
        <App />
      </ShellProvider>,
    ),
  }
}

const ok = (value: unknown) => ({ ok: true as const, value, revision: 0 })

describe('project files', () => {
  it('creates a project from the start panel (name, unit system)', async () => {
    const bridge = createFakeBridge()
    bridge.handle('project.recovery.list', () => ok({ projects: [] }))
    bridge.handle('project.create', async (args) => {
      bridge.bind(await designDispatcher((args as { name: string }).name, 'inch'), 'p2')
      return ok({ key: 'p2', revision: 0 })
    })
    const { user } = renderApp(bridge)
    await user.click(await screen.findByRole('button', { name: 'New project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    const name = within(dialog).getByRole('textbox', { name: 'Project name' })
    await user.clear(name)
    await user.type(name, 'Bracket', { skipClick: true })
    await user.click(within(dialog).getByRole('radio', { name: 'Inches' }))
    await expectNoAxeViolations()
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }))
    expect(bridge.calls.find((c) => c.name === 'project.create')?.args).toEqual({
      name: 'Bracket',
      unitSystem: 'inch',
    })
    expect(await screen.findByRole('region', { name: 'Set up the part' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('opens a file: the recovery prompt restores unsaved changes', async () => {
    const bridge = createFakeBridge()
    bridge.handle('project.recovery.list', () => ok({ projects: [] }))
    bridge.setFileChoice({ open: '/p/bracket.dfyom' })
    bridge.handle('project.open', () =>
      errorReply({
        code: 'persist.recovery',
        message: 'unsaved changes',
        issues: [],
        frames: [{ where: 'host.open', data: { key: 'proj-1', file: '/p/bracket.dfyom' } }],
      }),
    )
    bridge.handle('project.recovery.resolve', () => {
      bridge.bind(fixtureDispatcher('Bracket'), 'proj-1', { dirty: true })
      return ok({ key: 'proj-1', revision: 3 })
    })
    const { user } = renderApp(bridge)
    await user.click(await screen.findByRole('button', { name: 'Open project' }))
    const dialog = await screen.findByRole('dialog', { name: 'Restore unsaved changes?' })
    expect(dialog).toHaveTextContent('“/p/bracket.dfyom” has changes from an earlier session')
    await user.click(within(dialog).getByRole('button', { name: 'Restore changes' }))
    expect(bridge.calls.find((c) => c.name === 'project.recovery.resolve')?.args).toEqual({
      key: 'proj-1',
      action: 'restore',
    })
    await waitFor(() => expect(document.title).toBe('Bracket — Edited'))
  })

  it('a foreign lock offers to try again now or in 2 minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const bridge = createFakeBridge()
      bridge.handle('project.recovery.list', () => ok({ projects: [] }))
      bridge.setFileChoice({ open: '/p/bracket.dfyom' })
      let opens = 0
      bridge.handle('project.open', () => {
        opens++
        return errorReply(
          {
            code: 'persist.locked',
            message: 'the project is open in another instance',
            issues: [],
            frames: [{ where: 'lock.acquire', data: { holder: 'i-2', host: 'other' } }],
          },
          true,
        )
      })
      const { user } = renderApp(bridge)
      await user.click(await screen.findByRole('button', { name: 'Open project' }))
      const dialog = await screen.findByRole('dialog', { name: 'The project is open elsewhere' })
      await user.click(within(dialog).getByRole('button', { name: 'Try again' }))
      await waitFor(() => expect(opens).toBe(2))
      await user.click(within(dialog).getByRole('button', { name: 'Retry in 2 min' }))
      expect(within(dialog).getByRole('button', { name: /Retrying in [12]:\d\d/ })).toBeDisabled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
      })
      await waitFor(() => expect(opens).toBe(3))
    } finally {
      vi.useRealTimers()
    }
  })

  it('saves an untitled project through the save dialog (Ctrl/Cmd+S)', async () => {
    const bridge = createFakeBridge()
    bridge.bind(fixtureDispatcher('Bracket'))
    bridge.setFileChoice({ save: '/p/Bracket.dfyom' })
    bridge.handle('project.save', () => ok({}))
    const { user } = renderApp(bridge)
    await screen.findByText('Not saved yet')
    await user.keyboard('{Control>}s{/Control}')
    await waitFor(() =>
      expect(bridge.calls.find((c) => c.name === 'project.save')?.args).toEqual({
        target: '/p/Bracket.dfyom',
        confirm: true,
      }),
    )
    expect(bridge.saveDialogNames).toEqual(['Bracket'])
  })

  it('New with a project open asks nothing and creates through the window choice (menu too)', async () => {
    const bridge = createFakeBridge()
    bridge.bind(fixtureDispatcher('Bracket'), 'p1', { dirty: true, file: '/p/b.dfyom' })
    // main runs it in a new window: this one keeps its project
    bridge.handle('project.create', () => ok({ key: 'p2', revision: 0, window: 'new' }))
    const openProject = vi.spyOn(bridge.window, 'openProject')
    const { user } = renderApp(bridge)
    await screen.findByText('Unsaved changes')
    act(() => bridge.emitMenu('project.new'))
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(openProject).toHaveBeenCalledWith('project.create', {
      name: 'Untitled',
      unitSystem: 'mm',
    })
    expect(bridge.calls.map((c) => c.name)).not.toContain('project.close')
    expect(document.title).toBe('Bracket — Edited')
  })

  it('Open with a project open goes through the window choice without closing it', async () => {
    const bridge = createFakeBridge()
    bridge.bind(fixtureDispatcher('Bracket'), 'p1', { dirty: true, file: '/p/b.dfyom' })
    bridge.setFileChoice({ open: '/p/other.dfyom' })
    bridge.handle('project.open', () =>
      ok({ key: 'p2', revision: 0, alreadyOpen: false, window: 'new' }),
    )
    const openProject = vi.spyOn(bridge.window, 'openProject')
    renderApp(bridge)
    await screen.findByText('Unsaved changes')
    act(() => bridge.emitMenu('project.open'))
    await waitFor(() =>
      expect(openProject).toHaveBeenCalledWith('project.open', { file: '/p/other.dfyom' }),
    )
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(bridge.calls.map((c) => c.name)).not.toContain('project.close')
    expect(document.title).toBe('Bracket — Edited')
  })

  it('lists the keyboard shortcuts (Help menu and ?)', async () => {
    const bridge = createFakeBridge()
    bridge.handle('project.recovery.list', () => ok({ projects: [] }))
    const { user } = renderApp(bridge)
    await screen.findByRole('heading', { name: 'No project open' })
    act(() => bridge.emitMenu('help.shortcuts'))
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    expect(within(dialog).getByRole('region', { name: 'Project' })).toHaveTextContent('Save as')
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.keyboard('?')
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
  })
})
