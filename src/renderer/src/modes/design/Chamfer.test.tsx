// The chamfer UI in design mode (v0.4 task U4) against the fake bridge bound to a real project
// runtime: the Add menu's Chamfer (disabled with its reason without an edge; on the selected
// drilling, circle pocket or inside circle profile, else the last one), the chamfer inspector (Edge with its options,
// Width, Depth as the alternative input, Angle, the read-only Diameter (D45), the section
// illustration with the focused field's part, one update per commit, a new edge keeping the
// width), `dfm.chamferNoTool` at the tool field
// with "New tool…" prefilled with a chamfer mill of that angle, and a countersink's owned chamfer
// shown read-only. The canvas is stubbed. Doc: docs/conventions/ui.md#chamfer-inspector
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import type { OperationDTO, PartDTO } from '../../../../core/design/part.dto'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge, designDispatcher, type FakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { chamferEdgeChoice } from './chamfer-view'

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
  const chamfer = () =>
    part().operations.find((o) => o.kind === 'chamfer') as Extract<
      OperationDTO,
      { kind: 'chamfer' }
    >
  const openAdd = async () => {
    within(navigator()).getByRole('button', { name: 'Add' }).focus()
    await r.user.keyboard('{Enter}')
    return screen.findByRole('menu')
  }
  return { ...r, bridge, d, part, chamfer, openAdd }
}

const navigator = () => screen.getByRole('navigation', { name: 'Navigator' })
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
const input = (label: string) =>
  within(inspector()).getByLabelText(label, { selector: 'input' }) as HTMLInputElement

/** Drilling 1 (Ø 3.4 through) and Pocket 1 (a circle Ø 10, 4 deep). */
const addEdges = async (d: Dispatcher) => {
  ;(
    await d.dispatch(
      'design.drilling.add',
      { partId: partId(d), center: ['20', '20'], diameter: '3.4' },
      ui,
    )
  ).unwrap()
  ;(
    await d.dispatch(
      'design.pocket.add',
      {
        partId: partId(d),
        shape: { kind: 'circle', center: ['60', '30'], diameter: '10' },
        depth: '4',
      },
      ui,
    )
  ).unwrap()
}

describe('chamfer UI (U4)', () => {
  it('Add chamfer is disabled with its reason while the part has no drilling, circle pocket or inside circle profile', async () => {
    const { openAdd } = await renderDesign()
    const menu = await openAdd()
    const item = within(menu).getByRole('menuitem', { name: 'Add chamfer' })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveAccessibleDescription(
      'Add a drilling, a circular pocket or a circular opening first: a chamfer breaks its edge.',
    )
  })

  it('chooses the selected edge, else the last one in design order', async () => {
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
      { name: 'P', stockLibraryItemId: (stock.unwrap().value as { id: string }).id },
      ui,
    )
    await addEdges(d)
    const part = Object.values(d.doc.parts)[0]!
    const [drill, pocket] = part.operations
    expect(chamferEdgeChoice(part, drill!.id)).toEqual({ ok: true, edgeOf: drill!.id })
    expect(chamferEdgeChoice(part, null)).toEqual({ ok: true, edgeOf: pocket!.id })
  })

  it('adds a chamfer on the selected drilling and edits it in its inspector', async () => {
    const { user, openAdd, part, chamfer } = await renderDesign(addEdges)
    await user.click(await within(navigator()).findByRole('button', { name: /^Drilling 1/ }))
    const menu = await openAdd()
    await user.click(within(menu).getByRole('menuitem', { name: 'Add chamfer' }))

    await waitFor(() => expect(chamfer()).toBeDefined())
    expect(chamfer().edgeOf).toBe(part().operations[0]!.id)
    expect(await within(inspector()).findByRole('heading', { name: 'Chamfer 1' })).toBeVisible()
    // Edge, Width (0.5 mm: edge Ø + 1 mm), Depth, Angle (90°), the derived Diameter (D45)
    const edge = within(inspector()).getByRole('combobox', { name: 'Edge' })
    expect(edge).toHaveTextContent('Drilling 1 · Ø 3.4 mm')
    expect(input('Width').value).toMatch(/^0\.5/)
    expect(input('Depth').value).toMatch(/^0\.5/)
    expect(input('Depth')).not.toHaveAttribute('readonly')
    expect(input('Angle').value).toMatch(/^90/)
    expect(input('Diameter')).toHaveValue('Ø 4.4 mm')
    expect(input('Diameter')).toHaveAttribute('readonly')
    expect(
      within(inspector()).getByRole('img', {
        name: 'Section: chamfer 0.5 mm wide at 90° (Ø 4.4 mm), 0.5 mm deep, on Drilling 1 Ø 3.4 mm through.',
      }),
    ).toBeInTheDocument()
    await expectNoAxeViolations()

    // the width is the stored size: one update per commit, the diameter follows
    await user.clear(input('Width'))
    await user.type(input('Width'), '1{Enter}')
    await waitFor(() => expect(chamfer().width.source).toMatch(/^1/))
    await waitFor(() => expect(input('Diameter')).toHaveValue('Ø 5.4 mm'))
    // the depth is the alternative: the core turns it into the width through the angle
    await user.clear(input('Depth'))
    await user.type(input('Depth'), '0.8{Enter}')
    await waitFor(() => expect(chamfer().width.source).toMatch(/^0\.8/))
    await waitFor(() => expect(input('Diameter')).toHaveValue('Ø 5 mm'))

    // the focused field's part is the amber line of the section
    await user.click(input('Angle'))
    await waitFor(() =>
      expect(document.querySelector('[data-part="angle"]')).toHaveAttribute('data-state', 'active'),
    )
    // one update per commit
    await user.clear(input('Angle'))
    await user.type(input('Angle'), '60{Enter}')
    await waitFor(() => expect(chamfer().angle.source).toBe('60'))
    // the width stays; the depth follows the angle
    expect(chamfer().width.source).toMatch(/^0\.8/)
    await waitFor(() => expect(input('Depth').value).not.toMatch(/^0\.8/))

    // the edge list: the earlier drilling and circle pocket; a new edge keeps the width
    edge.focus()
    await user.keyboard('{Enter}')
    const list = await screen.findByRole('listbox')
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Drilling 1 · Ø 3.4 mm', 'Pocket 1 · Ø 10 mm'])
    await user.click(within(list).getByRole('option', { name: 'Pocket 1 · Ø 10 mm' }))
    await waitFor(() => expect(chamfer().edgeOf).toBe(part().operations[1]!.id))
    expect(chamfer().width.source).toMatch(/^0\.8/)
    await waitFor(() => expect(input('Diameter')).toHaveValue('Ø 11.6 mm'))
  })

  it('shows dfm.chamferNoTool at the tool field with "New tool…" prefilled with a chamfer mill', async () => {
    const { user, openAdd, chamfer } = await renderDesign(async (d) => {
      await addEdges(d)
      ;(
        await d.dispatch(
          'library.tool.add',
          {
            values: {
              name: 'Flat 6',
              type: 'flatEndMill',
              diameter: '6',
              fluteLength: '20',
              overallLength: '50',
              fluteCount: '2',
            },
            units: 'mm',
          },
          ui,
        )
      ).unwrap()
    })
    const menu = await openAdd()
    await user.click(within(menu).getByRole('menuitem', { name: 'Add chamfer' }))
    await waitFor(() => expect(chamfer()).toBeDefined())
    const tool = await within(inspector()).findByRole('region', { name: 'Tool' })
    const message = await within(tool).findByText(/The library has no 90° chamfer mill/)
    expect(message).toBeVisible()
    // not at the angle field
    expect(within(inspector()).getAllByText(/The library has no 90° chamfer mill/)).toHaveLength(1)
    await user.click(within(tool).getByRole('button', { name: 'New tool…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New tool' })
    expect(within(dialog).getByRole('combobox', { name: 'Type' })).toHaveTextContent('Chamfer mill')
    expect(
      (within(dialog).getByLabelText('Included angle', { selector: 'input' }) as HTMLInputElement)
        .value,
    ).toMatch(/^90/)
  })

  it('shows a countersink’s chamfer read-only, edited through its hole', async () => {
    const { user } = await renderDesign(async (d) => {
      ;(
        await d.dispatch(
          'design.hole.add',
          { partId: partId(d), center: ['20', '20'], type: 'countersink', fastener: 'M3' },
          ui,
        )
      ).unwrap()
    })
    const row = await within(navigator()).findByRole('button', { name: /^Hole 1,/ })
    row.focus()
    await user.keyboard('{ArrowRight}')
    await user.click(
      await within(navigator()).findByRole('button', {
        name: /countersink, edited through Hole 1/,
      }),
    )
    expect(within(inspector()).getByRole('combobox', { name: 'Edge' })).toBeDisabled()
    expect(input('Width')).toHaveAttribute('readonly')
    expect(input('Depth')).toHaveAttribute('readonly')
    expect(input('Diameter')).toHaveAttribute('readonly')
    expect(input('Angle')).toHaveAttribute('readonly')
    expect(within(inspector()).getByRole('img', { name: /^Section: chamfer/ })).toBeInTheDocument()
    await expectNoAxeViolations()
  })
})
