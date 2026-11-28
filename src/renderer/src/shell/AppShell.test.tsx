import { act, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { createFakeBridge, fixtureDispatcher, type FakeBridge } from '../test/bridge'
import { expectNoAxeViolations, renderUi } from '../test/render'
import { createShell, ShellProvider } from './ShellContext'

// WebGL does not run in jsdom: the canvas and the scene are stubbed (ui.md#testing)
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

function renderShell(bridge: FakeBridge = createFakeBridge()) {
  const shell = createShell(bridge)
  return {
    bridge,
    shell,
    ...renderUi(
      <ShellProvider shell={shell}>
        <App />
      </ShellProvider>,
    ),
  }
}

/** A project without a part opens the Stock dialog by itself (D45); these tests close it. */
async function closeStockDialog(user: { keyboard: (keys: string) => Promise<void> }) {
  const dialog = await screen.findByRole('dialog', { name: 'Stock' })
  await user.keyboard('{Escape}')
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
}

afterEach(() => {
  delete document.documentElement.dataset['theme']
  delete document.documentElement.dataset['motion']
  document.title = ''
})

describe('AppShell', () => {
  it('lays out the landmarks: toolbar, modes, navigator, viewport, status bar', async () => {
    renderShell()
    expect(screen.getByRole('banner', { name: 'Main toolbar' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Modes' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Navigator' })).toBeInTheDocument()
    expect(
      within(screen.getByRole('main', { name: 'Viewport' })).getByRole('region', {
        name: '3D viewport',
      }),
    ).toBeInTheDocument()
    const status = screen.getByRole('contentinfo', { name: 'Status bar' })
    expect(await within(status).findByText('No project')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'No project open' })).toBeInTheDocument()
    expect(document.title).toBe('DFYOM')
  })

  it('switches modes by the switcher and by Ctrl/Cmd+1/2/3, not while typing', async () => {
    const { user } = renderShell()
    const mode = (name: string) => screen.getByRole('radio', { name })
    await user.click(mode('Plan'))
    expect(mode('Plan')).toBeChecked()
    expect(screen.getByRole('heading', { name: 'Plan', level: 2 })).toBeInTheDocument()
    await user.keyboard('{Control>}3{/Control}')
    expect(mode('Run')).toBeChecked()
    await user.keyboard('{Control>}1{/Control}')
    expect(mode('Design')).toBeChecked()

    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    await user.keyboard('{Control>}2{/Control}')
    expect(mode('Design')).toBeChecked()
    input.remove()
  })

  it('shows the bound project: title, save state, unit system; edits arrive by the replica', async () => {
    const bridge = createFakeBridge()
    const d = fixtureDispatcher('Bracket')
    bridge.bind(d, 'p1', { file: '/p/bracket.dfyom' })
    const { user } = renderShell(bridge)
    await closeStockDialog(user)
    const status = screen.getByRole('contentinfo', { name: 'Status bar' })
    expect(await within(status).findByText('Saved')).toBeInTheDocument()
    expect(within(status).getByText('Unit system: millimetres')).toBeInTheDocument()
    expect(document.title).toBe('Bracket')

    // an edit (any source) reaches the window through the patch stream
    await act(async () => {
      await bridge.call('project.name.update', { name: 'Plate' })
    })
    await waitFor(() => expect(document.title).toBe('Plate — Edited'))
    expect(within(status).getByText('Unsaved changes')).toBeInTheDocument()

    // undo names the step, then reverts it through history.undo
    const undo = await screen.findByRole('button', { name: 'Undo Rename project' })
    await user.click(undo)
    // undo is a commit too: the revision moved past the save, so still edited
    await waitFor(() => expect(document.title).toBe('Bracket — Edited'))
    expect(await screen.findByRole('button', { name: 'Redo Rename project' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()

    // shortcuts dispatch the same commands
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}')
    await waitFor(() => expect(document.title).toBe('Plate — Edited'))
    await user.keyboard('{Control>}z{/Control}')
    await waitFor(() => expect(document.title).toBe('Bracket — Edited'))
  })

  it('has New / Open / Save in the toolbar; Save shows unsaved changes (DF14)', async () => {
    const bridge = createFakeBridge()
    bridge.bind(fixtureDispatcher('Bracket'), 'p1', { file: '/p/bracket.dfyom' })
    const { user, shell } = renderShell(bridge)
    await closeStockDialog(user)
    const file = screen.getByRole('toolbar', { name: 'File' })
    expect(within(file).getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(within(file).getByRole('button', { name: 'Open project…' })).toBeEnabled()
    // New project… opens the same dialog as File → New project…
    await user.click(within(file).getByRole('button', { name: 'New project…' }))
    expect(shell.files.getState().dialog).toEqual({ kind: 'new' })
    await act(async () => shell.files.getState().closeDialog())
    await act(async () => {
      await bridge.call('project.name.update', { name: 'Plate' })
    })
    const save = await within(file).findByRole('button', { name: 'Save (unsaved changes)' })
    await user.click(save)
    await waitFor(() => expect(bridge.calls.some((c) => c.name === 'project.save')).toBe(true))
  })

  it('disables Save without a project (DF14)', async () => {
    renderShell()
    const file = await screen.findByRole('toolbar', { name: 'File' })
    expect(within(file).getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('names the agent when the top step is not the user’s', async () => {
    const bridge = createFakeBridge()
    const d = fixtureDispatcher()
    bridge.bind(d)
    const { user } = renderShell(bridge)
    await closeStockDialog(user)
    await act(async () => {
      const agent = { kind: 'agent', id: 'http-1' } as const
      const r = await d.dispatch('project.name.update', { name: 'X' }, agent, {
        expectedRevision: d.revision,
      })
      expect(r.isOk()).toBe(true)
    })
    expect(
      await screen.findByRole('button', { name: 'Undo Rename project – by agent' }),
    ).toBeInTheDocument()
  })

  it('sends a mode without its input to the mode that makes it', async () => {
    const bridge = createFakeBridge()
    bridge.bind(fixtureDispatcher())
    const { user } = renderShell(bridge)
    await closeStockDialog(user)
    // Run needs no plan: manual control of a library machine (DF31)
    await user.click(screen.getByRole('radio', { name: 'Run' }))
    expect(await screen.findByRole('combobox', { name: 'Plan' })).toHaveTextContent(
      'No plan (manual control)',
    )
    await user.click(screen.getByRole('radio', { name: 'Plan' }))
    await user.click(await screen.findByRole('button', { name: 'Go to Design' }))
    expect(screen.getByRole('radio', { name: 'Design' })).toBeChecked()
  })

  it('applies and persists the settings: theme, reduced motion, local agents', async () => {
    const { user, bridge } = renderShell()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    // grouped with the inspectors' group header style (DF110 S6)
    expect(
      within(dialog)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Appearance', 'Editing', 'Run', 'Agents'])
    expect(
      within(within(dialog).getByRole('region', { name: 'Appearance' })).getByRole('switch', {
        name: 'Reduce motion',
      }),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.dataset['theme']).toBe('dark')
    await user.click(within(dialog).getByRole('switch', { name: 'Reduce motion' }))
    expect(document.documentElement.dataset['motion']).toBe('reduce')
    const agents = within(dialog).getByRole('switch', { name: 'Allow local agents to connect' })
    expect(agents).toBeChecked()
    expect(agents).toHaveAccessibleDescription(/port 41234/)
    await user.click(agents)
    expect(bridge.settingsPatches).toEqual([
      { theme: 'dark' },
      { reduceMotion: true },
      { allowLocalAgents: false },
    ])
    await user.click(within(dialog).getByRole('radio', { name: 'System' }))
    expect(document.documentElement.dataset['theme']).toBeUndefined()
    // the default anchor of new pockets and profiles: nine points named from above (task F2)
    const anchor = within(dialog).getByRole('radiogroup', { name: 'Default anchor' })
    expect(within(anchor).getByRole('radio', { name: 'Centre' })).toBeChecked()
    await user.click(within(anchor).getByRole('radio', { name: 'Front left' }))
    expect(bridge.settingsPatches.at(-1)).toEqual({ defaultAnchor: { u: 'min', v: 'min' } })
    expect(within(anchor).getByRole('radio', { name: 'Front left' })).toBeChecked()
    // auto-apply after a quiet spell (DF28): 10 s by default, Off turns it off
    const auto = within(dialog).getByRole('combobox', { name: 'Auto-apply after' })
    expect(auto).toHaveTextContent('10 s')
    await user.click(auto)
    await user.click(await screen.findByRole('option', { name: 'Off' }))
    expect(bridge.settingsPatches.at(-1)).toEqual({ autoApplyDelay: 0 })
    await expectNoAxeViolations()
  })

  it('follows settings changed in another window', async () => {
    const { bridge } = renderShell()
    act(() =>
      bridge.emitSettings({
        theme: 'light',
        reduceMotion: false,
        allowLocalAgents: true,
        layouts: {},
        defaultAnchor: { u: 'centre', v: 'centre' },
        libraryUnits: 'mm',
        snapGrid: { mm: 1, inch: 1 / 16 },
        autoApplyDelay: 10,
        sidePanels: {},
        lastMachine: null,
        jogKeys: 'game',
        skipHomeConfirm: [],
        autoReconnect: true,
        jogFeed: {},
        cuttingJogFeed: {},
        jogStep: {},
        inspectorGroups: {},
        inspectorTabs: {},
        homingRepeatability: {},
      }),
    )
    await waitFor(() => expect(document.documentElement.dataset['theme']).toBe('light'))
  })

  it('shows connected agents in the status bar and links to the setting', async () => {
    const { user, bridge } = renderShell()
    expect(screen.queryByRole('button', { name: /agent/i })).toBeNull()
    act(() =>
      bridge.emitSessions([
        { source: 'agent:http-2', client: 'Claude Code', key: 'p1' },
        { source: 'agent:stdio-1' },
      ]),
    )
    await user.click(await screen.findByRole('button', { name: '2 agents connected' }))
    const pop = await screen.findByRole('dialog', { name: 'Connected agents' })
    expect(within(pop).getByText('Claude Code')).toBeInTheDocument()
    expect(within(pop).getByText('agent:http-2')).toBeInTheDocument()
    expect(within(pop).getByText('Unknown client')).toBeInTheDocument()
    await user.click(within(pop).getByRole('button', { name: 'Agent settings' }))
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  })

  it('confirms closing a project with unsaved changes with its last window', async () => {
    const { user, bridge } = renderShell()
    act(() => bridge.emitCloseRequest({ kind: 'unsavedChanges', name: 'Bracket' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Close “Bracket” with unsaved changes?',
    })
    // the safe choice is focused first
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Close without saving' }))
    expect(bridge.closeCalls).toEqual([true])
  })

  it('shows why a project cannot be closed', async () => {
    const { bridge } = renderShell()
    act(() =>
      bridge.emitCloseRequest({
        kind: 'refused',
        error: { code: 'run.busy', message: 'a run job is running', issues: [], frames: [] },
      }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'The project cannot be closed now' })
    expect(dialog).toHaveTextContent('The machine is busy with another connection or run.')
    expect(bridge.closeCalls).toEqual([])
  })

  it('shows running jobs in the status bar after the indicator delay', async () => {
    const bridge = createFakeBridge()
    bridge.bind(fixtureDispatcher())
    let state: 'running' | 'finished' = 'running'
    bridge.handle('job.list', () => ({
      ok: true,
      revision: 0,
      value: {
        jobs: [
          {
            jobId: 'j1',
            name: 'design.part.evaluate',
            state,
            startRevision: 0,
            progress: { done: 1, total: 4 },
          },
        ],
      },
    }))
    bridge.handle('job.abort', () => {
      state = 'finished'
      return { ok: true, revision: 0, value: { state: 'finished' } }
    })
    const { user } = renderShell(bridge)
    await closeStockDialog(user)
    const trigger = await screen.findByRole('button', { name: 'Evaluate part' })
    await user.click(trigger)
    await user.click(await screen.findByRole('button', { name: 'Cancel Evaluate part' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Evaluate part' })).toBeNull())
    expect(bridge.calls.map((c) => c.name)).toContain('job.abort')
  })

  it('remembers per mode whether the navigator is shown (DF30)', async () => {
    const { user, bridge } = renderShell()
    const toggle = () => screen.getByRole('button', { name: 'Navigator' })
    const mode = (name: string) => screen.getByRole('radio', { name })
    // jsdom lays nothing out, so the panels do not collapse here: the toggle writes the mode's
    // choice, and the e2e suite (shell.e2e.ts) checks the panels following it
    await user.click(toggle())
    expect(bridge.settingsPatches.at(-1)).toEqual({
      sidePanels: { design: { navigator: false, inspector: true } },
    })
    await user.click(mode('Plan'))
    await user.click(toggle())
    expect(bridge.settingsPatches.at(-1)).toMatchObject({
      sidePanels: { plan: { inspector: true } },
    })
    expect(screen.getByRole('navigation', { name: 'Navigator' })).toHaveAttribute(
      'data-side',
      'navigator',
    )
  })

  it('opens the inspector over the viewport in a narrow window', async () => {
    const { user } = renderShell()
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Inspector' }))
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeInTheDocument()
  })

  it('moves between regions with F6', async () => {
    const { user } = renderShell()
    await screen.findByRole('heading', { name: 'No project open' })
    await user.keyboard('{F6}')
    expect(screen.getByRole('banner')).toContainElement(document.activeElement as HTMLElement)
    await user.keyboard('{F6}')
    expect(screen.getByRole('navigation', { name: 'Navigator' })).toContainElement(
      document.activeElement as HTMLElement,
    )
    await user.keyboard('{F6}')
    expect(screen.getByRole('region', { name: '3D viewport' })).toHaveFocus()
    await user.keyboard('{Shift>}{F6}{/Shift}')
    expect(screen.getByRole('navigation', { name: 'Navigator' })).toContainElement(
      document.activeElement as HTMLElement,
    )
  })

  it('has no axe violations, with a project and an agent', async () => {
    const bridge = createFakeBridge()
    bridge.bind(fixtureDispatcher())
    renderShell(bridge)
    act(() => bridge.emitSessions([{ source: 'agent:http-2', client: 'Claude Code' }]))
    await screen.findByRole('button', { name: 'Agent connected' })
    await expectNoAxeViolations()
  })
})
