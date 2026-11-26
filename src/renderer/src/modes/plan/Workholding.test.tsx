// "Workholding" in the setup inspector (docs/modes/workholding.md#ui-summary) against the fake
// bridge bound to a real project runtime (core plan fixture, one Top setup): the empty note, the
// Add menu, an item's summary and fields (each change one `plan.workholding.set` with the whole
// list, ids kept), Remove, the clearance height that follows the items ("From Toe clamp 1 +
// 2 mm.") and back to following them, and the plan scene's solids and keep-out halo; X2-6: a toe
// clamp dragged in the scene (snapped, one set on release) and nudged by the arrow keys.
// Doc: docs/conventions/ui.md#workholding, docs/modes/workholding.md#toe-clamp-drag-x2-6
import { act, screen, waitFor, within } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { planSetup, type PlanSetup } from '../../../../core/plan/plan.fixture'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import type { RunScene } from '../../viewport'
import { usePlanScene } from './usePlanScene'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

const probe: { scene: RunScene | null } = { scene: null }
function SceneProbe(): null {
  const scene = usePlanScene('plan')
  useEffect(() => {
    probe.scene = scene
  }, [scene])
  return null
}

async function renderInspector(setup?: (s: PlanSetup, planId: string) => Promise<void>) {
  const s = await planSetup()
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  await setup?.(s, planId)
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  const shell = createShell(bridge)
  shell.ui.getState().setMode('plan')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
      <SceneProbe />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const nav = screen.getByRole('navigation', { name: 'Navigator' })
  const list = within(nav).getByRole('list', { name: 'Setups in machining order' })
  await waitFor(() => expect(list.querySelector(':scope > li > div > button')).not.toBeNull())
  await r.user.click(list.querySelector(':scope > li > div > button') as HTMLElement)
  const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
  await within(inspector()).findByRole('heading', { name: 'Setup' })
  const section = () =>
    within(inspector()).getByRole('region', { name: /^Workholding/ }) as HTMLElement
  const callsOf = (name: string) => bridge.calls.filter((c) => c.name === name).map((c) => c.args)
  const setupId = s.plan(planId).setups[0]!.id
  return { ...r, s, planId, setupId, inspector, section, callsOf }
}

const clamp = { kind: 'toeClamp', edge: 'vMin', at: '30', top: '20' }

describe('Workholding in the setup inspector', () => {
  it('says nothing holds the stock, and adds a toe clamp from the Add menu, opened', async () => {
    const t = await renderInspector()
    expect(
      within(t.section()).getByText(
        'Nothing holds the stock yet: rapids and cuts are not checked against clamps.',
      ),
    ).toBeInTheDocument()
    expect(within(t.section()).getByText('None')).toBeInTheDocument()
    await expectNoAxeViolations()
    const add = within(t.section()).getByRole('button', { name: 'Add' })
    add.focus()
    await t.user.keyboard('{Enter}')
    await t.user.click(await screen.findByRole('menuitem', { name: /^Toe clamp/ }))
    await waitFor(() =>
      expect(t.callsOf('plan.workholding.set')).toEqual([
        { planId: t.planId, setupId: t.setupId, items: [{ kind: 'toeClamp', edge: 'vMin' }] },
      ]),
    )
    // the new item is listed with its summary and open
    const row = await within(t.section()).findByRole('button', { name: /^Toe clamp 1/ })
    expect(row).toHaveTextContent('front X50 grip 10 top Z25')
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(within(t.section()).getByText('1 item')).toBeInTheDocument()
    const fields = within(t.section()).getByRole('group', { name: 'Item Toe clamp 1' })
    expect(within(fields).getByLabelText('Top above Z0', { selector: 'input' })).toHaveValue(
      '25 mm',
    )
    // the keep-out halo of the open item in the viewport
    await waitFor(() => expect(probe.scene?.workholding?.halo?.z).toBe(27))
    expect(probe.scene?.workholding?.solids.map((x) => x.itemId)).toEqual(['wh1', 'wh1'])
    await expectNoAxeViolations()
  })

  it('keeps Margin in a closed More row after the buttons (design review R10)', async () => {
    const t = await renderInspector(async (s, planId) => {
      const setupId = s.plan(planId).setups[0]!.id
      await s.run('plan.workholding.set', { planId, setupId, items: [clamp] })
    })
    const more = within(t.section()).getByRole('button', { name: 'More (Margin)' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    const arrange = within(t.section()).getByRole('button', { name: /Arrange automatically/ })
    expect(arrange.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(t.section()).queryByRole('textbox', { name: 'Margin' })).toBeNull()
    await t.user.click(more)
    const margin = within(t.section()).getByLabelText('Margin', { selector: 'input' })
    expect(margin).toBeVisible()
    await t.user.clear(margin)
    await t.user.type(margin, '4{Enter}')
    await waitFor(() =>
      expect(t.callsOf('plan.workholding.set').at(-1)).toMatchObject({ margin: '4' }),
    )
  })

  it('edits an item by id, the clearance follows it, Remove takes it out', async () => {
    const t = await renderInspector(async (s, planId) => {
      const setupId = s.plan(planId).setups[0]!.id
      await s.run('plan.workholding.set', { planId, setupId, items: [clamp] })
    })
    const clearance = () =>
      within(t.inspector()).getByLabelText('Clearance height', { selector: 'input' })
    // 20 mm + the 2 mm margin, from the clamp
    expect(clearance()).toHaveValue('22 mm')
    expect(clearance()).toHaveAccessibleDescription('From Toe clamp 1 + 2 mm.')
    await t.user.click(within(t.section()).getByRole('button', { name: /^Toe clamp 1/ }))
    const top = within(t.section()).getByLabelText('Top above Z0', { selector: 'input' })
    await t.user.clear(top)
    await t.user.type(top, '30{Enter}')
    await waitFor(() =>
      expect(t.callsOf('plan.workholding.set').at(-1)).toEqual({
        planId: t.planId,
        setupId: t.setupId,
        items: [{ id: 'wh1', kind: 'toeClamp', top: '30' }],
      }),
    )
    await waitFor(() => expect(clearance()).toHaveValue('32 mm'))
    await expectNoAxeViolations()
    // a height set by the user stays, and can follow the workholding again
    await t.user.clear(clearance())
    await t.user.type(clearance(), '40{Enter}')
    const follow = await within(t.inspector()).findByRole('button', {
      name: 'Follow the workholding',
    })
    await t.user.click(follow)
    await waitFor(() =>
      expect(t.callsOf('plan.setup.update').at(-1)).toMatchObject({ clearanceHeight: 'auto' }),
    )
    await waitFor(() => expect(clearance()).toHaveValue('32 mm'))
    await t.user.click(within(t.section()).getByRole('button', { name: 'Remove Toe clamp 1' }))
    await waitFor(() =>
      expect(t.callsOf('plan.workholding.set').at(-1)).toMatchObject({ items: [] }),
    )
    expect(
      await within(t.section()).findByText(
        'Nothing holds the stock yet: rapids and cuts are not checked against clamps.',
      ),
    ).toBeInTheDocument()
  })

  it('copies another setup’s workholding with "Copy from…" (X2-5, the agent’s copyFrom)', async () => {
    let other = ''
    const t = await renderInspector(async (s, planId) => {
      const top = s.plan(planId).setups[0]!
      other = (
        (await s.run('plan.setup.split', {
          planId,
          setupId: top.id,
          planOperationIds: [top.operations.at(-1)!.id],
        })) as { setupId: string }
      ).setupId
      await s.run('plan.workholding.set', { planId, setupId: other, items: [clamp] })
    })
    const name = t.s.plan(t.planId).setups.find((x) => x.id === other)!.name
    await t.user.click(within(t.section()).getByRole('button', { name: 'Copy from…' }))
    const entry = await screen.findByRole('menuitem', { name: new RegExp(`^${name}`) })
    expect(entry).toHaveTextContent('1 item')
    await t.user.click(entry)
    await waitFor(() =>
      expect(t.callsOf('plan.workholding.set').at(-1)).toEqual({
        planId: t.planId,
        setupId: t.setupId,
        copyFrom: other,
      }),
    )
    const row = await within(t.section()).findByRole('button', { name: /^Toe clamp 1/ })
    expect(row).toHaveTextContent('front X30 grip 10 top Z20')
    await expectNoAxeViolations()
  })

  it('drags a toe clamp along its edge in the plan scene: snapped, one set on release (X2-6)', async () => {
    const t = await renderInspector(async (s, planId) => {
      const setupId = s.plan(planId).setups[0]!.id
      await s.run('plan.workholding.set', { planId, setupId, items: [clamp] })
    })
    await waitFor(() => expect(probe.scene?.workholding?.clamps?.handles).toHaveLength(1))
    const drag = () => probe.scene!.workholding!.clamps!
    const h = drag().handles[0]!
    // the front edge of the 100 mm stock: along X, anchored on the grip's top centre
    expect(h).toMatchObject({ itemId: 'wh1', axis: 0, at: 30, anchor: [30, 5, 20] })
    expect(h.label).toBe('Toe clamp 1, front X30: drag along the edge, or use the arrow keys')
    act(() => drag().onDrag('start', 'wh1', 30))
    act(() => drag().onDrag('move', 'wh1', 48.2))
    // held: the midpoint snaps (50), the solids follow before anything is sent
    await waitFor(() => expect(probe.scene?.workholding?.clamps?.handles[0]?.at).toBe(50))
    expect(probe.scene?.workholding?.clamps?.handles[0]?.dragging).toBe(true)
    const minX = Math.min(...probe.scene!.workholding!.solids[0]!.outline.map((p) => p[0]))
    expect(minX).toBeCloseTo(35)
    expect(t.callsOf('plan.workholding.set')).toHaveLength(0)
    act(() => drag().onDrag('end', 'wh1', 61.4))
    await waitFor(() => expect(t.callsOf('plan.workholding.set')).toHaveLength(1))
    expect(t.callsOf('plan.workholding.set')[0]).toMatchObject({
      items: [{ id: 'wh1', kind: 'toeClamp', at: '61 mm' }],
    })
    const row = () => within(t.section()).getByRole('button', { name: /^Toe clamp 1/ })
    await waitFor(() => expect(row()).toHaveTextContent('front X61'))
    // the arrow keys: 1 mm (Shift 10 mm), one set each
    act(() => drag().onNudge('wh1', 10))
    await waitFor(() => expect(t.callsOf('plan.workholding.set')).toHaveLength(2))
    expect(t.callsOf('plan.workholding.set')[1]).toMatchObject({
      items: [{ id: 'wh1', kind: 'toeClamp', at: '71 mm' }],
    })
    // a press without moving opens the item
    act(() => drag().onSelect('wh1'))
    const fields = await within(t.section()).findByRole('group', { name: 'Item Toe clamp 1' })
    expect(fields).toBeVisible()
  })
})
