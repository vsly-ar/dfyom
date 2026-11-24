// Several parts per project (split parts S0) against the fake bridge bound to a real project
// runtime (core plan fixture): the part menu in the Design navigator (switch, New part…, Remove
// with an undo toast or a confirmation when plans go too), Plan's part choice (the start card's
// Part field, New plan per part, plan names with their part), with axe on each state. The
// viewport canvas is stubbed. Doc: docs/modes/split-parts.md#prerequisite-several-parts-per-project,
// docs/conventions/ui.md#part-menu-split-parts-s0
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { uiSource } from '../../../../core/commands/testing'
import { planSetup, type PlanSetup } from '../../../../core/plan/plan.fixture'
import { expectOk } from '../../../../shared/testing/result'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, findToastAction, renderUi } from '../../test/render'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

/** A second part "Lid" from the first part's library stock. */
async function addLid(s: PlanSetup): Promise<string> {
  const stock = s.d.doc.snapshots[s.part().stock]!.libraryItemId!
  const r = await s.d.dispatch(
    'design.part.add',
    { name: 'Lid', stockLibraryItemId: stock },
    uiSource(),
  )
  return (expectOk(r).value as { partId: string }).partId
}

async function renderParts(
  opts: { lid?: boolean; mode?: 'design' | 'plan'; plan?: 'bracket' | 'lid' } = {},
) {
  const s = await planSetup()
  const lid = opts.lid === false ? undefined : await addLid(s)
  if (opts.plan !== undefined)
    await s.create({
      machineLibraryItemId: s.machineId,
      ...(opts.plan === 'lid' ? { partId: lid } : {}),
    })
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  const shell = createShell(bridge)
  shell.ui.getState().setMode(opts.mode ?? 'design')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  const nav = () => screen.getByRole('navigation', { name: 'Navigator' })
  const partRow = () => within(nav()).getByRole('region', { name: 'Part' })
  const openMenu = async () => {
    within(partRow())
      .getByRole('button', { name: /^Parts/ })
      .focus()
    await r.user.keyboard('{Enter}')
    return screen.findByRole('menu', { name: /^Parts/ })
  }
  const callsOf = (name: string) => bridge.calls.filter((c) => c.name === name).map((c) => c.args)
  if ((opts.mode ?? 'design') === 'design')
    await within(nav()).findByRole('region', { name: 'Part' })
  return { ...r, s, lid, shell, nav, partRow, openMenu, callsOf }
}

describe('part menu (split parts S0)', () => {
  it('lists the parts with the shown one checked and switches the navigator', async () => {
    const t = await renderParts()
    // the first part is shown; its operations are listed
    expect(within(t.partRow()).getByRole('button', { name: 'Bracket' })).toBeVisible()
    expect(within(t.partRow()).getByRole('button', { name: 'Parts (2 parts)' })).toBeVisible()
    const menu = await t.openMenu()
    const items = within(menu).getAllByRole('menuitemradio')
    expect(items.map((i) => i.textContent)).toEqual(['Bracket', 'Lid'])
    expect(items[0]).toHaveAttribute('aria-checked', 'true')
    expect(items[1]).toHaveAttribute('aria-checked', 'false')
    expect(within(menu).getByRole('menuitem', { name: 'New part…' })).toBeVisible()
    expect(within(menu).getByRole('menuitem', { name: 'Remove Bracket' })).toBeVisible()
    await expectNoAxeViolations()
    await t.user.click(items[1]!)
    // the Lid has no operations: its empty state; window state only, no command
    await within(t.nav()).findByRole('heading', { name: 'No operations yet' })
    expect(within(t.partRow()).getByRole('button', { name: 'Lid' })).toBeVisible()
    expect(t.shell.ui.getState().designPart).toBe(t.lid)
    expect(t.callsOf('design.part.update')).toEqual([])
    await expectNoAxeViolations()
  })

  it('New part… opens the Stock dialog for another part and shows the new part', async () => {
    const t = await renderParts({ lid: false })
    // one part: the menu still offers New part…
    expect(within(t.partRow()).getByRole('button', { name: 'Parts' })).toBeVisible()
    const menu = await t.openMenu()
    await t.user.click(within(menu).getByRole('menuitem', { name: 'New part…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New part' })
    expect(within(dialog).getByRole('textbox', { name: 'Part name' })).toHaveValue('Bracket 2')
    await expectNoAxeViolations()
    await t.user.click(within(dialog).getByRole('button', { name: 'Create part' }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    await waitFor(() => expect(Object.keys(t.s.d.doc.parts)).toHaveLength(2))
    expect(within(t.partRow()).getByRole('button', { name: 'Bracket 2' })).toBeVisible()
    expect(t.callsOf('design.part.add')).toEqual([
      expect.objectContaining({ name: 'Bracket 2', stock: expect.any(Object) }),
    ])
  })

  it('removes a part without plans with an undo toast; undo brings it back', async () => {
    const t = await renderParts()
    t.shell.ui.getState().setDesignPart(t.lid!)
    const menu = await t.openMenu()
    await t.user.click(within(menu).getByRole('menuitem', { name: 'Remove Lid' }))
    await waitFor(() => expect(Object.keys(t.s.d.doc.parts)).toEqual([t.s.partId]))
    expect(t.callsOf('design.part.remove')).toEqual([{ partId: t.lid }])
    // the first part shows again
    await waitFor(() =>
      expect(within(t.partRow()).getByRole('button', { name: 'Bracket' })).toBeVisible(),
    )
    await t.user.click(await findToastAction('Undo'))
    await waitFor(() => expect(Object.keys(t.s.d.doc.parts)).toHaveLength(2))
  })

  it('confirms removing a part whose plans go too', async () => {
    const t = await renderParts({ plan: 'lid' })
    t.shell.ui.getState().setDesignPart(t.lid!)
    const menu = await t.openMenu()
    await t.user.click(within(menu).getByRole('menuitem', { name: 'Remove Lid' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove Lid?' })
    expect(confirm).toHaveAccessibleDescription(/Its plan is removed too/)
    await expectNoAxeViolations()
    await t.user.click(within(confirm).getByRole('button', { name: 'Remove part' }))
    await waitFor(() => expect(t.s.d.doc.plans).toEqual({}))
    expect(t.callsOf('design.part.remove')).toEqual([{ partId: t.lid, confirm: true }])
  })
})

describe('plans pick their part (split parts S0)', () => {
  it('the Plan start card asks for the part and plans the chosen one', async () => {
    const t = await renderParts({ mode: 'plan' })
    const card = await screen.findByRole('dialog', { name: 'Plan the part' })
    const field = within(card).getByRole('combobox', { name: 'Part' })
    expect(field).toHaveTextContent('Bracket')
    await expectNoAxeViolations()
    // choosing the part shows it (the Design part follows) and plans it
    t.shell.ui.getState().setDesignPart(t.lid!)
    await waitFor(() => expect(field).toHaveTextContent('Lid'))
    const create = within(card).getByRole('button', { name: 'Create plan' })
    await waitFor(() => expect(create).toBeEnabled())
    await t.user.click(create)
    await waitFor(() => expect(Object.keys(t.s.d.doc.plans)).toHaveLength(1))
    expect(t.callsOf('plan.create')).toEqual([
      { partId: t.lid, machineLibraryItemId: t.s.machineId },
    ])
  })

  it('names each plan with its part and offers New plan per part', async () => {
    const t = await renderParts({ mode: 'plan', plan: 'bracket' })
    const picker = await within(t.nav()).findByRole('combobox', { name: 'Plan' })
    expect(picker).toHaveTextContent('Plan 1 · Bracket')
    within(t.nav()).getByRole('button', { name: 'Plan actions' }).focus()
    await t.user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu', { name: 'Plan actions' })
    const group = within(menu).getByRole('group', { name: 'New plan for' })
    expect(
      within(group)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Bracket', 'Lid'])
    await expectNoAxeViolations()
    await t.user.click(within(group).getByRole('menuitem', { name: 'Lid' }))
    await waitFor(() => expect(Object.keys(t.s.d.doc.plans)).toHaveLength(2))
    expect(t.callsOf('plan.create').at(-1)).toMatchObject({ partId: t.lid })
    // the new plan is shown (its view remounts per plan)
    await waitFor(() =>
      expect(within(t.nav()).getByRole('combobox', { name: 'Plan' })).toHaveTextContent(
        'Plan 2 · Lid',
      ),
    )
  })
})
