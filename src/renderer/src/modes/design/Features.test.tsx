// Feature UI in design mode (v0.4 task U1) against the fake bridge bound to a real project
// runtime: the Add menu's groups (Hole, Make Clones… with its reason, Chamfer disabled), feature
// rows collapsed by default with nested owned operations (keyboard: → / ←, Alt+↑/↓ moving the
// whole block), the rolled-up badge, remove with its toast, the read-only owned-operation
// inspector ("Edited through Hole 1", read-only fields with the reason, focusing the feature's
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
  it('Add has Operations and Features groups; Hole adds and selects a collapsed feature row', async () => {
    const { user, openAdd, part } = await renderDesign()
    const menu = await openAdd()
    const ops = within(menu).getByRole('group', { name: 'Operations' })
    expect(
      within(ops)
        .getAllByRole('menuitem')
        .map((i) => i.getAttribute('aria-label') ?? i.textContent),
    ).toEqual(['Add facing', 'Add pocket', 'Add profile', 'Add drilling', 'Add chamfer'])
    const chamfer = within(ops).getByRole('menuitem', { name: 'Add chamfer' })
    expect(chamfer).toHaveAttribute('aria-disabled', 'true')
    const features = within(menu).getByRole('group', { name: 'Features' })
    const clones = within(features).getByRole('menuitem', { name: 'Make Clones…' })
    expect(clones).toHaveAttribute('aria-disabled', 'true')
    expect(clones).toHaveAccessibleDescription(
      'Select a hole, pocket, drilling, chamfer or inside profile to clone.',
    )
    await expectNoAxeViolations()
    await user.click(within(features).getByRole('menuitem', { name: 'Add hole' }))

    await waitFor(() => expect(part().features).toHaveLength(1))
    const row = await within(navigator()).findByRole('button', {
      name: 'Hole 1, Ø 6 mm simple, 1 operation',
    })
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(within(inspector()).getByRole('heading', { name: 'Hole 1' })).toBeInTheDocument()
    // collapsed: the owned row sits in an inert group (out of the tab order and the a11y tree;
    // jsdom does not apply `inert` to role queries)
    const owned = within(navigator()).getByRole('button', { name: /edited through Hole 1/ })
    expect(owned.closest('[inert]')).not.toBeNull()
  })

  it('expands by keyboard, walks into the owned rows and shows the read-only owned inspector', async () => {
    const { user } = await renderDesign(addCounterbore)
    const row = await within(navigator()).findByRole('button', { name: /^Hole 1, M3 counterbore/ })
    row.focus()
    await user.keyboard('{ArrowRight}')
    expect(row).toHaveAttribute('aria-expanded', 'true')
    const cb = within(navigator()).getByRole('button', {
      name: 'Hole 1 · counterbore, edited through Hole 1',
    })
    // the role name drops the "Hole 1 · " prefix
    expect(cb).toHaveTextContent(/^counterbore/)
    // owned rows have no actions
    expect(
      within(navigator()).queryByRole('button', { name: 'Remove Hole 1 · counterbore' }),
    ).toBeNull()
    await user.keyboard('{ArrowRight}')
    expect(cb).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    const drill = within(navigator()).getByRole('button', {
      name: 'Hole 1 · drill, edited through Hole 1',
    })
    expect(drill).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(row).toHaveFocus()
    await user.click(cb)

    const insp = inspector()
    expect(within(insp).getByRole('heading', { name: 'Hole 1 · counterbore' })).toBeInTheDocument()
    const crumbs = within(insp).getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getByRole('button', { name: 'counterbore' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(insp).getByText(/^Edited through/)).toBeInTheDocument()
    const diameter = within(insp).getByLabelText('Diameter', { selector: 'input' })
    expect(diameter).toHaveAttribute('readonly')
    expect(diameter).toHaveAccessibleDescription(/Part of Hole 1: change it in the hole\./)
    // name and tool stay editable (A4)
    expect(within(insp).getByLabelText('Name', { selector: 'input' })).not.toHaveAttribute(
      'readonly',
    )
    expect(within(insp).getByRole('combobox', { name: 'Tool' })).toBeInTheDocument()
    await expectNoAxeViolations()

    // "Edited through Hole 1" selects the feature and focuses the field behind the first one shown
    const note = within(insp).getByText(/^Edited through/)
    await user.click(within(note).getByRole('button', { name: 'Hole 1' }))
    expect(await within(inspector()).findByRole('heading', { name: 'Hole 1' })).toBeInTheDocument()
    // the hole inspector (U2) focuses the Center X input
    await waitFor(() =>
      expect(document.activeElement?.closest('[data-feature-field]')).toHaveAttribute(
        'data-feature-field',
        'center.0',
      ),
    )
    expect(document.activeElement).toHaveAccessibleName('Center X')
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
    const row = await within(navigator()).findByRole('button', { name: /^Hole 1, M3 counterbore/ })
    await user.click(within(row).getByTitle('Expand Hole 1'))
    const drill = within(navigator()).getByRole('button', { name: /^Hole 1 · drill/ })
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
      expect(within(navigator()).getByRole('button', { name: /^Hole 1 · drill/ })).toHaveFocus(),
    )
    // moving the pocket up steps over the whole block
    await user.click(within(navigator()).getByRole('button', { name: 'Move Pocket 1 up' }))
    await waitFor(() => expect(part().operations[0]!.id).toBe('pocket1'))

    await user.click(within(navigator()).getByRole('button', { name: 'Remove Hole 1' }))
    await waitFor(() => expect(part().features).toBeUndefined())
    expect(await findToastAction('Undo')).toBeInTheDocument()
    expect(screen.getByText('Removed Hole 1 and its 2 operations')).toBeInTheDocument()
    expect(d.doc.parts).toBeDefined()
  })

  it('Make Clones… clones the selected pocket; the Clones row nests Source and Clones', async () => {
    const { user, openAdd, part } = await renderDesign(async (d) => {
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
    await user.click(await within(navigator()).findByRole('button', { name: /^Pocket 1/ }))
    const menu = await openAdd()
    const make = within(menu).getByRole('menuitem', { name: 'Make Clones…' })
    expect(make).not.toHaveAttribute('aria-disabled')
    await user.click(make)
    await waitFor(() => expect(part().features?.[0]?.kind).toBe('clones'))
    const row = await within(navigator()).findByRole('button', { name: /^Clones 1, ×2/ })
    expect(row).toHaveAttribute('aria-pressed', 'true')
    row.focus()
    await user.keyboard('{ArrowRight}')
    const source = within(navigator()).getByRole('list', { name: 'Source of Clones 1' })
    expect(within(source).getByRole('button', { name: /^Pocket 1/ })).toBeInTheDocument()
    const group = within(navigator()).getByRole('button', { name: /^Clones\s*1$/ })
    expect(group).toHaveAttribute('aria-expanded', 'false')
    await user.click(group)
    const instances = within(navigator()).getByRole('list', { name: 'Instances of Clones 1' })
    expect(within(instances).getByText('Clone 2')).toBeInTheDocument()
    // the source pocket (10 mm) plus a 3 mm gap along u
    expect(within(instances).getByText('33.00, 30.00')).toBeInTheDocument()
    await expectNoAxeViolations()
  })
})
