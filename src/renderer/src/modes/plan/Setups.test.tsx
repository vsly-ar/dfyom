// The setup panel (v0.2 task F6) against the fake bridge bound to a real project runtime (core
// plan fixture plus a facing on the bottom: setups Bottom, Top): setup rows with direction, WCS
// corner and rotation, operations nested per setup, reorder from the row menus and Alt+↑/↓, split and
// merge (same direction only), moving an operation across setups, the setup inspector (name,
// rotation, heights), the per-setup export and the per-setup preview placed by the setup's WCS.
// Doc: docs/conventions/ui.md#design-and-plan-controls-v02, docs/modes/plan-v0.2.md#merge-split-reorder
import { screen, waitFor, within } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { libraryInput, machineValues } from '../../../../core/library/library.fixture'
import { planSetup, type PlanSetup } from '../../../../core/plan/plan.fixture'
import { setupFrame } from '../../../../core/toolpath/wcs'
import type { CallReply } from '../../../../shared/preload-api'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { dragTo, gripOf, layOutRows } from '../../test/reorder'
import type { PlanOperationDTO } from '../../../../core/plan/plan.dto'
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

async function renderSetups(
  setup?: (s: PlanSetup, planId: string) => Promise<void>,
  /** Extra machine values (library command input) for the plan's machine, e.g. DF68's. */
  machineExtra?: object,
) {
  const s = await planSetup()
  await s.run('design.facing.add', { partId: s.partId, on: 'stock.bottom', depth: '0.5' })
  const machineId =
    machineExtra === undefined
      ? s.machineId
      : (
          (await s.run('library.machine.add', {
            values: { ...libraryInput(machineValues()), ...machineExtra },
          })) as { id: string }
        ).id
  const planId = await s.create({ machineLibraryItemId: machineId })
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
/** Opens a row's context menu from the keyboard (Shift+F10 on the focused row, DF67). */
async function openMenu(t: { user: { keyboard: (k: string) => Promise<void> } }, row: HTMLElement) {
  row.focus()
  await t.user.keyboard('{Shift>}{F10}{/Shift}')
}

describe('Setup panel', () => {
  it('lists the setups in machining order with direction, WCS corner and rotation, operations nested', async () => {
    const t = await renderSetups()
    const [bottom, top] = t.setupRows()
    expect(bottom).toHaveTextContent('1. Bottom')
    expect(bottom).toHaveTextContent('G54 back left · 0°')
    // the name already says the face, so the subtitle leaves it out
    expect(bottom).not.toHaveTextContent('Bottom · G54')
    expect(top).toHaveTextContent('2. Top')
    expect(top).toHaveTextContent('G54 front left · 0°')
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
    await openMenu(t, within(t.nav()).getByRole('button', { name: /^\d\. Bottom/ }))
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

  it('reorders setups and plan operations within a setup by their grip (U3)', async () => {
    const t = await renderSetups()
    const [bottom] = t.plan().setups
    const top = t.plan().setups[1]!
    const [facing, drilling1, drilling34] = top.operations as [
      PlanOperationDTO,
      PlanOperationDTO,
      PlanOperationDTO,
    ]
    const restore = layOutRows()
    try {
      // Bottom (setup 1) dragged below Top
      dragTo(gripOf(t.setupRows()[0]!), 75)
      await waitFor(() => expect(t.plan().setups.map((s) => s.name)).toEqual(['Top', 'Bottom']))
      expect(t.callsOf('plan.setup.move')).toEqual([
        { planId: t.planId, setupId: bottom!.id, toIndex: 1 },
      ])
      expect(await screen.findByText('Moved Bottom to position 2 of 2.')).toBeInTheDocument()
      // Drilling 1 (second in Top) dragged below Drilling 3, Drilling 4
      const row = within(t.opsOf('Top')).getAllByRole('button', { name: /^Drilling/ })[0]!
      dragTo(gripOf(row), 90)
      await waitFor(() =>
        expect(
          t
            .plan()
            .setups[0]!.operations.map((o) => o.id)
            .slice(0, 3),
        ).toEqual([facing.id, drilling34.id, drilling1.id]),
      )
      expect(t.callsOf('plan.operation.move').at(-1)).toEqual({
        planId: t.planId,
        planOperationId: drilling1.id,
        toIndex: 2,
      })
    } finally {
      restore()
    }
    await expectNoAxeViolations(t.nav())
  })

  it('moves an operation from its context menu: right-click or Shift+F10 (DF67)', async () => {
    const t = await renderSetups()
    const top = t.plan().setups[1]!
    const [facing, drilling1, drilling34] = top.operations as [
      PlanOperationDTO,
      PlanOperationDTO,
      PlanOperationDTO,
    ]
    // nothing overlays the name or the status icons: no separate move buttons
    expect(within(t.nav()).queryByRole('button', { name: /^Move / })).toBeNull()
    // no action button on the row: its menu is the context menu (DF67)
    expect(within(t.nav()).queryByRole('button', { name: /^Actions for / })).toBeNull()
    const triggers = () => [...t.opsOf('Top').querySelectorAll<HTMLElement>(':scope > li > button')]
    // the row says how to open its menu (DF70)
    expect(triggers()[0]).toHaveAccessibleDescription('Right-click or Shift+F10 for actions.')
    expect(triggers()[0]).toHaveAttribute(
      'aria-keyshortcuts',
      'Alt+ArrowUp Alt+ArrowDown Shift+F10',
    )
    // the first operation of Top cannot go up (Bottom faces another way)
    await openMenu(t, triggers()[0]!)
    expect(await screen.findByRole('menuitem', { name: /^Move up/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await t.user.keyboard('{Escape}')
    // Drilling 1 down past Drilling 3, Drilling 4, from a right-click
    await t.user.pointer({ keys: '[MouseRight]', target: triggers()[1]! })
    await t.user.click(await screen.findByRole('menuitem', { name: /^Move down/ }))
    await waitFor(() =>
      expect(
        t
          .plan()
          .setups[1]!.operations.map((o) => o.id)
          .slice(0, 3),
      ).toEqual([facing.id, drilling34.id, drilling1.id]),
    )
    expect(t.callsOf('plan.operation.move').at(-1)).toMatchObject({
      planId: t.planId,
      planOperationId: drilling1.id,
    })
  })

  it('splits an operation into a new setup, moves operations across setups of one direction and merges them', async () => {
    const t = await renderSetups()
    const top = t.plan().setups[1]!
    const last = top.operations.at(-1)!
    const lastName = within(t.opsOf('Top')).getAllByRole('button', { name: /^Profile/ })[0]!
    // the last operation of Top into a new setup right after it
    await openMenu(t, within(t.opsOf('Top')).getAllByRole('button', { name: /^Profile/ })[0]!)
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
    await openMenu(t, within(t.opsOf('Top')).getAllByRole('button', { name: /^Profile/ })[0]!)
    await t.user.click(await screen.findByRole('menuitem', { name: 'Move to new setup' }))
    await waitFor(() => expect(t.plan().setups).toHaveLength(3))
    const top2 = t.plan().setups[2]!
    await openMenu(t, within(t.nav()).getByRole('button', { name: /^\d\. Bottom/ }))
    expect(
      await screen.findByRole('menuitem', { name: 'No other setup of this face to merge with' }),
    ).toHaveAttribute('aria-disabled', 'true')
    await t.user.keyboard('{Escape}')
    await openMenu(t, within(t.nav()).getByRole('button', { name: /^\d\. Top(?! 2)/ }))
    await t.user.click(await screen.findByRole('menuitem', { name: 'Merge with Top 2' }))
    await waitFor(() => expect(t.plan().setups.map((s) => s.name)).toEqual(['Bottom', 'Top']))
    expect(t.callsOf('plan.setup.merge')).toEqual([
      { planId: t.planId, setupIds: [top.id, top2.id] },
    ])
    // a split that would break the machining order is refused, with the reason
    await openMenu(t, within(t.opsOf('Top')).getAllByRole('button', { name: /^Facing/ })[0]!)
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
    // DF45: a labelled field, its hint in the support area describes the choice
    expect(within(insp).getByText('Rotation on the table', { selector: 'label' })).toBeVisible()
    expect(
      within(insp).getByRole('radiogroup', { name: 'Rotation on the table' }),
    ).toHaveAccessibleDescription(
      'About the spindle axis; the work zero keeps its offset from the new front-left corner.',
    )
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

  // DF59: docs/modes/plan-v0.2.md#tool-reach-past-the-stock-and-clamps-hardening-df59-interim
  it('shows how far the tool reaches past the stock and keeps clamps below the clearance', async () => {
    const t = await renderSetups()
    await t.user.click(t.setupRows()[0]!)
    const insp = t.inspector()
    await within(insp).findByRole('heading', { name: 'Setup' })
    // toolpaths without a reach (outdated or none): not known yet
    expect(within(insp).getByText('Past the stock')).toBeInTheDocument()
    expect(
      within(insp).getByText('Generate toolpaths to see where the tool leaves the stock.'),
    ).toBeInTheDocument()
    expect(
      within(insp).getByLabelText('Clearance height', { selector: 'input' }),
    ).toHaveAccessibleDescription(
      'Keep clamps lower than 10 mm above the stock top, or add them under Workholding.',
    )
    await expectNoAxeViolations()
  })

  // DF68: docs/architecture/grbl.md#z-headroom-hardening-df68
  it('shows the Z headroom: what to enter, too little for a tool, or enough', async () => {
    const headroom = async (t: Awaited<ReturnType<typeof renderSetups>>) => {
      await t.user.click(t.setupRows()[0]!)
      const insp = t.inspector()
      await within(insp).findByRole('heading', { name: 'Setup' })
      expect(within(insp).getByText('Z headroom')).toBeInTheDocument()
      return insp
    }
    const plain = await headroom(await renderSetups())
    expect(
      within(plain).getByText(
        'Not checked: enter the spindle nose to table distance and the spoilboard thickness (0 if none) in the machine.',
      ),
    ).toBeInTheDocument()
    await expectNoAxeViolations()
  })

  it('names the tool that hits the Z+ limit in the setup checks (DF68)', async () => {
    const t = await renderSetups(undefined, { noseToTable: '40', spoilboardThickness: '5' })
    await t.user.click(t.setupRows()[0]!)
    const insp = t.inspector()
    expect(
      await within(insp).findByText('Too little for a tool: see the setup checks.'),
    ).toBeInTheDocument()
    const checks = within(insp).getByRole('region', { name: 'Setup checks' })
    expect(
      within(checks).getAllByText(/would hit the Z\+ limit: lower the clearance height/).length,
    ).toBeGreaterThan(0)
    await expectNoAxeViolations()
  })

  it('says the Z headroom is enough on a machine with room (DF68)', async () => {
    const t = await renderSetups(undefined, { noseToTable: '120', spoilboardThickness: '5' })
    await t.user.click(t.setupRows()[0]!)
    const insp = t.inspector()
    expect(
      await within(insp).findByText('Enough above the clearance height for every tool.'),
    ).toBeInTheDocument()
  })

  it('names the sides the tool reaches past, rounded up, once every toolpath is current', async () => {
    const t = await renderSetups()
    t.bridge.handle('plan.toolpath.get', () =>
      ok({
        toolpath,
        stale: false,
        overreach: { xMin: 4.2426, xMax: 4.2426, yMin: 0, yMax: 0 },
      }),
    )
    // a revision re-reads the toolpaths
    await t.user.click(t.setupRows()[0]!)
    const insp = t.inspector()
    const name = await within(insp).findByLabelText('Setup name', { selector: 'input' })
    await t.user.clear(name)
    await t.user.type(name, 'Datum{Enter}')
    expect(
      await within(insp).findByText('Left 4.3 mm, right 4.3 mm; keep clamps clear of these sides.'),
    ).toBeInTheDocument()
    t.bridge.handle('plan.toolpath.get', () =>
      ok({ toolpath, stale: false, overreach: { xMin: 0, xMax: 0, yMin: 0, yMax: 0 } }),
    )
    await t.user.clear(name)
    await t.user.type(name, 'Bottom{Enter}')
    expect(
      await within(insp).findByText('The tool stays within the stock outline.'),
    ).toBeInTheDocument()
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
    expect(t.bridge.exportDialogNames).toEqual(['bracket-s2']) // project slug + setup number (DF62)
    expect(t.callsOf('plan.export')).toEqual([
      { planId: t.planId, setupId: top!.id, target: '/out/Plan 1 Top.nc', confirm: true },
    ])
    expect(bottom).toBeDefined()
  })
})

// DF78: docs/modes/alignment.md#plan-ui
describe('Setup work zero and alignment points', () => {
  it('moves the zero (negative too), adds a point, zeroes on it and resets to the corner', async () => {
    const t = await renderSetups()
    const top = t.plan().setups[1]!
    const stock = planStockSize(t.s.d.doc, t.plan())!
    await t.user.click(t.setupRows()[1]!)
    const insp = t.inspector()
    await within(insp).findByRole('heading', { name: 'Work zero' })
    expect(within(insp).getByRole('button', { name: 'Reset to corner' })).toBeDisabled()
    expect(within(insp).getByText(/^None\. After zeroing/)).toBeInTheDocument()

    // X −20: the zero lies left of the stock
    const x = within(insp).getByLabelText('Work zero X', { selector: 'input' })
    await t.user.clear(x)
    await t.user.type(x, '-20{Enter}')
    await waitFor(() => expect(t.plan().setups[1]!.zero).toEqual({ at: [-20, 0] }))
    expect(t.callsOf('plan.setup.update')).toContainEqual({
      planId: t.planId,
      setupId: top.id,
      zero: { at: ['-20', '0 mm'] },
    })
    await waitFor(() => expect(t.setupRows()[1]).toHaveTextContent('G54 X -20 mm Y 0 mm'))
    expect(
      within(insp).getByText(/G54 at X -20 mm, Y 0 mm from the front left corner of the top/),
    ).toBeInTheDocument()
    // the preview's frame has its origin at the zero
    await waitFor(() => expect(probe.scene?.frame).toEqual(setupFrame('+z', 0, stock, [-20, 0])))

    // add the top front-left corner from the menu: its WCS position is X 20 Y 0
    within(insp).getByRole('button', { name: 'Add an alignment point' }).focus()
    await t.user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu', { name: 'Add an alignment point' })
    await t.user.click(within(menu).getByRole('menuitem', { name: /Top front-left corner/ }))
    await waitFor(() => expect(t.plan().setups[1]!.alignment).toHaveLength(1))
    const list = within(insp).getByRole('list', {
      name: 'Alignment points in the order the spindle visits them',
    })
    await waitFor(() =>
      expect(within(list).getByLabelText('Point 1 name', { selector: 'input' })).toHaveValue(
        'Top front-left corner',
      ),
    )
    await waitFor(() => expect(within(list).getByText(/X 20 mm\s+Y 0 mm/)).toBeInTheDocument())
    await waitFor(() =>
      expect(probe.scene?.alignment).toEqual([
        expect.objectContaining({ at: [20, 0], n: 1, error: false }),
      ]),
    )

    // zero on that point: the inspector names it; removing it is refused in the menu
    within(list).getByRole('button', { name: 'Actions for Top front-left corner' }).focus()
    await t.user.keyboard('{Enter}')
    const actions = await screen.findByRole('menu')
    await t.user.click(within(actions).getByRole('menuitem', { name: 'Zero on this point' }))
    await waitFor(() =>
      expect(t.plan().setups[1]!.zero).toEqual({ point: t.plan().setups[1]!.alignment![0]!.id }),
    )
    await waitFor(() =>
      expect(within(insp).getByText('G54 on Top front-left corner.')).toBeInTheDocument(),
    )
    await expectNoAxeViolations()

    await t.user.click(within(insp).getByRole('button', { name: 'Reset to corner' }))
    await waitFor(() => expect(t.plan().setups[1]!.zero).toBeUndefined())
    await waitFor(() => expect(t.setupRows()[1]).toHaveTextContent('G54 front left'))
  })
})
