// The setup panel (v0.2 task F6) against the fake bridge bound to a real project runtime (core
// plan fixture plus a facing on the bottom: setups Bottom, Top): setup rows with direction, WCS
// corner and rotation, operations nested per setup, reorder by buttons and Alt+↑/↓, split and
// merge (same direction only), moving an operation across setups, the setup inspector (name,
// rotation, heights), the per-setup export and the per-setup preview placed by the setup's WCS.
// Doc: docs/conventions/ui.md#design-and-plan-controls-v02, docs/modes/plan-v0.2.md#merge-split-reorder
import { screen, waitFor, within } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { planSetup, type PlanSetup } from '../../../../core/plan/plan.fixture'
import { setupFrame } from '../../../../core/toolpath/wcs'
import type { CallReply } from '../../../../shared/preload-api'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import type { RunScene } from '../../viewport'
import { planStockSize } from './model'
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

const ok = (value: unknown = {}): CallReply => ({ ok: true, value, revision: 0 })

/** The plan scene as the viewport gets it. */
const probe: { scene: RunScene | null } = { scene: null }
function SceneProbe(): null {
  const scene = usePlanScene('plan')
  useEffect(() => {
    probe.scene = scene
  }, [scene])
  return null
}

const toolpath = {
  planOperationId: 'x',
  tool: 't',
  spindleSpeed: 1000,
  passes: [
    {
      kind: 'rough',
      moves: [
        { kind: 'rapid', to: [0, 0, 5] },
        { kind: 'line', to: [10, 0, -1], feed: 100 },
      ],
    },
  ],
  stats: { cutLength: 1, rapidLength: 0, estimatedSeconds: 1 },
}

async function renderSetups(setup?: (s: PlanSetup, planId: string) => Promise<void>) {
  const s = await planSetup()
  await s.run('design.facing.add', { partId: s.partId, on: 'stock.bottom', depth: '0.5' })
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  await setup?.(s, planId)
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  bridge.handle('plan.toolpath.get', () => ok({ toolpath, stale: false }))
  const shell = createShell(bridge)
  shell.ui.getState().setMode('plan')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
      <SceneProbe />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const nav = () => screen.getByRole('navigation', { name: 'Navigator' })
  const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
  const callsOf = (name: string) => bridge.calls.filter((c) => c.name === name).map((c) => c.args)
  const plan = () => s.plan(planId)
  const setupList = () => within(nav()).getByRole('list', { name: 'Setups in machining order' })
  /** The setup rows' buttons, in order. */
  const setupRows = () =>
    [...setupList().querySelectorAll(':scope > li > div > button')] as HTMLElement[]
  const opsOf = (name: string) =>
    within(nav()).getByRole('list', { name: `Plan operations of ${name} in machining order` })
  await waitFor(() => expect(setupRows().length).toBe(plan().setups.length))
  return { ...r, s, bridge, nav, inspector, callsOf, plan, planId, setupRows, opsOf }
}

/** Radix menus open from the keyboard in jsdom (as Design.test.tsx). */
async function openMenu(
  t: { user: { keyboard: (k: string) => Promise<void> } },
  trigger: HTMLElement,
) {
  trigger.focus()
  await t.user.keyboard('{Enter}')
}

describe('Setup panel', { timeout: 20_000 }, () => {
  it('lists the setups in machining order with direction, WCS corner and rotation, operations nested', async () => {
    const t = await renderSetups()
    const [bottom, top] = t.setupRows()
    expect(bottom).toHaveTextContent('1. Bottom')
    expect(bottom).toHaveTextContent('Bottom · G54 back left · 0°')
    expect(top).toHaveTextContent('2. Top')
    expect(top).toHaveTextContent('Top · G54 front left · 0°')
    // the bottom facing under Bottom, the top operations under Top
    const bottomOps = within(t.opsOf('Bottom')).getAllByRole('button', { name: /^Facing/ })
    expect(bottomOps).toHaveLength(1)
    expect(within(t.opsOf('Top')).getAllByRole('button', { name: /^Profile/ })).toHaveLength(1)
    // the first setup is the one shown and exported
    expect(bottom).toHaveTextContent('Shown in the viewport and exported')
    // only a setup's own errors block its program: the top's drills have no feeds yet
    const exportBottom = within(t.nav()).getByRole('button', { name: 'Export Bottom gCode…' })
    await waitFor(() =>
      expect(within(t.nav()).getAllByText(/^\d+ errors?$/).length).toBeGreaterThan(0),
    )
    expect(exportBottom).toBeEnabled()
    await t.user.click(t.setupRows()[1]!)
    expect(within(t.nav()).getByRole('button', { name: 'Export Top gCode…' })).toBeDisabled()
    expect(within(t.nav()).getByText('Fix the errors before exporting.')).toBeInTheDocument()
    await expectNoAxeViolations()
  })

  it('reorders setups from their menu and with Alt+↑/↓; ↑/↓ move the focus over every row', async () => {
    const t = await renderSetups()
    const [bottom, top] = t.plan().setups
    // the row's only action button is its menu: nothing overlays the name or the subtitle
    expect(within(t.nav()).queryByRole('button', { name: /^Move setup/ })).toBeNull()
    await openMenu(t, within(t.nav()).getByRole('button', { name: 'Actions for setup Bottom' }))
    expect(await screen.findByRole('menuitem', { name: /^Move up/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await t.user.click(await screen.findByRole('menuitem', { name: /^Move down/ }))
    await waitFor(() => expect(t.plan().setups.map((s) => s.name)).toEqual(['Top', 'Bottom']))
    expect(t.callsOf('plan.setup.move')).toEqual([
      { planId: t.planId, setupId: bottom!.id, toIndex: 1 },
    ])
    // Alt+↑ on Bottom (now second) moves it back to first
    const row = t.setupRows()[1]!
    row.focus()
    await t.user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    await waitFor(() => expect(t.plan().setups.map((s) => s.name)).toEqual(['Bottom', 'Top']))
    // ↑/↓ walk setups and operations in the order shown
    t.setupRows()[0]!.focus()
    await t.user.keyboard('{ArrowDown}')
    expect(document.activeElement).toHaveAccessibleName(/^Facing/)
    await t.user.keyboard('{ArrowDown}')
    expect(document.activeElement).toHaveTextContent('2. Top')
    expect(top).toBeDefined()
  })

  it('splits an operation into a new setup, moves operations across setups of one direction and merges them', async () => {
    const t = await renderSetups()
    const top = t.plan().setups[1]!
    const last = top.operations.at(-1)!
    const lastName = within(t.opsOf('Top')).getAllByRole('button', { name: /^Profile/ })[0]!
    // the last operation of Top into a new setup right after it
    await openMenu(t, within(t.opsOf('Top')).getByRole('button', { name: /^Actions for Profile/ }))
    expect(screen.queryByRole('menuitem', { name: 'Move to Bottom' })).toBeNull()
    await t.user.click(await screen.findByRole('menuitem', { name: 'Move to new setup' }))
    await waitFor(() =>
      expect(t.plan().setups.map((s) => s.name)).toEqual(['Bottom', 'Top', 'Top 2']),
    )
    expect(t.callsOf('plan.setup.split')).toEqual([
      { planId: t.planId, setupId: top.id, planOperationIds: [last.id] },
    ])
    expect(lastName).toBeDefined()
    // Alt+↑ on the only operation of Top 2 moves it back to the end of Top (Top 2 goes away)
    const moved = within(t.opsOf('Top 2')).getByRole('button', { name: /^Profile/ })
    moved.focus()
    await t.user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    await waitFor(() => expect(t.plan().setups.map((s) => s.name)).toEqual(['Bottom', 'Top']))
    expect(t.callsOf('plan.operation.move').at(-1)).toEqual({
      planId: t.planId,
      planOperationId: last.id,
      toSetupId: top.id,
      toIndex: top.operations.length - 1,
    })
    // split again, then merge from the setup's menu (Bottom offers no merge)
    await openMenu(t, within(t.opsOf('Top')).getByRole('button', { name: /^Actions for Profile/ }))
    await t.user.click(await screen.findByRole('menuitem', { name: 'Move to new setup' }))
    await waitFor(() => expect(t.plan().setups).toHaveLength(3))
    const top2 = t.plan().setups[2]!
    await openMenu(t, within(t.nav()).getByRole('button', { name: 'Actions for setup Bottom' }))
    expect(
      await screen.findByRole('menuitem', { name: 'No other setup of this face to merge with' }),
    ).toHaveAttribute('aria-disabled', 'true')
    await t.user.keyboard('{Escape}')
    await openMenu(t, within(t.nav()).getByRole('button', { name: 'Actions for setup Top' }))
    await t.user.click(await screen.findByRole('menuitem', { name: 'Merge with Top 2' }))
    await waitFor(() => expect(t.plan().setups.map((s) => s.name)).toEqual(['Bottom', 'Top']))
    expect(t.callsOf('plan.setup.merge')).toEqual([
      { planId: t.planId, setupIds: [top.id, top2.id] },
    ])
    // a split that would break the machining order is refused, with the reason
    await openMenu(t, within(t.opsOf('Top')).getByRole('button', { name: /^Actions for Facing/ }))
    await t.user.click(await screen.findByRole('menuitem', { name: 'Move to new setup' }))
    expect(await within(t.nav()).findByText('The change was not applied.')).toBeInTheDocument()
    expect(t.plan().setups).toHaveLength(2)
  })

  it('edits the selected setup in the inspector: name, rotation, heights', async () => {
    const t = await renderSetups()
    const bottom = t.plan().setups[0]!
    await t.user.click(t.setupRows()[0]!)
    const insp = t.inspector()
    await within(insp).findByRole('heading', { name: 'Setup' })
    expect(within(insp).getByText('1 of 2')).toBeInTheDocument()
    expect(within(insp).getByText('Bottom face up to the spindle')).toBeInTheDocument()
    expect(within(insp).getByText(/G54 at the back left corner of the bottom/)).toBeInTheDocument()
    await t.user.click(within(insp).getByRole('radio', { name: '90°' }))
    await waitFor(() => expect(t.plan().setups[0]!.rotation).toBe(90))
    expect(t.callsOf('plan.setup.update')).toContainEqual({
      planId: t.planId,
      setupId: bottom.id,
      rotation: 90,
    })
    await waitFor(() => expect(t.setupRows()[0]).toHaveTextContent('· 90°'))
    const name = within(insp).getByLabelText('Setup name', { selector: 'input' })
    await t.user.clear(name)
    await t.user.type(name, 'Datum{Enter}')
    await waitFor(() => expect(t.plan().setups[0]!.name).toBe('Datum'))
    const clearance = within(insp).getByLabelText('Clearance height', { selector: 'input' })
    await t.user.clear(clearance)
    await t.user.type(clearance, '12{Enter}')
    await waitFor(() =>
      expect(t.callsOf('plan.setup.update')).toContainEqual({
        planId: t.planId,
        setupId: bottom.id,
        clearanceHeight: '12',
      }),
    )
    await expectNoAxeViolations()
  })

  it('exports the window’s setup and previews only its toolpaths, placed by its WCS', async () => {
    // drill feeds entered, so the top setup has no errors (as Plan.test.tsx)
    const t = await renderSetups(async (s, planId) => {
      const plan = s.plan(planId)
      for (const op of plan.setups.flatMap((x) => x.operations))
        if (plan.snapshots.find((x) => x.id === op.tool)?.values['name'] === 'Drill 6')
          await s.run('plan.operation.update', {
            planId,
            planOperationId: op.id,
            overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
          })
    })
    const [bottom, top] = t.plan().setups
    const stock = planStockSize(t.s.d.doc, t.plan())!
    // the first setup by default: its one operation, through the bottom's frame
    await waitFor(() => expect(probe.scene?.lines?.segments).toBe(1))
    expect(probe.scene?.frame).toEqual(setupFrame('-z', 0, stock))

    // choosing Top previews and exports Top (and stays after the selection is cleared)
    await t.user.click(t.setupRows()[1]!)
    await t.user.click(t.setupRows()[1]!)
    await waitFor(() => expect(probe.scene?.lines?.segments).toBe(2 * top!.operations.length - 1))
    expect(probe.scene?.frame).toEqual(setupFrame('+z', 0, stock))
    t.bridge.setFileChoice({ export: '/out/Plan 1 Top.nc' })
    t.bridge.handle('plan.export', () =>
      ok({
        filePath: '/out/Plan 1 Top.nc',
        setupId: top!.id,
        lines: 120,
        stats: { estimatedSeconds: 60, toolChanges: 1 },
        warnings: [],
        softLimitChecked: false,
        regenerated: [],
      }),
    )
    const exportTop = within(t.nav()).getByRole('button', { name: 'Export Top gCode…' })
    await waitFor(() => expect(exportTop).toBeEnabled())
    await t.user.click(exportTop)
    const dialog = await screen.findByRole('dialog', { name: 'gCode exported' })
    expect(within(dialog).getByText('Setup Top (2 of 2)')).toBeInTheDocument()
    expect(t.bridge.exportDialogNames).toEqual(['Plan 1 Top'])
    expect(t.callsOf('plan.export')).toEqual([
      { planId: t.planId, setupId: top!.id, target: '/out/Plan 1 Top.nc', confirm: true },
    ])
    expect(bottom).toBeDefined()
  })
})
