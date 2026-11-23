// Help → Connect an agent… (hardening A4): the lines from main, Copy, the local-agents note and
// its way to the settings, the development note; axe.
// Doc: docs/conventions/ui.md#connect-an-agent-hardening-a4
import { act, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { createFakeBridge, type FakeBridge } from '../test/bridge'
import { expectNoAxeViolations, renderUi } from '../test/render'
import { createShell, ShellProvider } from './ShellContext'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

const ok = (value: unknown) => ({ ok: true as const, value, revision: 0 })
const BIN = '/Users/ana/Applications/DFYOM.app/Contents/Resources/bin/dfyom'

async function openDialog(bridge: FakeBridge) {
  bridge.handle('project.recovery.list', () => ok({ projects: [] }))
  const shell = createShell(bridge)
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  await screen.findByRole('heading', { name: 'No project open' })
  act(() => bridge.emitMenu('help.connectAgent'))
  const dialog = await screen.findByRole('dialog', { name: 'Connect an agent' })
  return { ...r, dialog }
}

describe('Connect an agent', () => {
  it('shows the lines of this installation and copies one', async () => {
    const bridge = createFakeBridge()
    bridge.setConnectInfo({
      connect: `claude mcp add --scope user dfyom -- ${BIN} mcp --connect`,
      headless: `claude mcp add --scope user dfyom -- ${BIN} mcp`,
      cli: BIN,
      development: false,
      localAgents: true,
    })
    const { user, dialog } = await openDialog(bridge)
    const connect = await within(dialog).findByRole('textbox', { name: 'Work in this app' })
    expect(connect).toHaveValue(`claude mcp add --scope user dfyom -- ${BIN} mcp --connect`)
    expect(connect).toHaveAttribute('readonly')
    expect(within(dialog).getByRole('textbox', { name: 'Without the app' })).toHaveValue(
      `claude mcp add --scope user dfyom -- ${BIN} mcp`,
    )
    expect(within(dialog).getByRole('textbox', { name: 'Command line' })).toHaveValue(BIN)
    expect(within(dialog).queryByText(/is off/)).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/Development build/)).not.toBeInTheDocument()
    await expectNoAxeViolations()

    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    await user.click(within(dialog).getByRole('button', { name: 'Copy: Work in this app' }))
    expect(write).toHaveBeenCalledWith(`claude mcp add --scope user dfyom -- ${BIN} mcp --connect`)
    expect(
      await within(dialog).findByRole('button', { name: 'Copy: Work in this app' }),
    ).toHaveTextContent('Copied')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Work in this app copied to the clipboard.',
    )
    write.mockRestore()
  })

  it('says when local agents are off and opens the settings', async () => {
    const bridge = createFakeBridge()
    bridge.setConnectInfo({
      connect: 'node /src/out/main/cli.js mcp --connect',
      headless: 'node /src/out/main/cli.js mcp',
      cli: 'node /src/out/main/cli.js',
      development: true,
      localAgents: false,
    })
    const { user, dialog } = await openDialog(bridge)
    expect(await within(dialog).findByText(/Development build/)).toBeInTheDocument()
    expect(within(dialog).getByText(/is off, so this line cannot connect yet/)).toBeInTheDocument()
    await expectNoAxeViolations()
    await user.click(within(dialog).getByRole('button', { name: 'Open settings' }))
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Connect an agent' })).not.toBeInTheDocument(),
    )
  })
})
