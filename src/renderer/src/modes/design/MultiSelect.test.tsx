// Multi-select in the Design navigator (hardening DF135) against the fake bridge bound to a real
// project runtime: Cmd/Ctrl-click toggles, Shift-click selects a range, Shift+↓ extends, Escape
// clears; the inspector shows "N items selected" with the bulk actions; a selected row's menu acts
// on all of them – Mark as already cut, Disable, Remove – each one undo step; a refused Remove
// removes nothing. Plus the pure helpers. The canvas is stubbed.
// Doc: docs/conventions/ui.md#multi-select-in-the-design-navigator-df135
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import type { PartDTO } from '../../../../core/design/part.dto'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge, designDispatcher, type FakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { bulkPlan, rangeOf, toggled } from './multi-select'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

const ui = { kind: 'ui', id: 'test' } as const
const partId = (d: Dispatcher) => Object.keys(d.doc.parts)[0]!

const pocket = (d: Dispatcher, x: string, on = 'stock.top') =>
  d.dispatch(
    'design.pocket.add',
    {
      partId: partId(d),
      on,
      shape: { kind: 'rectangle', center: [x, '30'], length: '16', width: '12' },
      depth: '4',
    },
    ui,
  )

async function renderDesign(setup: (d: Dispatcher) => Promise<void>) {
  const bridge: FakeBridge = createFakeBridge()
  const d = await designDispatcher()
  const stock = await d.dispatch(
    'library.stock.add',
    {
      values: {
        name: 'Block',
        shape: 'block',
        length: '100',
        width: '60',
        thickness: '20',
        material: { name: '6061-T6', class: 'aluminum' },
      },
    },
    ui,
  )
  await d.dispatch(
    'design.part.add',
    { name: 'Bracket', stockLibraryItemId: (stock.unwrap().value as { id: string }).id },
    ui,
  )
  await setup(d)
  bridge.bind(d, 'p1', { file: '/p/bracket.dfyom' })
  const r = renderUi(
    <ShellProvider shell={createShell(bridge)}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const part = (): PartDTO => Object.values(d.doc.parts)[0]!
  return { ...r, d, part }
}

const navigator = () => screen.getByRole('navigation', { name: 'Navigator' })
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
const row = (name: string) =>
  within(navigator()).findByRole('button', { name: new RegExp(`^${name}`) })
const threePockets = async (d: Dispatcher) => {
  for (const x of ['20', '50', '80']) (await pocket(d, x)).unwrap()
}

describe('multi-select helpers', () => {
  const order = ['a', 'b', 'c', 'd']
  it('toggles in design order and selects ranges either way', () => {
    expect(toggled(order, ['c'], 'a')).toEqual(['a', 'c'])
    expect(toggled(order, ['a', 'c'], 'a')).toEqual(['c'])
    expect(rangeOf(order, 'c', 'a')).toEqual(['a', 'b', 'c'])
    expect(rangeOf(order, 'gone', 'b')).toEqual(['b'])
  })
  it('plans each bulk change as one new list; disabled items are not marked', () => {
    const off = {
      operations: new Set(['b']),
      features: new Set<string>(),
      roots: new Set(['b']),
      dependants: new Set<string>(),
    }
    const p = bulkPlan(['a', 'b', 'c'], ['c'], ['b'], off)
    expect(p.markCut).toEqual({ list: ['c', 'a'], count: 1 })
    expect(p.unmarkCut).toEqual({ list: [], count: 1 })
    expect(p.disable).toEqual({ list: ['b', 'a', 'c'], count: 2 })
    expect(p.enable).toEqual({ list: [], count: 1 })
    expect(p.removeOrder).toEqual(['c', 'b', 'a'])
  })
})

describe('Design navigator multi-select (DF135)', () => {
  it('Cmd/Ctrl-click toggles, Shift-click selects a range, Shift+↓ extends, Escape clears', async () => {
    const { user } = await renderDesign(threePockets)
    const [p1, p2, p3] = [await row('Pocket 1'), await row('Pocket 2'), await row('Pocket 3')]
    await user.click(p1)
    expect(p1).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard('{Control>}')
    await user.click(p3)
    await user.keyboard('{/Control}')
    expect([p1, p2, p3].map((b) => b.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'true',
    ])
    expect(within(inspector()).getByRole('heading', { name: '2 items selected' })).toBeVisible()
    expect(
      within(within(inspector()).getByRole('list', { name: 'Selected items' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Pocket 1', 'Pocket 3'])
    expect(within(navigator()).getByText('2 items selected')).toHaveAttribute('aria-live')
    await expectNoAxeViolations()
    // Cmd-click again removes; one left is a plain single selection
    await user.keyboard('{Meta>}')
    await user.click(p1)
    await user.keyboard('{/Meta}')
    expect(p1).toHaveAttribute('aria-pressed', 'false')
    expect(within(inspector()).getByRole('heading', { name: 'Pocket 3' })).toBeVisible()
    // Shift-click: the range from the anchor (Pocket 3) up to Pocket 1
    await user.keyboard('{Shift>}')
    await user.click(p1)
    await user.keyboard('{/Shift}')
    expect(within(inspector()).getByRole('heading', { name: '3 items selected' })).toBeVisible()
    // a plain click selects one; Shift+↓ extends to the next row
    await user.click(p1)
    expect(within(inspector()).getByRole('heading', { name: 'Pocket 1' })).toBeVisible()
    expect(p1).toHaveAttribute('aria-keyshortcuts', expect.stringContaining('Shift+ArrowDown'))
    p1.focus()
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    expect(p2).toHaveFocus()
    expect(within(inspector()).getByRole('heading', { name: '2 items selected' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect([p1, p2, p3].every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true)
    expect(within(inspector()).getByRole('heading', { name: 'Part' })).toBeVisible()
  })

  it("a selected row's menu acts on all of them, each one undo step", async () => {
    const { user, part, d } = await renderDesign(threePockets)
    const [p1, p2] = [await row('Pocket 1'), await row('Pocket 2')]
    await user.click(p1)
    p1.focus()
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    const steps = () => d.history.undoable.length
    const before = steps()
    p2.focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    let menu = await screen.findByRole('menu', { name: 'Actions for 2 items' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Mark 2 as already cut', 'Disable 2', 'Remove 2 items'])
    await expectNoAxeViolations()
    await user.click(within(menu).getByRole('menuitem', { name: 'Mark 2 as already cut' }))
    await waitFor(() => expect(part().alreadyCut).toEqual(['pocket1', 'pocket2']))
    expect(steps()).toBe(before + 1)
    // the selection stays; the inspector offers the opposite now
    expect(
      within(inspector()).getByRole('button', { name: 'Mark 2 as not cut' }),
    ).toBeInTheDocument()
    await user.click(within(inspector()).getByRole('button', { name: 'Disable 2' }))
    await waitFor(() => expect(part().disabled).toEqual(['pocket1', 'pocket2']))
    expect(steps()).toBe(before + 2)
    await user.click(within(inspector()).getByRole('button', { name: 'Enable 2' }))
    await waitFor(() => expect(part().disabled ?? []).toEqual([]))
    // Remove 2 items: one compound gesture, one undo step, the undo toast
    p1.focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    menu = await screen.findByRole('menu', { name: 'Actions for 2 items' })
    await user.click(within(menu).getByRole('menuitem', { name: 'Remove 2 items' }))
    await waitFor(() => expect(part().operations.map((o) => o.id)).toEqual(['pocket3']))
    expect(steps()).toBe(before + 4)
    expect(await screen.findByText('Removed 2 items')).toBeVisible()
    expect(within(inspector()).getByRole('heading', { name: 'Part' })).toBeVisible()
    expectOkUndo(await d.dispatch('history.undo', {}, ui))
    expect(part().operations.map((o) => o.id)).toEqual(['pocket1', 'pocket2', 'pocket3'])
    expect(part().alreadyCut).toEqual(['pocket1', 'pocket2'])
  })

  it('a refused Remove removes nothing and says why', async () => {
    const { user, part, d } = await renderDesign(async (dd) => {
      ;(await pocket(dd, '20')).unwrap()
      ;(await pocket(dd, '70')).unwrap()
      // Pocket 3 sits on Pocket 1's floor: removing Pocket 1 without it is refused
      ;(await pocket(dd, '20', 'pocket1.floor')).unwrap()
    })
    const before = d.history.undoable.length
    const p1 = await row('Pocket 1')
    await user.click(p1)
    p1.focus()
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    await user.keyboard('{Delete}')
    // shown under the list (and announced)
    expect(
      (await within(navigator()).findAllByText(/^Nothing removed: Pocket 3 uses Pocket 1 floor/))
        .length,
    ).toBeGreaterThan(0)
    expect(part().operations).toHaveLength(3)
    expect(d.history.undoable).toHaveLength(before)
  })
})

function expectOkUndo(r: { isOk(): boolean }): void {
  expect(r.isOk()).toBe(true)
}
