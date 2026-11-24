// Shape Editor UI (task U1) against the fake bridge bound to a real dispatcher with the node 2D
// port: the Shapes dialog (D45), the inspector (one `design.shape.item.update` per field
// commit), handle drags in the flat view (one gesture per drag, a press within 4 px commits
// nothing, Escape undoes the gesture, a formula locks its handle), the segment table's keyboard
// grid, and accessibility. The 3D canvas is stubbed; jsdom boxes are empty, so the flat view is
// 800 × 600 px at the origin and a handle's screen point is its `translate`.
// Doc: docs/conventions/ui.md#shape-editor, docs/modes/design-v0.3.md#shape-definition
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import type { PartDTO } from '../../../../core/design/part.dto'
import type { ShapeDTO } from '../../../../core/design/shape.dto'
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
import { Ok } from '../../../../shared/result'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge, designDispatcher, type FakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { dragTo, gripOf, layOutRows } from '../../test/reorder'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

// jsdom's `import.meta.url` is not a file URL (testing/node-wasm.ts needs one): read the vendored
// module from the repository root
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: string): Uint8Array } }
  }
).process.getBuiltinModule('node:fs')
const port = loadRegion2dSync(
  fs.readFileSync('vendor/cavalier-contours/cavalier_contours.wasm'),
).expect('the vendored 2D module loads')

async function renderShapes() {
  const bridge: FakeBridge = createFakeBridge()
  const d: Dispatcher = await designDispatcher('Bracket', 'mm', { region2d: port })
  const src = { kind: 'ui', id: 'test' } as const
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
    src,
  )
  await d.dispatch(
    'design.part.add',
    { name: 'Bracket', stockLibraryItemId: (stock.unwrap().value as { id: string }).id },
    src,
  )
  bridge.bind(d, 'p1', { file: '/p/bracket.dfyom' })
  const shell = createShell(bridge, { region2d: Promise.resolve(Ok(port)) })
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  const part = (): PartDTO => Object.values(d.doc.parts)[0]!
  const shape = (n = 0): ShapeDTO => part().shapes![n]!
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  // adding selects the shape and closes the dialog, so the Shape Editor shows (D45)
  const addShape = async (kind: string) => {
    within(await shapesGroup())
      .getByRole('button', { name: 'Add shape' })
      .focus()
    await r.user.keyboard('{Enter}')
    await r.user.click(await screen.findByRole('menuitem', { name: kind }))
    await within(inspector()).findByRole('region', { name: 'Items' })
  }
  return { ...r, bridge, d, part, shape, addShape }
}

async function retype(
  user: {
    clear(e: Element): Promise<void>
    type(e: Element, t: string, o?: object): Promise<void>
  },
  el: HTMLElement,
  text: string,
): Promise<void> {
  await user.clear(el)
  await user.type(el, text, { skipClick: true })
}

/** The Shapes dialog (D45), opened from the toolbar's Part setup group unless it is open. */
async function shapesGroup(): Promise<HTMLElement> {
  const open = screen.queryByRole('dialog', { name: 'Shapes' })
  if (open !== null) return open
  const tools = screen.getByRole('toolbar', { name: 'Part setup' })
  act(() => within(tools).getByRole('button', { name: 'Shapes' }).click())
  return screen.findByRole('dialog', { name: 'Shapes' })
}
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
const editor = () => screen.getByRole('region', { name: 'Shape Editor' })
const field = (label: string) => within(inspector()).getByLabelText(label, { selector: 'input' })
const handle = (id: string) =>
  editor().querySelector<SVGGElement>(`[data-handle="${CSS.escape(id)}"]`)!

/** The handle's screen point (its `translate`). */
function at(el: Element): [number, number] {
  const m = /translate\(([-\d.e]+) ([-\d.e]+)\)/.exec(el.getAttribute('transform') ?? '')
  return [Number(m![1]), Number(m![2])]
}

/** Presses the handle and moves the pointer by each offset (px), then releases unless `hold`. */
function drag(id: string, moves: readonly [number, number][], hold = false): void {
  const el = handle(id)
  const [x, y] = at(el)
  fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: x, clientY: y })
  for (const [dx, dy] of moves)
    fireEvent.pointerMove(el, { pointerId: 1, clientX: x + dx, clientY: y + dy })
  if (!hold) fireEvent.pointerUp(el, { pointerId: 1, clientX: x, clientY: y })
}

const itemUpdates = (bridge: FakeBridge) =>
  bridge.calls.filter((c) => c.name === 'design.shape.item.update')

describe('shape editor', () => {
  it('adds a shape from the Shapes group: row, inspector, flat view', async () => {
    const { user, bridge, shape, addShape } = await renderShapes()
    expect(within(await shapesGroup()).getByText(/No shapes/)).toBeInTheDocument()
    await addShape('Rectangle')
    expect(screen.queryByRole('dialog', { name: 'Shapes' })).not.toBeInTheDocument()
    expect(bridge.calls.filter((c) => c.name === 'design.shape.add')).toHaveLength(1)
    expect(shape().items[0]).toMatchObject({ kind: 'rectangle', op: 'add' })
    const row = await within(await shapesGroup()).findByRole('button', {
      name: new RegExp(`^${shape().name}`),
    })
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(row).not.toHaveTextContent('Used by') // only a used shape says so
    // choosing the row closes the dialog and keeps the shape selected
    await user.click(row)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(field('Length')).toHaveValue('40')
    // the flat view covers the 3D viewport with the outline and the item's handles
    await waitFor(() => expect(editor().querySelector('[data-handle="length"]')).not.toBeNull())
    expect(within(editor()).getByText('Shape · Shape frame')).toBeInTheDocument()
    // the summary from design.shape.get
    expect(await within(inspector()).findByText('7.92 cm²')).toBeInTheDocument()
    expect(within(inspector()).getByText('40.00 × 20.00 mm')).toBeInTheDocument()
  })

  it('reorders items by their grip (D45): the item moved to the top adds', async () => {
    const { user, shape, addShape } = await renderShapes()
    await addShape('Rectangle')
    await user.click(within(inspector()).getByRole('button', { name: 'Add item' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Circle' }))
    await waitFor(() => expect(shape().items.map((i) => i.kind)).toEqual(['rectangle', 'circle']))
    const items = within(inspector()).getByRole('list', { name: 'Items in order' })
    expect(within(items).queryByRole('button', { name: /^Move / })).toBeNull()
    const restore = layOutRows()
    try {
      dragTo(gripOf(within(items).getByRole('button', { name: /^Circle 2/ })), 3)
      await waitFor(() =>
        expect(shape().items.map((i) => [i.kind, i.op])).toEqual([
          ['circle', 'add'],
          ['rectangle', 'add'],
        ]),
      )
      expect(await screen.findByText('Moved Circle 2 to position 1 of 2.')).toBeInTheDocument()
    } finally {
      restore()
    }
  })

  it('reaches shape and item row actions by keyboard (U2): Tab to Remove, Delete on a row', async () => {
    const { user, part, shape, addShape } = await renderShapes()
    await addShape('Rectangle')
    await addShape('Circle')
    await waitFor(() => expect(part().shapes).toHaveLength(2))
    // Shapes dialog: Remove is the row's next tab stop
    const dialog = await shapesGroup()
    const first = within(dialog).getByRole('button', { name: /^Shape 1/ })
    first.focus()
    await user.tab()
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Remove Shape 1' }),
    )
    // Delete on a row removes the shape; focus goes to the next row
    first.focus()
    await user.keyboard('{Delete}')
    await waitFor(() => expect(part().shapes?.map((s) => s.name)).toEqual(['Shape 2']))
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: /^Shape 2/ }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // item list: Delete on an item row removes it, focus stays in the list
    await user.click(within(inspector()).getByRole('button', { name: 'Add item' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Rectangle' }))
    await waitFor(() => expect(shape().items).toHaveLength(2))
    const items = within(inspector()).getByRole('list', { name: 'Items in order' })
    within(items)
      .getByRole('button', { name: /^Rectangle 2/ })
      .focus()
    await user.keyboard('{Delete}')
    await waitFor(() => expect(shape().items.map((i) => i.kind)).toEqual(['circle']))
    expect(document.activeElement).toBe(within(items).getByRole('button', { name: /^Circle 1/ }))
    // the last item stays: Delete does nothing
    await user.keyboard('{Delete}')
    expect(shape().items).toHaveLength(1)
  })

  it('commits a field as one design.shape.item.update and undoes it', async () => {
    const { user, bridge, shape, addShape } = await renderShapes()
    await addShape('Rectangle')
    await retype(user, field('Length'), '60{Enter}')
    await waitFor(() => expect(shape().items[0]).toMatchObject({ length: { source: '60' } }))
    expect(itemUpdates(bridge).at(-1)!.args).toMatchObject({ index: 0, length: '60' })
    await bridge.call('history.undo', {})
    await waitFor(() => expect(shape().items[0]).toMatchObject({ length: { source: '40' } }))
    await waitFor(() => expect(field('Length')).toHaveValue('40'))
  })

  it('shows a refused value at its field and keeps the stored one', async () => {
    const { user, shape, addShape } = await renderShapes()
    await addShape('Rectangle')
    const before = shape().items[0]
    await retype(user, field('Corner radius'), '30{Enter}')
    expect(
      await within(inspector()).findByText('Must be between 0 and half the narrowest size'),
    ).toBeInTheDocument()
    // the flat view marks the item and keeps the last valid outline
    await waitFor(() => expect(within(editor()).getByTestId('shape-invalid')).toBeInTheDocument())
    expect(shape().items[0]).toEqual(before)
  })

  it('drags a handle as one gesture; one undo step reverts it', async () => {
    const { bridge, shape, addShape } = await renderShapes()
    await addShape('Rectangle')
    await waitFor(() => expect(handle('length')).not.toBeNull())
    const before = shape().items[0]
    drag('length', [
      [10, 0],
      [20, 0],
      [40, 0],
    ])
    await waitFor(() => expect(shape().items[0]).not.toEqual(before))
    await waitFor(() => {
      const steps = itemUpdates(bridge)
      expect(steps.length).toBeGreaterThan(0)
      expect(new Set(steps.map((c) => c.gesture)).size).toBe(1)
      expect(steps[0]!.gesture).toEqual(expect.any(String))
    })
    const length = Number((shape().items[0] as { length: { source: string } }).length.source)
    expect(length).toBeGreaterThan(40)
    await bridge.call('history.undo', {})
    await waitFor(() => expect(shape().items[0]).toEqual(before))
  })

  it('commits nothing for a press that moves less than 4 px', async () => {
    const { bridge, addShape } = await renderShapes()
    await addShape('Rectangle')
    await waitFor(() => expect(handle('length')).not.toBeNull())
    drag('length', [
      [1, 1],
      [2, 1],
    ])
    await new Promise((r) => setTimeout(r, 150))
    expect(itemUpdates(bridge)).toHaveLength(0)
  })

  it('cancels a drag with Escape: the gesture is undone', async () => {
    const { bridge, shape, addShape } = await renderShapes()
    await addShape('Rectangle')
    await waitFor(() => expect(handle('width')).not.toBeNull())
    const before = shape().items[0]
    drag(
      'width',
      [
        [0, -10],
        [0, -30],
      ],
      true,
    )
    await waitFor(() => expect(itemUpdates(bridge).length).toBeGreaterThan(0))
    fireEvent.keyDown(editor(), { key: 'Escape' })
    await waitFor(() =>
      expect(bridge.calls.filter((c) => c.name === 'history.undo').at(-1)?.args).toEqual({
        gesture: itemUpdates(bridge)[0]!.gesture,
      }),
    )
    await waitFor(() => expect(shape().items[0]).toEqual(before))
    // still in the editor: Escape ended the drag, not the editor
    expect(editor()).toBeInTheDocument()
  })

  it('locks the handle of a value with a formula', async () => {
    const { user, bridge, addShape } = await renderShapes()
    await addShape('Rectangle')
    await retype(user, field('Length'), '30 + 20{Enter}')
    await waitFor(() => expect(handle('length')).toHaveAttribute('data-locked'))
    expect(handle('length')).toHaveAccessibleName(/Remove the formula to drag\./)
    const n = itemUpdates(bridge).length
    drag('length', [[30, 0]])
    await new Promise((r) => setTimeout(r, 150))
    expect(itemUpdates(bridge)).toHaveLength(n)
  })

  it('moves through the segment table with the keyboard and removes a row with Delete', async () => {
    const { user, bridge, shape, addShape } = await renderShapes()
    await addShape('Path')
    const grid = await within(inspector()).findByRole('grid', { name: /Segments of Path 1/ })
    const count = (shape().items[0] as { segments: unknown[] }).segments.length
    const first = within(grid).getAllByRole('gridcell')[0]!
    first.focus()
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(within(grid).getAllByRole('gridcell')[1])
    await user.keyboard('{ArrowLeft}{ArrowDown}')
    const rowCells = within(grid).getAllByRole('row').slice(1)
    expect(document.activeElement).toBe(within(rowCells[1]!).getAllByRole('gridcell')[0])
    await user.keyboard('{Delete}')
    await waitFor(() =>
      expect((shape().items[0] as { segments: unknown[] }).segments).toHaveLength(count - 1),
    )
    expect(itemUpdates(bridge).at(-1)!.args).toMatchObject({ index: 0 })
    expect(await screen.findByText('Removed segment 2')).toBeInTheDocument()
  })

  it("opens a segment row's actions by right-click and Shift+F10, with no button in the row (DF70)", async () => {
    const { user, shape, addShape } = await renderShapes()
    await addShape('Path')
    const grid = await within(inspector()).findByRole('grid', { name: /Segments of Path 1/ })
    expect(within(grid).queryByRole('button', { name: /^Actions for segment/ })).toBeNull()
    expect(grid).toHaveAccessibleDescription(/Right-click a row, or press Shift\+F10 on a cell/)
    const segs = () => (shape().items[0] as { segments: { to: unknown }[] }).segments
    const before = segs().map((x) => x.to)
    // the open menu hides the rest from the accessibility tree (modal), hence `hidden`
    const rows = () => within(grid).getAllByRole('row', { hidden: true }).slice(1)
    // right-click on row 3: its menu, the row selected
    await user.pointer({
      keys: '[MouseRight]',
      target: within(rows()[2]!).getAllByRole('gridcell')[2]!,
    })
    const menu = await screen.findByRole('menu', { name: 'Actions for segment 3' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Move segment 3 upAlt+↑', 'Move segment 3 downAlt+↓', 'Remove segment 3Delete'])
    expect(within(menu).getByRole('menuitem', { name: /^Move segment 3 down/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(rows()[2]).toHaveAttribute('aria-selected', 'true')
    await expectNoAxeViolations()
    await user.click(within(menu).getByRole('menuitem', { name: /^Remove segment 3/ }))
    await waitFor(() => expect(segs().map((x) => x.to)).toEqual(before.slice(0, 2)))
    expect(await screen.findByText('Removed segment 3')).toBeInTheDocument()
    // Shift+F10 on a cell of row 2: the same menu for that row; focus comes back to the cell
    const cell = within(rows()[1]!).getAllByRole('gridcell', { hidden: true })[0]!
    cell.focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    const menu2 = await screen.findByRole('menu', { name: 'Actions for segment 2' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(menu2).not.toBeInTheDocument())
    await waitFor(() => expect(cell).toHaveFocus())
  })

  it('has no axe violations in the navigator, inspector and flat view', async () => {
    const { container, addShape } = await renderShapes()
    await addShape('Path')
    await waitFor(() => expect(editor().querySelector('[data-handle]')).not.toBeNull())
    await expectNoAxeViolations(container)
  })
})
