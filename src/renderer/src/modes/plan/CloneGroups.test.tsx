// Clone groups in the setup panel (hardening DF146 G2) against the fake bridge bound to a real
// project runtime: a countersunk bolt hole cloned three times plans as one row per source
// operation, "Bolt hole 1 · drill × 4"; its chevron (and → / ←) shows the instances by their
// stable number, read-only; choosing an instance selects its group, whose inspector edits all.
// DF146: a hovered, focused or chosen instance is drawn selected in the viewport (its position).
// Doc: docs/modes/features.md#clone-groups-in-plan-hardening-df146, docs/conventions/ui.md
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']}>{children}</div>
  ),
}))
vi.mock('../../viewport/ViewCube', () => ({ ViewCube: () => null }))
vi.mock('../../viewport/Measure3d', () => ({ Measure3d: () => null }))
// the scene records the surfaces drawn selected (DF146: the shown instance)
const scene = vi.hoisted(() => ({ selected: undefined as string | null | undefined }))
vi.mock('../../viewport/Scene', () => ({
  Scene: (p: { surfaceState: { selectedOperation: string | null } }) => {
    scene.selected = p.surfaceState.selectedOperation
    return null
  },
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

async function renderGroups() {
  const s = await planSetup({ part: false })
  await s.run('design.hole.add', {
    partId: s.partId,
    center: ['20', '20'],
    type: 'countersink',
    diameter: '6',
    csDiameter: '10',
    csAngle: '90',
  })
  await s.run('design.clones.add', {
    partId: s.partId,
    source: { featureId: 'hole1' },
    rows: [{ kind: 'offset', count: 3, du: '20', dv: '0' }],
  })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  bridge.handle('plan.toolpath.get', () => ({
    ok: true,
    value: { toolpath: null, stale: false },
    revision: 0,
  }))
  const shell = createShell(bridge)
  shell.ui.getState().setMode('plan')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const nav = () => screen.getByRole('navigation', { name: 'Navigator' })
  const ops = () => within(nav()).getByRole('list', { name: 'Plan operations in machining order' })
  await waitFor(() => expect(within(ops()).getAllByRole('button').length).toBeGreaterThan(0))
  const plan = () => s.plan(planId)
  return { ...r, s, nav, ops, plan }
}

describe('clone groups in the setup panel (DF146 G2)', () => {
  it('one row per source operation, expandable to its read-only instances', async () => {
    const t = await renderGroups()
    const drill = within(t.ops()).getByRole('button', { name: /^Bolt hole 1 · drill\s*× 4/ })
    expect(within(t.ops()).getByRole('button', { name: /^Bolt hole 1 · countersink\s*× 4/ }))
    expect(t.plan().setups[0]!.operations).toHaveLength(2)
    expect(drill).toHaveAttribute('aria-expanded', 'false')

    // the chevron opens it: the instances by number, 1 = the source
    await t.user.click(within(drill).getByTitle('Show the instances of Bolt hole 1 · drill × 4'))
    expect(drill).toHaveAttribute('aria-expanded', 'true')
    const list = within(t.nav()).getByRole('list', {
      name: 'Instances of Bolt hole 1 · drill × 4',
    })
    const instances = within(list).getAllByRole('button')
    expect(instances.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Instance 1 of Bolt hole 1 · drill',
      'Instance 2 of Bolt hole 1 · drill',
      'Instance 3 of Bolt hole 1 · drill',
      'Instance 4 of Bolt hole 1 · drill',
    ])
    expect(instances[2]).toHaveTextContent('Instance 3')
    // read-only: an instance has no settings of its own; choosing one selects its group
    await t.user.click(instances[2]!)
    expect(drill).toHaveAttribute('aria-pressed', 'true')
    await t.user.click(instances[1]!)
    expect(drill).toHaveAttribute('aria-pressed', 'true')
    await expectNoAxeViolations(t.container)

    // keys: ← closes, → opens, → again steps in, ↓ walks the instances, ← back to the group
    drill.focus()
    await t.user.keyboard('{ArrowLeft}')
    expect(drill).toHaveAttribute('aria-expanded', 'false')
    await t.user.keyboard('{ArrowRight}')
    expect(drill).toHaveAttribute('aria-expanded', 'true')
    await t.user.keyboard('{ArrowRight}')
    expect(instances[0]).toHaveFocus()
    await t.user.keyboard('{ArrowDown}')
    expect(instances[1]).toHaveFocus()
    await t.user.keyboard('{ArrowLeft}')
    expect(drill).toHaveFocus()
    // past the last instance ↓ reaches the next plan operation
    instances[3]!.focus()
    await t.user.keyboard('{ArrowDown}')
    expect(
      within(t.ops()).getByRole('button', { name: /^Bolt hole 1 · countersink\s*× 4/ }),
    ).toHaveFocus()
  })

  it('DF146: the hovered, focused or chosen instance is drawn selected in the viewport', async () => {
    const t = await renderGroups()
    const drill = within(t.ops()).getByRole('button', { name: /^Bolt hole 1 · drill\s*× 4/ })
    const ids = t
      .plan()
      .setups[0]!.operations.find((o) => o.designOperationIds.length === 4)!.designOperationIds
    await t.user.click(within(drill).getByTitle('Show the instances of Bolt hole 1 · drill × 4'))
    const list = within(t.nav()).getByRole('list', {
      name: 'Instances of Bolt hole 1 · drill × 4',
    })
    const instances = within(list).getAllByRole('button')
    expect(scene.selected).toBeNull()
    // hovered: its position shows; left: none
    await t.user.hover(instances[2]!)
    await waitFor(() => expect(scene.selected).toBe(ids[2]))
    await t.user.unhover(instances[2]!)
    await waitFor(() => expect(scene.selected).toBeNull())
    // chosen: shown while its group is selected, marked current; focus shows another
    await t.user.click(instances[1]!)
    expect(instances[1]).toHaveAttribute('aria-current', 'true')
    await t.user.unhover(instances[1]!)
    instances[1]!.blur()
    await waitFor(() => expect(scene.selected).toBe(ids[1]))
    instances[3]!.focus()
    await waitFor(() => expect(scene.selected).toBe(ids[3]))
    instances[3]!.blur()
    await waitFor(() => expect(scene.selected).toBe(ids[1]))
    await expectNoAxeViolations(t.container)
    // another row selected: the chosen instance is no longer shown
    await t.user.click(within(t.ops()).getByRole('button', { name: /^Bolt hole 1 · countersink/ }))
    await waitFor(() => expect(scene.selected).toBeNull())
    expect(instances[1]).not.toHaveAttribute('aria-current')
  })

  it('a single operation has no chevron', async () => {
    const t = await renderGroups()
    await t.s.run('design.feature.remove', { partId: t.s.partId, featureId: 'clones1' })
    await t.s.run('project.apply', {})
    await t.s.run('plan.rebuild', { planId: t.plan().id })
    await waitFor(() =>
      expect(
        within(t.ops()).getByRole('button', { name: /^Bolt hole 1 · drill(?!\s*×)/ }),
      ).not.toHaveAttribute('aria-expanded'),
    )
  })
})
