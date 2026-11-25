// Feature UI in design mode (v0.4 task U1) against the fake bridge bound to a real project
// runtime: the Add menu's groups (kinds without "Add", Bolt hole, tooltips; DF16–DF18), feature
// rows collapsed by default with nested owned operations (keyboard: → / ←, Alt+↑/↓ moving the
// whole block), the rolled-up badge, remove with its toast, the read-only owned-operation
// inspector ("Edited through Bolt hole 1", read-only fields with the reason, focusing the feature's
// driving field), and a Clones row with its Source and Clones groups. The canvas is stubbed.
// Doc: docs/conventions/ui.md#features-v04
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import type { PartDTO } from '../../../../core/design/part.dto'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge, designDispatcher, type FakeBridge } from '../../test/bridge'
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

const ui = { kind: 'ui', id: 'test' } as const

async function renderDesign(setup?: (d: Dispatcher) => Promise<void>) {
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
  await setup?.(d)
  bridge.bind(d, 'p1', { file: '/p/bracket.dfyom' })
  const r = renderUi(
    <ShellProvider shell={createShell(bridge)}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const part = (): PartDTO => Object.values(d.doc.parts)[0]!
  const openAdd = async () => {
    within(navigator()).getByRole('button', { name: 'Add' }).focus()
    await r.user.keyboard('{Enter}')
    return screen.findByRole('menu')
  }
  return { ...r, bridge, d, part, openAdd }
}

const navigator = () => screen.getByRole('navigation', { name: 'Navigator' })
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
const partId = (d: Dispatcher) => Object.keys(d.doc.parts)[0]!

const addCounterbore = async (d: Dispatcher) => {
  const r = await d.dispatch(
    'design.hole.add',
    { partId: partId(d), center: ['20', '20'], type: 'counterbore', fastener: 'M3' },
    ui,
  )
  r.unwrap()
}

describe('feature UI (U1)', () => {
  it('Add has Operations and Features groups named without "Add", with tooltips; Bolt hole adds and selects a collapsed feature row', async () => {
    const { user, openAdd, part } = await renderDesign()
    const menu = await openAdd()
    const ops = within(menu).getByRole('group', { name: 'Operations' })
    // DF16/DF17: kinds alone; Chamfer and Make Clones… are in the row menu
    const labels = (group: HTMLElement) =>
      within(group)
        .getAllByRole('menuitem')
        .map((i) => i.querySelector('span')?.textContent)
    expect(labels(ops)).toEqual(['Facing', 'Pocket', 'Profile', 'Drilling'])
    const features = within(menu).getByRole('group', { name: 'Features' })
    expect(labels(features)).toEqual(['Bolt hole', 'Pattern'])
    expect(within(menu).queryByRole('menuitem', { name: /Chamfer|Make Clones/ })).toBeNull()
    // DF18: the focused item's one-line description as a tooltip
    const facing = within(ops).getByRole('menuitem', { name: 'Facing' })
    expect(facing).toHaveFocus()
    expect(facing).toHaveAttribute('data-highlighted')
    expect(facing).toHaveAccessibleDescription('Flattens the stock top to an even height.')
    await expectNoAxeViolations()
    await user.click(within(features).getByRole('menuitem', { name: 'Bolt hole' }))

    await waitFor(() => expect(part().features).toHaveLength(1))
    const row = await within(navigator()).findByRole('button', {
      name: 'Bolt hole 1, Ø 6 mm simple, 1 operation',
    })
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(within(inspector()).getByRole('heading', { name: 'Bolt hole 1' })).toBeInTheDocument()
    // collapsed: the owned row sits in an inert group (out of the tab order and the a11y tree;
    // jsdom does not apply `inert` to role queries)
    const owned = within(navigator()).getByRole('button', { name: /edited through Bolt hole 1/ })
    expect(owned.closest('[inert]')).not.toBeNull()
  })

  it('expands by keyboard, walks into the owned rows and shows the read-only owned inspector', async () => {
    const { user } = await renderDesign(addCounterbore)
    const row = await within(navigator()).findByRole('button', {
      name: /^Bolt hole 1, M3 counterbore/,
    })
    row.focus()
    await user.keyboard('{ArrowRight}')
    expect(row).toHaveAttribute('aria-expanded', 'true')
    const cb = within(navigator()).getByRole('button', {
      name: 'Bolt hole 1 · counterbore, edited through Bolt hole 1',
    })
    // the role name drops the "Bolt hole 1 · " prefix
    expect(cb).toHaveTextContent(/^counterbore/)
    // rows show names, never ids (DF25 re-report: "c… hole1_counterbore")
    expect(
      within(navigator()).getByRole('list', { name: 'Operations in design order' }),
    ).not.toHaveTextContent(/hole1/)
    // owned rows have no remove (DF70: no row has a Remove button; Delete does nothing here)
    expect(within(navigator()).queryByRole('button', { name: /^Remove / })).toBeNull()
    expect(cb).not.toHaveAttribute('aria-keyshortcuts', expect.stringContaining('Delete'))
    await user.keyboard('{ArrowRight}')
    expect(cb).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    const drill = within(navigator()).getByRole('button', {
      name: 'Bolt hole 1 · drill, edited through Bolt hole 1',
    })
    expect(drill).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(row).toHaveFocus()
    await user.click(cb)

    const insp = inspector()
    expect(
      within(insp).getByRole('heading', { name: 'Bolt hole 1 · counterbore' }),
    ).toBeInTheDocument()
    const crumbs = within(insp).getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getByRole('button', { name: 'counterbore' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(insp).getByText(/^Edited through/)).toBeInTheDocument()
    const diameter = within(insp).getByLabelText('Diameter', { selector: 'input' })
    expect(diameter).toHaveAttribute('readonly')
    expect(diameter).toHaveAccessibleDescription(
      /Part of Bolt hole 1: change it in the bolt hole\./,
    )
    // name and tool stay editable (A4)
    expect(within(insp).getByLabelText('Name', { selector: 'input' })).not.toHaveAttribute(
      'readonly',
    )
    expect(within(insp).getByRole('combobox', { name: 'Tool' })).toBeInTheDocument()
    await expectNoAxeViolations()

    // "Edited through Bolt hole 1" selects the feature and focuses the field behind the first one shown
    const note = within(insp).getByText(/^Edited through/)
    await user.click(within(note).getByRole('button', { name: 'Bolt hole 1' }))
    expect(
      await within(inspector()).findByRole('heading', { name: 'Bolt hole 1' }),
    ).toBeInTheDocument()
    // the hole inspector (U2) focuses the Centre X input
    await waitFor(() =>
      expect(document.activeElement?.closest('[data-feature-field]')).toHaveAttribute(
        'data-feature-field',
        'center.0',
      ),
    )
    expect(document.activeElement).toHaveAccessibleName('Centre X')
  })

  it('moves the whole block over a neighbour, keeps focus on the owned row, removes with a toast', async () => {
    const { user, d, part } = await renderDesign(async (d) => {
      await d.dispatch(
        'design.pocket.add',
        {
          partId: partId(d),
          shape: { kind: 'circle', center: ['60', '30'], diameter: '20' },
          depth: '5',
        },
        ui,
      )
      await addCounterbore(d)
    })
    const row = await within(navigator()).findByRole('button', {
      name: /^Bolt hole 1, M3 counterbore/,
    })
    await user.click(within(row).getByTitle('Expand Bolt hole 1'))
    const drill = within(navigator()).getByRole('button', { name: /^Bolt hole 1 · drill/ })
    drill.focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    await waitFor(() =>
      expect(part().operations.map((o) => o.id)).toEqual([
        'hole1_counterbore',
        'hole1_drill',
        'pocket1',
      ]),
    )
    await waitFor(() =>
      expect(
        within(navigator()).getByRole('button', { name: /^Bolt hole 1 · drill/ }),
      ).toHaveFocus(),
    )
    // moving the pocket up steps over the whole block
    within(navigator())
      .getByRole('button', { name: /^Pocket 1/ })
      .focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    await waitFor(() => expect(part().operations[0]!.id).toBe('pocket1'))

    // Delete on the feature row removes it (DF70)
    within(navigator())
      .getByRole('button', { name: /^Bolt hole 1,/ })
      .focus()
    await user.keyboard('{Delete}')
    await waitFor(() => expect(part().features).toBeUndefined())
    expect(await findToastAction('Undo')).toBeInTheDocument()
    expect(screen.getByText('Removed Bolt hole 1 and its 2 operations')).toBeInTheDocument()
    expect(d.doc.parts).toBeDefined()
  })

  it('nested rows of a Clones of a hole show their long names whole, without ids (DF25 re-report)', async () => {
    const long = 'Lid hinge counterbore for the left side of the enclosure'
    const { user, d } = await renderDesign(async (d) => {
      await addCounterbore(d)
      const hole = Object.values(d.doc.parts)[0]!.features![0]!
      ;(
        await d.dispatch(
          'design.hole.update',
          { partId: partId(d), featureId: hole.id, name: long },
          ui,
        )
      ).unwrap()
      ;(
        await d.dispatch(
          'design.clones.add',
          {
            partId: partId(d),
            source: { featureId: hole.id },
            rows: [{ kind: 'grid', cols: 2, rows: 1, du: '30', dv: '20' }],
          },
          ui,
        )
      ).unwrap()
    })
    const clones = await within(navigator()).findByRole('button', { name: /^Clones 1,/ })
    clones.focus()
    await user.keyboard('{ArrowRight}')
    const source = within(navigator()).getByRole('list', { name: 'Source of Clones 1' })
    const hole = within(source).getByRole('button', { name: new RegExp(`^${long},`) })
    hole.focus()
    await user.keyboard('{ArrowRight}')
    const owned = within(navigator()).getByRole('list', { name: long })
    const rows = within(owned).getAllByRole('button')
    expect(rows.map((r) => r.textContent)).toEqual(['counterbore', 'drill'])
    // the hole row's text is its name and read-out, its button holds no id
    expect(hole).toHaveTextContent(new RegExp(`^${long}`))
    const ids = Object.values(d.doc.parts)[0]!.operations.map((o) => o.id)
    const list = within(navigator()).getByRole('list', { name: 'Operations in design order' })
    for (const id of ids) expect(list).not.toHaveTextContent(id)
    await expectNoAxeViolations()
  })

  it('Make Clones… from the row menu (Shift+F10) clones the pocket; the Clones row nests Source and Clones', async () => {
    const { user, part } = await renderDesign(async (d) => {
      await d.dispatch(
        'design.pocket.add',
        {
          partId: partId(d),
          shape: { kind: 'circle', center: ['20', '30'], diameter: '10' },
          depth: '5',
        },
        ui,
      )
    })
    // DF16: Shift+F10 on the row opens its menu: Chamfer (a circle pocket's edge), Make Clones…
    const pocket = await within(navigator()).findByRole('button', { name: /^Pocket 1/ })
    pocket.focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    const menu = await screen.findByRole('menu', { name: 'Actions for Pocket 1' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Chamfer', 'Make Clones…', 'Disable', 'Remove'])
    await user.click(within(menu).getByRole('menuitem', { name: 'Make Clones…' }))
    expect(pocket).toHaveAttribute('aria-pressed', 'true')
    // the draft (U3) writes nothing until Make clones
    const makeButton = await within(inspector()).findByRole('button', { name: 'Make clones' })
    expect(part().features ?? []).toHaveLength(0)
    await user.click(makeButton)
    await waitFor(() => expect(part().features?.[0]?.kind).toBe('clones'))
    const row = await within(navigator()).findByRole('button', { name: /^Clones 1, ×2/ })
    expect(row).toHaveAttribute('aria-pressed', 'true')
    row.focus()
    await user.keyboard('{ArrowRight}')
    const source = within(navigator()).getByRole('list', { name: 'Source of Clones 1' })
    expect(within(source).getByRole('button', { name: /^Pocket 1/ })).toBeInTheDocument()
    const group = within(navigator()).getByRole('button', { name: /^1 clone$/ })
    expect(group).toHaveAttribute('aria-expanded', 'false')
    await user.click(group)
    const instances = within(navigator()).getByRole('list', { name: 'Instances of Clones 1' })
    expect(within(instances).getByText('Clone 2')).toBeInTheDocument()
    // the source pocket (10 mm) plus a gap of its tool's diameter along u (U3)
    // axes and unit named (DF44): X and Y on the top face
    expect(within(instances).getByText(/^X \d+\.\d{2} · Y 30\.00 mm$/)).toBeInTheDocument()
    // the Operations count is the rows shown; its tooltip says what else it holds (DF44)
    const count = within(navigator()).getByTitle(/^1 row in the list/)
    expect(count).toHaveTextContent(/^1$/)
    expect(count).toHaveAttribute(
      'title',
      "1 row in the list; 2 operations in all, counting each hole's operations and every clone.",
    )
    await expectNoAxeViolations()
  })
})
