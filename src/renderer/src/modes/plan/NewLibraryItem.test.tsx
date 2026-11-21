// "New tool…" and "New machine…" in plan mode against the fake bridge bound to a real project
// runtime (core plan fixture, in-memory library): the forms add the item with `library.*.add`,
// the tool is assigned to the plan operation, the machine set on the plan or offered to "Create
// plan"; the core's issues show at their field. Doc: docs/conventions/ui.md#plan-mode-task-37
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { planSetup, type PlanSetup } from '../../../../core/plan/plan.fixture'
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

async function renderPlan(opts: { plan?: boolean; setup?: (s: PlanSetup) => Promise<void> } = {}) {
  const s = await planSetup()
  await opts.setup?.(s)
  if (opts.plan !== false) await s.create({ machineLibraryItemId: s.machineId })
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
  const planId = () => Object.keys(s.d.doc.plans)[0]!
  return { ...r, s, nav, inspector, callsOf, rows, planId }
}

type T = Awaited<ReturnType<typeof renderPlan>>

async function fill(t: T, scope: HTMLElement, label: string, value: string) {
  const input = within(scope).getByLabelText(label, { selector: 'input' })
  await t.user.clear(input)
  await t.user.type(input, `${value}{Enter}`)
}

describe('New machine', () => {
  it('adds a machine from the empty state of an empty library, then creates the plan with it', async () => {
    const t = await renderPlan({
      plan: false,
      setup: async (s) => {
        await s.run('library.machine.remove', { id: s.machineId, revision: 1, confirm: true })
      },
    })
    await within(t.nav()).findByText('The machine library is empty. Add a machine to export gCode.')
    await t.user.click(within(t.nav()).getByRole('button', { name: 'New machine…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New machine' })
    await expectNoAxeViolations()
    const name = within(dialog).getByRole('textbox', { name: 'Name' })
    await t.user.clear(name)
    await t.user.type(name, 'Router')
    await fill(t, dialog, 'Travel X', '600')
    await fill(t, dialog, 'Max feed rate Z', '800')
    await t.user.click(within(dialog).getByRole('radio', { name: 'By gCode' }))
    await fill(t, dialog, 'Spindle power', '800')
    await t.user.click(within(dialog).getByRole('button', { name: 'Add machine' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const [added] = t.callsOf('library.machine.add') as { values: Record<string, never> }[]
    expect(added!.values).toMatchObject({
      name: 'Router',
      controller: 'grbl',
      travel: { x: { source: '600' }, y: { source: '400' } },
      maxFeedRate: { z: { source: '800' } },
      spindle: { control: 'gcode', maxSpeed: { source: '30000' }, power: { source: '800' } },
      programUnits: 'mm',
      toolChanger: 'none',
    })
    await waitFor(() =>
      expect(within(t.nav()).queryByText(/The machine library is empty/)).toBeNull(),
    )
    await t.user.click(within(t.nav()).getByRole('button', { name: 'Create plan' }))
    await waitFor(() => expect(t.callsOf('plan.create')).toHaveLength(1))
    expect(t.callsOf('plan.create')[0]).toMatchObject({ machineLibraryItemId: expect.any(String) })
    expect(await within(t.nav()).findByRole('combobox', { name: 'Machine' })).toHaveTextContent(
      'Router',
    )
  })

  it('shows the core’s issues at their field and keeps the dialog open; added machines are set on the plan', async () => {
    const t = await renderPlan()
    await t.user.click(await within(t.nav()).findByRole('button', { name: 'New machine…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New machine' })
    await fill(t, dialog, 'Travel Y', '0')
    await fill(t, dialog, 'Min spindle speed', '40000')
    await t.user.click(within(dialog).getByRole('button', { name: 'Add machine' }))
    const travelY = within(dialog).getByLabelText('Travel Y', { selector: 'input' })
    await waitFor(() => expect(travelY).toHaveAttribute('aria-invalid', 'true'))
    expect(travelY).toHaveFocus()
    expect(
      within(dialog).getByLabelText('Min spindle speed', { selector: 'input' }),
    ).toHaveAttribute('aria-invalid', 'true')
    expect(within(dialog).getByLabelText('Travel X', { selector: 'input' })).not.toHaveAttribute(
      'aria-invalid',
    )
    await expectNoAxeViolations()

    await fill(t, dialog, 'Travel Y', '300')
    await fill(t, dialog, 'Min spindle speed', '10000')
    await t.user.click(within(dialog).getByRole('button', { name: 'Add machine' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() =>
      expect(within(t.nav()).getByRole('combobox', { name: 'Machine' })).toHaveTextContent(
        'My machine',
      ),
    )
    expect(t.callsOf('plan.machine.set')).toEqual([
      { planId: t.planId(), machineLibraryItemId: expect.any(String) },
    ])
  })

  it('saves an optional field emptied after typing as unset (known issue, 3.13)', async () => {
    const t = await renderPlan()
    await t.user.click(await within(t.nav()).findByRole('button', { name: 'New machine…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New machine' })
    await fill(t, dialog, 'Min spindle speed', '8000')
    await fill(t, dialog, 'Spindle power', '800')
    const power = within(dialog).getByLabelText('Spindle power', { selector: 'input' })
    await t.user.clear(power)
    await t.user.type(power, '{Enter}')
    expect(power).toHaveValue('')
    expect(power).not.toHaveAttribute('aria-invalid')
    const minSpeed = within(dialog).getByLabelText('Min spindle speed', { selector: 'input' })
    await t.user.clear(minSpeed)
    await t.user.tab()
    expect(minSpeed).toHaveValue('')
    expect(minSpeed).not.toHaveAttribute('aria-invalid')
    await t.user.click(within(dialog).getByRole('button', { name: 'Add machine' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const [added] = t.callsOf('library.machine.add') as {
      values: { spindle: Record<string, unknown> }
    }[]
    expect(added!.values.spindle).toMatchObject({ maxSpeed: { source: '30000' } })
    expect(added!.values.spindle).not.toHaveProperty('minSpeed')
    expect(added!.values.spindle).not.toHaveProperty('power')
  })
})

describe('New tool', () => {
  it('adds a tool for the selected operation (a drill for a drilling) and assigns it', async () => {
    const t = await renderPlan()
    await waitFor(() => expect(t.rows().length).toBeGreaterThan(0))
    const drillRow = [...t.rows()].find((b) => /^Drilling 1/.test(b.textContent ?? ''))!
    await t.user.click(drillRow)
    const insp = t.inspector()
    await within(insp).findByRole('heading', { name: 'Drilling 1' })
    await t.user.click(within(insp).getByRole('button', { name: 'New tool…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New tool' })
    expect(within(dialog).getByRole('combobox', { name: 'Type' })).toHaveTextContent('Drill')
    expect(within(dialog).getByLabelText('Point angle', { selector: 'input' })).toHaveValue('118')
    expect(within(dialog).queryByLabelText('Corner radius', { selector: 'input' })).toBeNull()
    await fill(t, dialog, 'Diameter', '5')
    // the suggested name follows the diameter until a name is typed
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('Drill 5')
    await expectNoAxeViolations()
    await t.user.click(within(dialog).getByRole('button', { name: 'Add tool' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const [added] = t.callsOf('library.tool.add') as { values: Record<string, unknown> }[]
    expect(added!.values).toMatchObject({
      name: 'Drill 5',
      type: 'drill',
      diameter: { source: '5' },
      pointAngle: { source: '118' },
      toolMaterial: 'carbide',
      presets: [],
    })
    expect(added!.values).not.toHaveProperty('cornerRadius')
    await waitFor(() => expect(t.callsOf('plan.tool.assign')).toHaveLength(1))
    expect(t.callsOf('plan.tool.assign')[0]).toMatchObject({
      planId: t.planId(),
      toolLibraryItemId: expect.any(String),
    })
    await waitFor(() =>
      expect(within(insp).getByRole('combobox', { name: 'Tool' })).toHaveTextContent(/Drill 5/),
    )
  })

  it('offers the corner radius for a bull nose and shows the core’s issues at their field', async () => {
    const t = await renderPlan()
    await waitFor(() => expect(t.rows().length).toBeGreaterThan(0))
    await t.user.click(t.rows()[0]!)
    const insp = t.inspector()
    await within(insp).findByRole('heading', { name: 'Facing 1' })
    await t.user.click(within(insp).getByRole('button', { name: 'New tool…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New tool' })
    expect(within(dialog).getByRole('combobox', { name: 'Type' })).toHaveTextContent(
      'Flat end mill',
    )
    await t.user.click(within(dialog).getByRole('combobox', { name: 'Type' }))
    await t.user.click(await screen.findByRole('option', { name: 'Bull nose end mill' }))
    await fill(t, dialog, 'Corner radius', '3')
    await fill(t, dialog, 'Overall length', '10')
    await t.user.click(within(dialog).getByRole('button', { name: 'Add tool' }))
    const re = within(dialog).getByLabelText('Corner radius', { selector: 'input' })
    await waitFor(() => expect(re).toHaveAttribute('aria-invalid', 'true'))
    expect(re).toHaveFocus()
    expect(within(dialog).getByLabelText('Overall length', { selector: 'input' })).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(t.callsOf('plan.tool.assign')).toEqual([])
    await expectNoAxeViolations()
    await t.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
