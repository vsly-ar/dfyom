// The plan inspector's Strategy group and "Show calculation" (v0.2, strategy editing phase 1)
// against the fake bridge bound to a real project runtime (core plan fixture): choices as
// segmented controls, the drilling cycle by tool type with "Use default" on a cycle that no
// longer fits, lengths and angles with their default or entered source, which parameters show,
// read-only plans, and the calculator's inputs, derivation and values at use.
// Doc: docs/conventions/ui.md#plan-mode-task-37 (Strategy, Calculation), #testing
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { opsOf, planSetup, type PlanSetup } from '../../../../core/plan/plan.fixture'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

/** The plan operation machining a design operation. */
const planOp = (s: PlanSetup, planId: string, design: string) =>
  opsOf(s.plan(planId)).find((o) => o.designOperationIds[0] === design)!

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
  /** Select the row of a design operation name; returns the Strategy group. */
  const open = async (name: string) => {
    await waitFor(() => expect(rows().length).toBeGreaterThan(0))
    const row = [...rows()].find((b) => (b.textContent ?? '').startsWith(name))!
    await r.user.click(row)
    await within(inspector()).findByRole('heading', { name })
    return within(inspector()).findByRole('region', { name: 'Strategy' })
  }
  const strategyOf = (design: string) => planOp(s, planId, design).strategy
  return { ...r, s, planId, bridge, inspector, callsOf, open, strategyOf }
}

const radio = (group: HTMLElement, label: string, name: string) =>
  within(within(group).getByRole('radiogroup', { name: label })).getByRole('radio', { name })

describe('Plan inspector: strategy', () => {
  it('pocket: choices commit one command each; only parameters that apply show', async () => {
    const t = await renderPlan()
    const group = await t.open('Pocket 1')
    const g = within(group)
    // resolved defaults: climb, helix entry with its diameter and ramp angle
    expect(radio(group, 'Cut direction', 'Climb')).toBeChecked()
    expect(radio(group, 'Entry', 'Helix')).toBeChecked()
    expect(g.getByLabelText('Helix diameter', { selector: 'input' })).toBeInTheDocument()
    expect(g.getByLabelText('Ramp angle', { selector: 'input' })).toHaveValue('3°')

    await t.user.click(radio(group, 'Cut direction', 'Conventional'))
    await waitFor(() => expect(t.strategyOf('pocket1').direction).toBe('conventional'))
    expect(t.callsOf('plan.operation.update')).toContainEqual(
      expect.objectContaining({ strategy: { direction: 'conventional' } }),
    )

    // plunge entry: no helix diameter, no ramp angle
    await t.user.click(radio(group, 'Entry', 'Plunge'))
    await waitFor(() => expect(t.strategyOf('pocket1').entry).toBe('plunge'))
    await waitFor(() =>
      expect(g.queryByLabelText('Helix diameter', { selector: 'input' })).toBeNull(),
    )
    expect(g.queryByLabelText('Ramp angle', { selector: 'input' })).toBeNull()
    await expectNoAxeViolations()
  })

  it('lengths show their default; an entered value says so and returns with "Use default"', async () => {
    const t = await renderPlan()
    const group = await t.open('Pocket 1')
    const g = within(group)
    const allowance = g.getByLabelText('Finishing allowance', { selector: 'input' })
    expect(allowance).toHaveValue('0.2 mm')
    // a default is a tag on the title row, its sentence the field's description (DF105)
    expect(allowance).toHaveAccessibleDescription(/Default\./)
    expect(g.getByLabelText('Finish stepdown', { selector: 'input' })).toBeInTheDocument()

    // no finishing pass: the finish stepdown goes
    await t.user.clear(allowance)
    await t.user.type(allowance, '0{Enter}')
    await waitFor(() =>
      expect(t.callsOf('plan.operation.update')).toContainEqual(
        expect.objectContaining({ strategy: { finishAllowance: '0' } }),
      ),
    )
    await waitFor(() =>
      expect(g.queryByLabelText('Finish stepdown', { selector: 'input' })).toBeNull(),
    )
    await g.findByText('Entered by you.')
    await t.user.click(g.getByRole('button', { name: 'Use default' }))
    await waitFor(() => expect(t.strategyOf('pocket1').finishAllowance).toBeUndefined())
    await g.findByLabelText('Finish stepdown', { selector: 'input' })
  })

  it('drilling: the cycle offers what fits the tool; a cycle that no longer fits has "Use default"', async () => {
    const t = await renderPlan(async (s, planId) => {
      const op = planOp(s, planId, 'drill1')
      const assign = (id: string) =>
        s.run('plan.tool.assign', { planId, planOperationId: op.id, toolLibraryItemId: id })
      await assign(s.tools.flat4)
      await s.run('plan.operation.update', {
        planId,
        planOperationId: op.id,
        strategy: { cycle: 'helix' },
      })
      // another tool: the stored helical boring no longer fits a drill
      await assign(s.tools.drill6)
    })
    const group = await t.open('Drilling 1')
    const g = within(group)
    const cycle = g.getByRole('combobox', { name: 'Cycle' })
    expect(cycle).toHaveTextContent('Helical boring (doesn’t fit the tool)')
    // helical boring shows its pitch and ramp angle; a through hole its breakthrough
    expect(g.getByLabelText('Helix pitch', { selector: 'input' })).toBeInTheDocument()
    expect(g.getByLabelText('Breakthrough', { selector: 'input' })).toBeInTheDocument()
    expect(g.queryByLabelText('Peck depth', { selector: 'input' })).toBeNull()
    await t.user.click(g.getByRole('button', { name: 'Use default' }))
    await waitFor(() => expect(t.strategyOf('drill1').cycle).toBeUndefined())
    // the default for a drill: peck, as the through hole is deeper than 3 × D
    await waitFor(() =>
      expect(g.getByRole('combobox', { name: 'Cycle' })).toHaveTextContent(/^Peck$/),
    )

    // a drill offers simple, peck and chip break
    await t.user.click(g.getByRole('combobox', { name: 'Cycle' }))
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(options).toEqual(['Simple', 'Peck', 'Chip break'])
    await t.user.click(screen.getByRole('option', { name: 'Chip break' }))
    await waitFor(() => expect(t.strategyOf('drill1').cycle).toBe('chipBreak'))
    await g.findByLabelText('Peck depth', { selector: 'input' })
    expect(g.getByLabelText('Chip-break retract', { selector: 'input' })).toBeInTheDocument()
    await expectNoAxeViolations()
  })

  it('through profile: cut depth and breakthrough are linked (DF23)', async () => {
    const t = await renderPlan()
    const group = await t.open('Profile 1')
    const g = within(group)
    const depth = g.getByLabelText('Cut depth', { selector: 'input' })
    const breakthrough = g.getByLabelText('Breakthrough', { selector: 'input' })
    const material = Number.parseFloat(
      String(depth.getAttribute('value') ?? (depth as HTMLInputElement).value),
    )
    const extra = Number.parseFloat((breakthrough as HTMLInputElement).value)
    expect(material - extra).toBeGreaterThan(0)
    // entering the depth stores the breakthrough below the material
    await t.user.clear(depth)
    await t.user.type(depth, `${material - extra + 2}{Enter}`)
    await waitFor(() =>
      expect(t.callsOf('plan.operation.update')).toContainEqual(
        expect.objectContaining({ strategy: { breakthrough: '2 mm' } }),
      ),
    )
    await waitFor(() => expect(breakthrough).toHaveValue('2 mm'))
    // shallower than the material is refused at the field
    await t.user.clear(depth)
    await t.user.type(depth, '1{Enter}')
    await waitFor(() => expect(depth).toHaveAttribute('aria-invalid', 'true'))
    expect(t.callsOf('plan.operation.update')).toHaveLength(1)
    await expectNoAxeViolations()
  })

  it('facing in a finalized plan: choices disabled, lengths read-only', async () => {
    const t = await renderPlan((s, planId) => s.toStatus(planId, 'finalized'))
    const group = await t.open('Facing 1')
    const g = within(group)
    expect(radio(group, 'Pattern', 'Zigzag')).toBeDisabled()
    expect(radio(group, 'Rows along', 'X')).toBeChecked()
    expect(g.getByLabelText('Overshoot', { selector: 'input' })).toHaveAttribute('readonly')
    expect(g.queryByRole('button', { name: 'Use default' })).toBeNull()
  })
})

describe('Plan inspector: calculation', () => {
  it('shows the calculator inputs, the derivation of each value and the values at use', async () => {
    const t = await renderPlan(async (s, planId) => {
      await s.run('plan.operation.update', {
        planId,
        planOperationId: planOp(s, planId, 'pocket1').id,
        auto: true,
      })
    })
    await t.open('Pocket 1')
    const insp = within(t.inspector())
    const toggle = insp.getByRole('button', { name: 'Show calculation' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(t.callsOf('plan.operation.feeds.get')).toEqual([])
    await t.user.click(toggle)
    const region = await insp.findByRole('region', { name: 'Calculation' })
    const r = within(region)
    await r.findByText('Aluminium')
    expect(r.getByText('Carbide')).toBeInTheDocument()
    expect(r.getByText('Slot (full width)')).toBeInTheDocument()
    // calculator values carry their formulas
    const steps = r.getByRole('list', { name: 'How feed rate is calculated' })
    expect(steps).toHaveTextContent('vf = n · z · fz · RCTF · ACTF')
    expect(r.getByRole('list', { name: 'How spindle speed is calculated' })).toBeInTheDocument()
    // stepover is the strategy's: a value without a derivation
    expect(r.queryByRole('list', { name: 'How stepover is calculated' })).toBeNull()
    for (const term of ['Surface speed', 'Chip load after chip thinning', 'Chip thinning'])
      expect(r.getByText(term)).toBeInTheDocument()
    // DF74: the finishing pass's own feed at the 0.2 mm allowance
    const finish = within(r.getByRole('region', { name: 'Finishing pass' }))
    for (const term of ['Finishing feed', 'Finishing chip load', 'Finishing chip thinning'])
      expect(finish.getByText(term)).toBeInTheDocument()
    expect(finish.getByText('0.2 mm')).toBeInTheDocument()
    expect(t.callsOf('plan.operation.feeds.get')).toContainEqual({
      planId: t.planId,
      planOperationId: planOp(t.s, t.planId, 'pocket1').id,
    })
    await expectNoAxeViolations()
    await t.user.click(insp.getByRole('button', { name: 'Hide calculation' }))
    expect(insp.queryByRole('region', { name: 'Calculation' })).toBeNull()
  })

  it('without calculator data it says why', async () => {
    const t = await renderPlan(async (s, planId) => {
      await s.run('plan.tool.assign', {
        planId,
        planOperationId: planOp(s, planId, 'drill1').id,
        toolLibraryItemId: s.tools.drill6,
      })
    })
    await t.open('Drilling 1')
    const insp = within(t.inspector())
    await t.user.click(insp.getByRole('button', { name: 'Show calculation' }))
    const region = await insp.findByRole('region', { name: 'Calculation' })
    await within(region).findByText(/^No calculator data: /)
    expect(within(region).getByText('not set')).toBeInTheDocument()
  })
})
