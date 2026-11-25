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
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
import type { Region2dPort } from '../../../../core/geometry/2d/port'
import { Ok } from '../../../../shared/result'

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

async function renderDesign(setup?: (d: Dispatcher) => Promise<void>, port?: Region2dPort) {
  const bridge: FakeBridge = createFakeBridge()
  const d = await designDispatcher(
    undefined,
    undefined,
    port === undefined ? {} : { region2d: port },
  )
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
    <ShellProvider
      shell={createShell(bridge, port === undefined ? {} : { region2d: Promise.resolve(Ok(port)) })}
    >
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
  it('Chamfer is in the row menu of edges only, not in the Add menu (DF16)', async () => {
    const { user, openAdd } = await renderDesign(async (d) => {
      ;(await d.dispatch('design.facing.add', { partId: partId(d), depth: '0.5' }, ui)).unwrap()
      await addEdges(d)
    })
    const add = await openAdd()
    expect(within(add).queryByRole('menuitem', { name: /Chamfer/ })).toBeNull()
    await user.keyboard('{Escape}')
    // a facing: neither Chamfer nor Make Clones…, only Disable and Remove
    const facing = await within(navigator()).findByRole('button', { name: /^Facing 1/ })
    await user.pointer({ keys: '[MouseRight]', target: facing })
    const menu = await screen.findByRole('menu', { name: 'Actions for Facing 1' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Disable', 'Remove'])
    await user.keyboard('{Escape}')
    // focus goes back to the row
    await waitFor(() => expect(facing).toHaveFocus())
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

  it('adds a chamfer on a drilling from its row menu and edits it in its inspector', async () => {
    const { user, part, chamfer } = await renderDesign(addEdges)
    // right-click on the drilling's row (DF16)
    const drilling = await within(navigator()).findByRole('button', { name: /^Drilling 1/ })
    await user.pointer({ keys: '[MouseRight]', target: drilling })
    const menu = await screen.findByRole('menu', { name: 'Actions for Drilling 1' })
    await expectNoAxeViolations()
    await user.click(within(menu).getByRole('menuitem', { name: 'Chamfer' }))

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

  it('disables a pocket with its chamfer from the row menu, and enables it back (DF106)', async () => {
    const { user, part } = await renderDesign(async (d) => {
      const id = partId(d)
      ;(
        await d.dispatch(
          'design.pocket.add',
          {
            partId: id,
            shape: { kind: 'circle', center: ['30', '30'], diameter: '10' },
            depth: '3',
          },
          ui,
        )
      ).unwrap()
      ;(await d.dispatch('design.chamfer.add', { partId: id, edgeOf: 'pocket1' }, ui)).unwrap()
    })
    const pocket = await within(navigator()).findByRole('button', { name: /^Pocket 1/ })
    await user.pointer({ keys: '[MouseRight]', target: pocket })
    let menu = await screen.findByRole('menu', { name: 'Actions for Pocket 1' })
    await user.click(within(menu).getByRole('menuitem', { name: 'Disable' }))
    await waitFor(() => expect(part().disabled).toEqual(['pocket1']))
    // both rows stay, muted with "Off"; the chamfer follows its edge
    const chamferRow = within(navigator()).getByRole('button', { name: /^Chamfer 1/ })
    expect(pocket).toHaveTextContent(/Off/)
    expect(chamferRow).toHaveTextContent(/Off: it builds on a disabled item/)
    expect(pocket.closest('[data-off]')).not.toBeNull()
    // nothing builds on a disabled row: no Chamfer, no Make Clones…
    await user.pointer({ keys: '[MouseRight]', target: pocket })
    menu = await screen.findByRole('menu', { name: 'Actions for Pocket 1' })
    expect(within(menu).queryByRole('menuitem', { name: 'Chamfer' })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: /Make Clones/ })).toBeNull()
    await user.click(within(menu).getByRole('menuitem', { name: 'Enable' }))
    await waitFor(() => expect(part()).not.toHaveProperty('disabled'))
    expect(pocket.closest('[data-off]')).toBeNull()
  })

  it('chamfers a rectangle pocket from its row menu: Edge by name, Depth, no Diameter (edge chamfers E1)', async () => {
    const { user, part, chamfer } = await renderDesign(async (d) => {
      ;(
        await d.dispatch(
          'design.pocket.add',
          {
            partId: partId(d),
            shape: { kind: 'rectangle', center: ['50', '30'], length: '40', width: '20' },
            depth: '4',
          },
          ui,
        )
      ).unwrap()
    })
    const pocket = await within(navigator()).findByRole('button', { name: /^Pocket 1/ })
    await user.pointer({ keys: '[MouseRight]', target: pocket })
    const menu = await screen.findByRole('menu', { name: 'Actions for Pocket 1' })
    await user.click(within(menu).getByRole('menuitem', { name: 'Chamfer' }))
    await waitFor(() => expect(chamfer()).toBeDefined())
    expect(chamfer().edgeOf).toBe(part().operations[0]!.id)
    const edge = within(inspector()).getByRole('combobox', { name: 'Edge' })
    // E3: the edge by name and role
    expect(edge).toHaveTextContent(/^Pocket 1 · rim$/)
    expect(input('Width').value).toMatch(/^0\.5/)
    expect(input('Depth').value).toMatch(/^0\.5/)
    expect(within(inspector()).queryByLabelText('Diameter', { selector: 'input' })).toBeNull()
    // E3: the wall section, no diameter in it
    const section = within(inspector()).getByRole('img', { name: /^Section: chamfer/ })
    expect(section).toHaveAccessibleName(
      'Section: chamfer 0.5 mm wide at 90°, 0.5 mm deep, along the wall of Pocket 1, 4 mm deep.',
    )
    expect(document.querySelector('[data-part="diameter"]')).toBeNull()
    await user.click(input('Angle'))
    await waitFor(() =>
      expect(document.querySelector('[data-part="angle"]')).toHaveAttribute('data-state', 'active'),
    )
    await expectNoAxeViolations()
  })

  it('E4a: Corner lift on a general edge; Loops for a pocket with an island', async () => {
    const fs = (
      globalThis as unknown as {
        process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: string): Uint8Array } }
      }
    ).process.getBuiltinModule('node:fs')
    const port = loadRegion2dSync(
      fs.readFileSync('vendor/cavalier-contours/cavalier_contours.wasm'),
    ).expect('the vendored 2D module loads')
    const { user, chamfer } = await renderDesign(async (d) => {
      for (const [name, args] of [
        [
          'design.shape.add',
          {
            partId: partId(d),
            items: [
              { kind: 'rectangle', center: ['0', '0'], length: '40', width: '24' },
              { kind: 'circle', center: ['0', '0'], diameter: '8', op: 'subtract' },
            ],
          },
        ],
        [
          'design.pocket.add',
          {
            partId: partId(d),
            shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] },
            depth: '4',
          },
        ],
        ['design.chamfer.add', { partId: partId(d), edgeOf: 'pocket1' }],
      ] as const)
        (await d.dispatch(name, args, ui)).unwrap()
    }, port)
    const row = await within(navigator()).findByRole('button', { name: /^Chamfer 1/ })
    await user.click(row)
    const lift = await within(inspector()).findByRole('switch', { name: 'Corner lift' })
    expect(lift).not.toBeChecked()
    await user.click(lift)
    await waitFor(() => expect(chamfer().cornerLift).toBe(true))
    const loops = await within(inspector()).findByRole('list', { name: 'Loops' })
    const rim = within(loops).getByRole('checkbox', { name: 'Rim' })
    const island = within(loops).getByRole('checkbox', { name: 'Island 1' })
    expect(rim).toBeChecked()
    await user.click(island)
    await waitFor(() => expect(chamfer().loops).toEqual([0]))
    // the last checked loop cannot be unchecked
    await waitFor(() => expect(within(loops).getByRole('checkbox', { name: 'Rim' })).toBeDisabled())
    await user.click(within(loops).getByRole('checkbox', { name: 'Island 1' }))
    await waitFor(() => expect(chamfer().loops).toBeUndefined())
    await expectNoAxeViolations()
  })

  it('E4b: Side on a through outline chamfers its bottom edge; none on a pocket', async () => {
    const { user, chamfer } = await renderDesign(async (d) => {
      for (const [name, args] of [
        [
          'design.profile.add',
          {
            partId: partId(d),
            shape: { kind: 'rectangle', center: ['50', '30'], length: '80', width: '40' },
          },
        ],
        ['design.chamfer.add', { partId: partId(d), edgeOf: 'profile1' }],
      ] as const)
        (await d.dispatch(name, args, ui)).unwrap()
    })
    const row = await within(navigator()).findByRole('button', { name: /^Chamfer 1/ })
    await user.click(row)
    const side = await within(inspector()).findByRole('radiogroup', { name: 'Side' })
    const top = within(side).getByRole('radio', { name: 'Top edge' })
    expect(top).toHaveAttribute('data-state', 'on')
    await user.click(within(side).getByRole('radio', { name: 'Bottom edge' }))
    await waitFor(() => expect(chamfer().on).toBe('stock.bottom'))
    await expectNoAxeViolations()
  })

  it('shows dfm.chamferNoTool at the tool field with "New tool…" prefilled with a chamfer mill', async () => {
    const { user, chamfer } = await renderDesign(async (d) => {
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
    // the Menu key on the focused row (DF16; DF70: rows have no actions (…) button)
    ;(await within(navigator()).findByRole('button', { name: /^Pocket 1/ })).focus()
    await user.keyboard('{ContextMenu}')
    const menu = await screen.findByRole('menu', { name: 'Actions for Pocket 1' })
    await user.click(within(menu).getByRole('menuitem', { name: 'Chamfer' }))
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

  it('shows a chamfer’s dfm.reach at the tool field; the section stays neutral (U9 P1)', async () => {
    const { user } = await renderDesign(async (d) => {
      for (const [name, args] of [
        ['design.facing.add', { partId: partId(d), depth: '15' }],
        [
          'design.pocket.add',
          {
            partId: partId(d),
            on: 'facing1.floor',
            shape: { kind: 'rectangle', center: ['50', '30'], length: '30', width: '20' },
            depth: '2',
          },
        ],
        ['design.chamfer.add', { partId: partId(d), edgeOf: 'pocket1' }],
        [
          'library.tool.add',
          {
            values: {
              name: 'V-bit short',
              type: 'chamferMill',
              angle: '90',
              diameter: '6',
              fluteLength: '4',
              overallLength: '40',
              fluteCount: '2',
            },
            units: 'mm',
          },
        ],
      ] as const)
        (await d.dispatch(name, args, ui)).unwrap()
    })
    await user.click(await within(navigator()).findByRole('button', { name: /^Chamfer 1/ }))
    const tool = await within(inspector()).findByRole('region', { name: 'Tool' })
    expect(await within(tool).findByText(/No tool in the library reaches/)).toBeVisible()
    expect(within(inspector()).getAllByText(/No tool in the library reaches/)).toHaveLength(1)
    expect(within(tool).getByRole('button', { name: 'New tool…' })).toBeVisible()
    // a finding is not an invalid value: no part of the section is drawn red
    const section = within(inspector()).getByRole('img', { name: /^Section: chamfer/ })
    expect(section.querySelector('[data-state="invalid"]')).toBeNull()
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
    const row = await within(navigator()).findByRole('button', { name: /^Bolt hole 1,/ })
    row.focus()
    await user.keyboard('{ArrowRight}')
    await user.click(
      await within(navigator()).findByRole('button', {
        name: /countersink, edited through Bolt hole 1/,
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
