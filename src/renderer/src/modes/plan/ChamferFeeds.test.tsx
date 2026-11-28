// A chamfer's Feeds fields in the plan inspector are the ones core accepts (hardening DF142, user
// TG #490: a Stepdown field was offered and `plan.operation.update` refused it, `notForKind`).
// Against the fake bridge bound to a real project runtime: every field shown is entered and
// stored, and neither Stepdown nor Stepover shows.
// Doc: docs/modes/plan-v0.4.md#implementation-df142
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { opsOf, planSetup } from '../../../../core/plan/plan.fixture'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { renderUi } from '../../test/render'
import { openInspectorTab } from '../../test/inspector'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

const VALUES: Record<string, [string, string]> = {
  'Spindle speed': ['spindleSpeed', '16000'],
  'Feed rate': ['feedRate', '600'],
  'Plunge rate': ['plungeRate', '200'],
  Stepdown: ['stepdown', '0.3'],
  Stepover: ['stepover', '1'],
}

describe('Plan inspector: a chamfer’s feeds fields', () => {
  it('shows only fields core accepts, and each one is stored', async () => {
    const s = await planSetup({ part: false })
    await s.run('library.tool.add', {
      values: {
        name: '90 V-bit 1/4in',
        type: 'chamferMill',
        diameter: '1/4"',
        angle: '90',
        fluteLength: '10',
        overallLength: '50',
        fluteCount: '1',
      },
    })
    await s.run('design.hole.add', {
      partId: s.partId,
      center: ['30', '30'],
      fastener: 'M6',
      type: 'countersink',
      fit: 'close',
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const op = () =>
      opsOf(s.plan(planId)).find((o) => o.designOperationIds[0] === 'hole1_countersink')!
    const bridge = createFakeBridge()
    bridge.bind(s.d)
    const shell = createShell(bridge)
    shell.ui.getState().setMode('plan')
    const r = renderUi(
      <ShellProvider shell={shell}>
        <App />
      </ShellProvider>,
    )
    await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
    const nav = screen.getByRole('navigation', { name: 'Navigator' })
    const list = await within(nav).findByRole('list', {
      name: 'Plan operations in machining order',
    })
    const row = await waitFor(() => {
      const b = [...list.querySelectorAll(':scope > li > button')].find((e) =>
        /countersink/i.test(e.textContent ?? ''),
      )
      expect(b).toBeDefined()
      return b as HTMLElement
    })
    await r.user.click(row)
    const insp = screen.getByRole('complementary', { name: 'Inspector' })
    await openInspectorTab(r.user, insp, 'Feeds')
    const region = await within(insp).findByRole('region', { name: 'Feeds and speeds' })
    const g = within(region)
    expect(g.queryByLabelText('Stepdown', { selector: 'input' })).toBeNull()
    expect(g.queryByLabelText('Stepover', { selector: 'input' })).toBeNull()
    const shown = Object.keys(VALUES).filter(
      (label) => g.queryByLabelText(label, { selector: 'input' }) !== null,
    )
    expect(shown).toEqual(['Spindle speed', 'Feed rate', 'Plunge rate'])
    for (const label of shown) {
      const [key, value] = VALUES[label]!
      await r.user.type(g.getByLabelText(label, { selector: 'input' }), `${value}{Enter}`)
      await waitFor(() => expect(op().overrides).toHaveProperty(key))
    }
  })
})
