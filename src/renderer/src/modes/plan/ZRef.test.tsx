// The Z reference in the plan viewport and the operation inspector (hardening DF69) against the fake
// bridge bound to a real project runtime with the 2D regions (core plan fixture plus a bottom
// facing: setups Bottom, Top): which run's reference the plan scene shows (selected setup, a
// hovered "Z from", a selected operation), the spot dragged on the grid inside the flat patch and
// committed once, Escape-free cancel, and the inspector's "Z from" with the spot's X and Y.
// Doc: docs/conventions/ui.md#design-and-plan-controls-v02, docs/modes/z-reference.md#implementation-notes-df69
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
import { planSetup } from '../../../../core/plan/plan.fixture'
import type { CallReply } from '../../../../shared/preload-api'
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

const probe: { scene: RunScene | null } = { scene: null }
function SceneProbe(): null {
  const scene = usePlanScene('plan')
  useEffect(() => {
    probe.scene = scene
  }, [scene])
  return null
}

async function renderPlan() {
  const s = await planSetup({ services: { region2d: nodeRegion2d() } })
  await s.run('design.facing.add', { partId: s.partId, on: 'stock.bottom', depth: '0.5' })
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  bridge.handle('plan.toolpath.get', () => ok({ toolpath: null, stale: false }))
  const shell = createShell(bridge)
  shell.ui.getState().setMode('plan')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
      <SceneProbe />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
  const plan = () => s.plan(planId)
  const top = () => plan().setups[1]!
  const select = (id: string | null) => act(() => shell.ui.getState().select('plan', id))
  const callsOf = (name: string) => bridge.calls.filter((c) => c.name === name).map((c) => c.args)
  await waitFor(() => expect(plan().setups).toHaveLength(2))
  return { ...r, s, planId, plan, top, inspector, select, callsOf }
}

const zRef = () => probe.scene?.zRef

describe('Z reference in the plan viewport (DF69)', () => {
  it("shows the selected setup's first run, a hovered run, then the selected operation's run", async () => {
    const t = await renderPlan()
    t.select(null)
    await waitFor(() => expect(probe.scene).not.toBeNull())
    expect(zRef()).toBeUndefined()
    // the Top setup: its first run (the facing) touches off on the top face
    t.select(t.top().id)
    await waitFor(() => expect(zRef()?.level).toBe(0))
    expect(zRef()!.patch.length).toBeGreaterThan(0)
    expect(zRef()!.draggable).toBe(true)
    // hovering the drill run's "Z from" shows the faced floor
    const runs = within(t.inspector()).getByRole('list', {
      name: 'Tool runs of Top in machining order',
    })
    const drillRun = await waitFor(() => {
      const row = runs.querySelectorAll<HTMLElement>(':scope > li')[1]!
      expect(row).toHaveTextContent('Z fromFacing 1 floor')
      return row
    })
    const zFrom = within(drillRun).getByText('Z from').parentElement!
    fireEvent.pointerEnter(zFrom)
    await waitFor(() => expect(zRef()?.level).toBe(-0.5))
    expect(zRef()!.key).toContain('facing1.floor')
    fireEvent.pointerLeave(zFrom)
    await waitFor(() => expect(zRef()?.level).toBe(0))
    // a selected operation shows its own run (Drilling 3 is in the run Drilling 1 starts)
    const drill3 = t.top().operations.find((o) => o.designOperationIds.includes('drill3'))!
    t.select(drill3.id)
    await waitFor(() => expect(zRef()?.level).toBe(-0.5))
  })

  it('drags the spot on the grid inside the patch and commits one update on release', async () => {
    const t = await renderPlan()
    const drill = t.top().operations[1]!
    t.select(drill.id)
    await waitFor(() => expect(zRef()?.level).toBe(-0.5))
    // a move snaps to the 1 mm grid
    act(() => zRef()!.onDrag('start', zRef()!.at))
    expect(zRef()!.dragging).toBe(true)
    act(() => zRef()!.onDrag('move', [30.4, 20.2]))
    expect(zRef()!.at).toEqual([30, 20])
    expect(zRef()!.caption).toBe('X 30 mm  Y 20 mm')
    // past the stock's edge the spot stays inside, a clearance radius from it
    act(() => zRef()!.onDrag('move', [-50, 20.2]))
    const clamped = zRef()!.at
    expect(clamped[1]).toBe(20)
    expect(clamped[0]).toBeGreaterThanOrEqual(3)
    expect(clamped[0]).toBeLessThan(10)
    expect(t.callsOf('plan.operation.update')).toEqual([])
    // cancel: back to the stored spot, nothing sent
    act(() => zRef()!.onDrag('cancel', [0, 0]))
    expect(zRef()!.dragging).toBe(false)
    expect(zRef()!.at).not.toEqual(clamped)
    // a full drag: one update, the dropped spot held until the plan has it
    act(() => zRef()!.onDrag('start', zRef()!.at))
    act(() => zRef()!.onDrag('move', [30.4, 20.2]))
    act(() => zRef()!.onDrag('end', [30.4, 20.2]))
    expect(zRef()!.at).toEqual([30, 20])
    await waitFor(() =>
      expect(t.callsOf('plan.operation.update')).toEqual([
        { planId: t.planId, planOperationId: drill.id, zRef: { at: ['30 mm', '20 mm'] } },
      ]),
    )
    await waitFor(() => expect(t.top().operations[1]!.zRef).toEqual({ at: [30, 20] }))
    await waitFor(() => expect(zRef()?.at).toEqual([30, 20]))
  })

  it('does not drag in a read-only plan', async () => {
    const t = await renderPlan()
    await t.s.run('plan.status.set', { planId: t.planId, status: 'archived' })
    t.select(t.top().id)
    await waitFor(() => expect(zRef()?.draggable).toBe(false))
  })
})

describe('Z reference in the operation inspector (DF69)', () => {
  it("shows Z from and the spot for a run's first operation; X commits with Y kept", async () => {
    const t = await renderPlan()
    const drill = t.top().operations[1]!
    t.select(drill.id)
    const button = await within(t.inspector()).findByRole('button', {
      name: 'Z from for Drill 6: Facing 1 floor · −0.5 mm (default). Choose the surface',
    })
    expect(button).toBeInTheDocument()
    const x = within(t.inspector()).getByLabelText('Touch-off X', { selector: 'input' })
    const y = within(t.inspector()).getByLabelText('Touch-off Y', { selector: 'input' })
    const list = t.s.query('plan.warning.list', { planId: t.planId }) as {
      zRefs: { planOperationId: string; zRef: { at: [number, number] } }[]
    }
    const y0 = list.zRefs.find((r) => r.planOperationId === drill.id)!.zRef.at[1]
    expect(y).toHaveValue(`${y0} mm`)
    await expectNoAxeViolations(t.inspector())
    await t.user.clear(x)
    await t.user.type(x, '25{Enter}')
    await waitFor(() =>
      expect(t.callsOf('plan.operation.update')).toEqual([
        { planId: t.planId, planOperationId: drill.id, zRef: { at: ['25', `${y0} mm`] } },
      ]),
    )
    // a moved spot offers the default back
    const reset = await within(t.inspector()).findByRole('button', { name: 'Use default spot' })
    expect(within(t.inspector()).getByText('Moved by you.')).toBeInTheDocument()
    await t.user.click(reset)
    await waitFor(() => expect(t.top().operations[1]!.zRef).toBeUndefined())
  })

  it('shows nothing for an operation inside a run', async () => {
    const t = await renderPlan()
    const drill3 = t.top().operations.find((o) => o.designOperationIds.includes('drill3'))!
    t.select(drill3.id)
    await within(t.inspector()).findAllByRole('heading', { name: /Drilling 3/ })
    expect(within(t.inspector()).queryByLabelText('Touch-off X', { selector: 'input' })).toBeNull()
  })
})
