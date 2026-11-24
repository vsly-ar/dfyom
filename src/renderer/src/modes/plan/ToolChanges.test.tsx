// "Tool changes" in the setup inspector (hardening DF66) against the fake bridge bound to a real
// project runtime (core plan fixture plus a bottom facing: setups Bottom, Top): the runs with tool,
// operations and time, the count (the tool kept from Bottom is no change), a run reordered as a
// block by Alt+↑/↓ and by its grip (one `plan.operation.move { count }`), a refused move, read-only.
// Doc: docs/conventions/ui.md#design-and-plan-controls-v02, docs/modes/plan-v0.4.md#tool-changes-per-setup-hardening-df66
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
import { planSetup, type PlanSetup } from '../../../../core/plan/plan.fixture'
import type { CallReply } from '../../../../shared/preload-api'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { dragTo, gripOf, layOutRows } from '../../test/reorder'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

// the vendored 2D module read from the repo root (jsdom has no file: import.meta.url)
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: string): Uint8Array } }
  }
).process.getBuiltinModule('node:fs')
const nodeRegion2d = () =>
  loadRegion2dSync(fs.readFileSync('vendor/cavalier-contours/cavalier_contours.wasm')).expect(
    'the vendored 2D module loads',
  )

const ok = (value: unknown = {}): CallReply => ({ ok: true, value, revision: 0 })

const toolpath = {
  planOperationId: 'x',
  tool: 't',
  spindleSpeed: 1000,
  passes: [{ kind: 'rough', moves: [{ kind: 'rapid', to: [0, 0, 5] }] }],
  stats: { cutLength: 1, rapidLength: 0, estimatedSeconds: 65 },
}

async function renderTop(
  setup?: (s: PlanSetup, planId: string) => Promise<void>,
  opts: { zRefs?: boolean } = {},
) {
  // DF69: Z references need the 2D regions (without them `zRefs` is empty: no "Z from")
  const s = await planSetup(opts.zRefs === true ? { services: { region2d: nodeRegion2d() } } : {})
  await s.run('design.facing.add', { partId: s.partId, on: 'stock.bottom', depth: '0.5' })
  await setup?.(s, '')
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  bridge.handle('plan.toolpath.get', () => ok({ toolpath, stale: false }))
  const shell = createShell(bridge)
  shell.ui.getState().setMode('plan')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const nav = () => screen.getByRole('navigation', { name: 'Navigator' })
  const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
  const setupList = () => within(nav()).getByRole('list', { name: 'Setups in machining order' })
  await waitFor(() => expect(setupList().querySelectorAll(':scope > li').length).toBe(2))
  const topRow = setupList().querySelectorAll<HTMLElement>(':scope > li > div > button')[1]!
  await r.user.click(topRow)
  const runList = () =>
    within(inspector()).getByRole('list', { name: 'Tool runs of Top in machining order' })
  const runs = () => [...runList().querySelectorAll<HTMLElement>(':scope > li')]
  await waitFor(() => expect(runs().length).toBeGreaterThan(0))
  const plan = () => s.plan(planId)
  const top = () => plan().setups[1]!
  const callsOf = (name: string) => bridge.calls.filter((c) => c.name === name).map((c) => c.args)
  return { ...r, s, planId, plan, top, inspector, runList, runs, callsOf }
}

const designOrder = (ops: readonly { designOperationIds: readonly string[] }[]) =>
  ops.map((o) => o.designOperationIds.join('+'))

describe('Tool changes (DF66)', () => {
  it('lists the tool runs with tool, operations and time; the kept tool is no change', async () => {
    const t = await renderTop()
    // Top: Flat 6 (facing) · Drill 6 (2 drillings) · Flat 4 · Bull 6 (pocket) · Flat 6 (profile)
    expect(designOrder(t.top().operations)).toEqual([
      'facing1',
      'drill1',
      'drill3+drill4',
      'drill2',
      'pocket1',
      'profile1',
    ])
    const runs = t.runs()
    expect(runs).toHaveLength(5)
    expect(runs[0]).toHaveTextContent('Flat 6')
    expect(runs[0]).toHaveTextContent('Ø 6 mm · Flat end mill')
    expect(runs[0]).toHaveTextContent('Facing 1')
    // Bottom ends with Flat 6 too (DF65): it stays in the spindle
    expect(runs[0]).toHaveTextContent(
      'Stays in the spindle from Bottom: no change at the setup start.',
    )
    expect(runs[1]).toHaveTextContent('Drill 6')
    expect(runs[1]).toHaveTextContent('Drilling 1, Drilling 3, Drilling 4')
    expect(runs[4]).toHaveTextContent('Profile 1')
    expect(within(t.inspector()).getByRole('heading', { name: /Tool changes/ })).toHaveTextContent(
      '4 tool changes',
    )
    // every toolpath is current: 2 × 65 s for the drill run
    await waitFor(() => expect(runs[1]).toHaveTextContent('2 min 10 s'))
    await expectNoAxeViolations(t.inspector())
  })

  it('moves a run as a block with Alt+↑/↓ and by its grip, one move each', async () => {
    const t = await renderTop()
    const [, drill1] = t.top().operations
    t.runs()[1]!.focus()
    await t.user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await waitFor(() =>
      expect(designOrder(t.top().operations)).toEqual([
        'facing1',
        'drill2',
        'drill1',
        'drill3+drill4',
        'pocket1',
        'profile1',
      ]),
    )
    expect(t.callsOf('plan.operation.move')).toEqual([
      { planId: t.planId, planOperationId: drill1!.id, count: 2, toIndex: 2 },
    ])
    expect(await screen.findByText('Moved Drill 6 to position 3 of 5.')).toBeInTheDocument()
    expect(document.activeElement).toBe(t.runs()[2])
    // ↑/↓ move the focus between runs
    await t.user.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(t.runs()[1])
    // the drill run (now 3rd) dragged back above Flat 4 (rows 30 px apart: gap 1)
    const restore = layOutRows()
    try {
      dragTo(gripOf(t.runs()[2]!), 35)
      await waitFor(() => expect(designOrder(t.top().operations)[1]).toBe('drill1'))
    } finally {
      restore()
    }
    expect(t.callsOf('plan.operation.move').at(-1)).toEqual({
      planId: t.planId,
      planOperationId: drill1!.id,
      count: 2,
      toIndex: 1,
    })
    expect(designOrder(t.top().operations)[3]).toBe('drill2')
  })

  it('shows why a move is refused and keeps the order', async () => {
    const t = await renderTop(async (s) => {
      // a hole on the pocket floor without a tool: a run of its own that must follow the pocket
      await s.run('design.drilling.add', {
        partId: s.partId,
        on: 'pocket1.floor',
        center: ['50', '30'],
        diameter: '3',
        bottom: 'flat',
        depth: '2',
      })
    })
    const before = designOrder(t.top().operations)
    expect(before.indexOf('drill5')).toBe(before.indexOf('pocket1') + 1)
    const runs = t.runs()
    expect(runs).toHaveLength(6)
    expect(runs[4]).toHaveTextContent('No tool')
    runs[4]!.focus()
    await t.user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    expect(await within(t.inspector()).findByText(/^Not moved: /)).toBeInTheDocument()
    expect(designOrder(t.top().operations)).toEqual(before)
  })

  // DF69: docs/modes/z-reference.md#ui
  it("shows each run's Z reference; the menu stores a choice and Default resets it", async () => {
    const t = await renderTop(undefined, { zRefs: true })
    // the first run touches off on the top face, the later ones on the faced floor (by default)
    await waitFor(() => expect(t.runs()[1]).toHaveTextContent('Z fromFacing 1 floor · −0.5 mm'))
    expect(t.runs()[0]).toHaveTextContent('Z fromTop face · 0 mm')
    const drillRun = t.top().operations[1]!
    const button = within(t.runs()[1]!).getByRole('button', {
      name: 'Z from for Drill 6: Facing 1 floor · −0.5 mm (default). Choose the surface',
    })
    expect(button).not.toHaveAttribute('data-chosen')
    await expectNoAxeViolations(t.inspector())
    await t.user.click(button)
    const menu = await screen.findByRole('menu')
    await expectNoAxeViolations(menu)
    await t.user.click(within(menu).getByRole('menuitem', { name: /^Facing 1 floor/ }))
    await waitFor(() =>
      expect(t.callsOf('plan.operation.update')).toEqual([
        { planId: t.planId, planOperationId: drillRun.id, zRef: { surface: 'facing1.floor' } },
      ]),
    )
    expect(t.plan().setups[1]!.operations[1]!.zRef).toEqual({ surface: 'facing1.floor' })
    const chosen = await within(t.runs()[1]!).findByRole('button', {
      name: 'Z from for Drill 6: Facing 1 floor · −0.5 mm. Choose the surface',
    })
    expect(chosen).toHaveAttribute('data-chosen')
    await t.user.click(chosen)
    const again = await screen.findByRole('menu')
    await t.user.click(within(again).getByRole('menuitem', { name: /^Default/ }))
    await waitFor(() => expect(t.plan().setups[1]!.operations[1]!.zRef).toBeUndefined())
  })

  it('shows the list read-only outside draft and settled design', async () => {
    const t = await renderTop()
    await t.s.run('plan.status.set', { planId: t.planId, status: 'archived' })
    await waitFor(() => expect(t.runs()[0]).not.toHaveAttribute('tabindex'))
    expect(t.runList().querySelector('[data-reorder-grip]')).toBeNull()
    await expectNoAxeViolations(t.inspector())
  })
})
