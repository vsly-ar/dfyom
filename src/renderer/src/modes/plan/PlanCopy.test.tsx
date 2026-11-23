// Plan-only edits in the UI (task E3b) against the fake bridge bound to a real project runtime
// (core plan fixture): the "Part (plan copy)" group from the shared Design field components,
// "Edited in plan" and "Revert to design", read-only in draft with the hint, the rebuild that
// discards plan edits confirmed with their count, and the snapshot scene drawing the plan's own
// part (its evaluation pushed per plan). The viewport canvas is stubbed.
// Doc: docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene,
// docs/conventions/ui.md#design-and-plan-controls-v02
import { act, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { planSetup, type PlanSetup } from '../../../../core/plan/plan.fixture'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { useModeScene } from '../ModePanels'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

const facingId = (s: PlanSetup) => s.part().operations.find((o) => o.kind === 'facing')!.id

async function renderPlan(setup?: (s: PlanSetup, planId: string) => Promise<void>) {
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
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const nav = () => screen.getByRole('navigation', { name: 'Navigator' })
  const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
  const callsOf = (name: string) => bridge.calls.filter((c) => c.name === name).map((c) => c.args)
  const rows = () =>
    within(nav())
      .getByRole('list', { name: 'Plan operations in machining order' })
      .querySelectorAll(':scope > li > button')
  /** Selects the facing row and returns the plan copy group. */
  const facingCopy = async () => {
    await waitFor(() => expect(rows().length).toBeGreaterThan(0))
    await r.user.click(rows()[0]!)
    await within(inspector()).findByRole('heading', { name: 'Facing 1' })
    return within(inspector()).getByRole('region', { name: 'Part (plan copy)' })
  }
  return { ...r, s, planId, bridge, nav, inspector, callsOf, facingCopy }
}

describe('Plan-only edits', () => {
  it('edits the plan copy in a settled plan, shows "Edited in plan" and reverts to design', async () => {
    const t = await renderPlan((s, planId) => s.toStatus(planId, 'settledDesign'))
    const group = await t.facingCopy()
    expect(
      within(group).getByText('Changes here apply to this plan only, not to the design.'),
    ).toBeInTheDocument()
    expect(within(group).queryByText('Edited in plan')).toBeNull()
    const depth = within(group).getByLabelText('Depth', { selector: 'input' })
    await t.user.clear(depth)
    await t.user.type(depth, '1.5{Enter}')
    await waitFor(() =>
      expect(t.callsOf('plan.design.operation.update')).toEqual([
        { planId: t.planId, operationId: facingId(t.s), depth: '1.5' },
      ]),
    )
    // the design is untouched; the plan's part has the edit
    const planOp = t.s.plan(t.planId).design.part.operations.find((o) => o.id === facingId(t.s))!
    expect((planOp as { depth: { source: string } }).depth.source).toBe('1.5')
    expect(t.s.part().operations.find((o) => o.kind === 'facing')).not.toEqual(planOp)
    await within(group).findByText('Edited in plan')
    await expectNoAxeViolations()

    await t.user.click(within(group).getByRole('button', { name: 'Revert to design' }))
    await waitFor(() => expect(within(group).queryByText('Edited in plan')).toBeNull())
    expect(t.callsOf('plan.design.operation.revert')).toEqual([
      { planId: t.planId, planOperationId: t.s.plan(t.planId).setups[0]!.operations[0]!.id },
    ])
    expect(within(group).queryByRole('button', { name: 'Revert to design' })).toBeNull()
  })

  it('shows the plan copy read-only in a draft plan, with the hint to settle the design', async () => {
    const t = await renderPlan()
    const group = await t.facingCopy()
    expect(
      within(group).getByText(
        'This plan follows the design while it is a draft. To edit this operation for this plan only, set the plan status to settled design.',
      ),
    ).toBeInTheDocument()
    expect(within(group).getByLabelText('Depth', { selector: 'input' })).toHaveAttribute('readonly')
  })

  it('confirms a rebuild that discards plan-only edits, naming their count', async () => {
    const t = await renderPlan(async (s, planId) => {
      await s.toStatus(planId, 'settledDesign')
      await s.run('plan.design.operation.update', { planId, operationId: facingId(s), depth: '1' })
      await s.run('design.facing.update', {
        partId: s.partId,
        operationId: facingId(s),
        depth: '2',
      })
    })
    const rebuild = await within(t.nav()).findByRole('button', { name: 'Rebuild plan' })
    await t.user.click(rebuild)
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Rebuild discards 1 plan-only edit')
    await t.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(t.callsOf('plan.rebuild')).toEqual([])

    await t.user.click(within(t.nav()).getByRole('button', { name: 'Rebuild plan' }))
    const again = await screen.findByRole('alertdialog')
    await t.user.click(within(again).getByRole('button', { name: 'Rebuild plan' }))
    await waitFor(() =>
      expect(t.callsOf('plan.rebuild')).toEqual([{ planId: t.planId, discardPlanEdits: true }]),
    )
    await waitFor(() =>
      expect(
        within(t.nav()).queryByText('The design changed since this plan was made.'),
      ).toBeNull(),
    )
  })
})

describe('Snapshot scene', () => {
  const mesh = (surface: string) => ({
    positions: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    triangleSurface: new Uint32Array([0]),
    surfaces: [surface],
  })

  it("draws the plan's part (its own evaluation) with edited operations tinted", async () => {
    const s = await planSetup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    await s.toStatus(planId, 'settledDesign')
    await s.run('plan.design.operation.update', { planId, operationId: facingId(s), depth: '1' })
    const bridge = createFakeBridge()
    bridge.bind(s.d)
    const shell = createShell(bridge)
    let scene: ReturnType<typeof useModeScene> | undefined
    function Probe(): null {
      scene = useModeScene('plan')
      return null
    }
    render(
      <ShellProvider shell={shell}>
        <Probe />
      </ShellProvider>,
    )
    await waitFor(() => expect(shell.replica.getState().status).toBe('open'))
    const key = 'p1' // the fake bridge's default binding
    act(() => {
      bridge.emitEvaluation({
        key,
        partId: s.partId,
        status: 'done',
        inputHash: 'd',
        mesh: mesh('design'),
      })
      bridge.emitEvaluation({
        key,
        partId: s.partId,
        planId,
        status: 'done',
        inputHash: 'p',
        mesh: mesh('plan'),
      })
    })
    await waitFor(() => expect(scene?.mesh?.surfaces).toEqual(['plan']))
    expect(scene?.status).toBe('done')
    expect([...(scene?.tinted ?? [])]).toEqual([facingId(s)])
    expect(scene?.stock).not.toBeNull()
  })
})
