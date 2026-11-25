// Design mode against the fake bridge bound to a real project runtime (design and library
// commands, in-memory library): stock setup, the operation navigator (add, select, move, remove),
// the inspector (one commit = one command = one undo step, errors and DFM warnings in place,
// Apply), pick mode, selection sync and the evaluation status. The viewport canvas is stubbed.
// Doc: docs/conventions/ui.md#testing, docs/modes/design.md
import { act, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import type { PartDTO } from '../../../../core/design/part.dto'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { expectOk } from '../../../../shared/testing/result'
import { createFakeBridge, designDispatcher, type FakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, findToastAction, renderUi } from '../../test/render'
import { dragTo, gripOf, layOutRows } from '../../test/reorder'
import { ADD_ITEMS, addItemLabel, addItemsFor, type AddSurface } from './add-items'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

async function renderDesign(withPart = true, seed?: (d: Dispatcher) => Promise<unknown>) {
  const bridge: FakeBridge = createFakeBridge()
  const d: Dispatcher = await designDispatcher()
  await seed?.(d)
  if (withPart) {
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
      { kind: 'ui', id: 'test' },
    )
    await d.dispatch(
      'design.part.add',
      { name: 'Bracket', stockLibraryItemId: (stock.unwrap().value as { id: string }).id },
      { kind: 'ui', id: 'test' },
    )
  }
  bridge.bind(d, 'p1', { file: '/p/bracket.dfyom' })
  const shell = createShell(bridge)
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  const part = (): PartDTO => Object.values(d.doc.parts)[0]!
  // test windows are narrow: the inspector is an overlay, opened by its toggle (without a part
  // the Stock dialog opened by itself and holds the focus, D45)
  if (withPart) await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const addFromMenu = async (label: string) => {
    within(navigator()).getByRole('button', { name: 'Add' }).focus()
    await r.user.keyboard('{Enter}')
    await r.user.click(await screen.findByRole('menuitem', { name: label }))
  }
  return { ...r, bridge, d, shell, part, addFromMenu }
}

/**
 * Types into a field without a pointer click: in jsdom every element has an empty box, so the
 * panel group's separator hit-test takes the pointer (and the focus).
 */
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

const navigator = () => screen.getByRole('navigation', { name: 'Navigator' })
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
const status = () => screen.getByRole('contentinfo', { name: 'Status bar' })

describe('design mode', () => {
  it('sets up the part from a new block of stock in the Stock dialog it opens by itself', async () => {
    const { user, d } = await renderDesign(false)
    // a project without a part opens the Stock dialog (D45)
    const dialog = await screen.findByRole('dialog', { name: 'Stock' })
    const form = within(dialog).getByRole('region', { name: 'Set up the part' })
    await expectNoAxeViolations()
    // the part is named after the project (DF12); no library stock is chosen (DF13)
    expect(within(form).getByRole('textbox', { name: 'Part name' })).toHaveValue('Bracket 1')
    expect(within(form).getByRole('combobox', { name: 'From library' })).toHaveTextContent(
      'Not selected',
    )
    // an empty library: nothing to choose, and the note says how to add one (DF48)
    expect(within(form).getByRole('combobox', { name: 'From library' })).toBeDisabled()
    expect(within(form).getByText(/No stock in the library yet/)).toBeVisible()
    const length = within(form).getByRole('combobox', { name: 'Length (X)' })
    await retype(user, length, '120{Enter}')
    // the primary Create part is in the footer beside Cancel, not in the body (DF12 re-report)
    const create = within(dialog).getByRole('button', { name: 'Create part' })
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' })
    expect(within(form).queryByRole('button', { name: 'Create part' })).toBeNull()
    expect(create.parentElement).toBe(cancel.parentElement)
    expect(create.parentElement!.lastElementChild).toBe(create)
    expect(create.parentElement!.contains(form)).toBe(false)
    await user.click(create)
    // Create part closes it; the sidebar starts with the part row, then the operations (DF15)
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    await within(navigator()).findByRole('heading', { name: 'No operations yet' })
    // the empty state offers the Add menu's items in its order: operations, then features (DF48,
    // DF98: the pattern too)
    const empty = within(navigator())
      .getAllByRole('button', { name: /^Add (facing|pocket|profile|drilling|bolt hole|pattern)$/ })
      .map((b) => b.textContent)
    expect(empty).toEqual([
      'Add facing',
      'Add pocket',
      'Add profile',
      'Add drilling',
      'Add bolt hole',
      'Add pattern',
    ])
    expect(
      within(navigator()).getByText('Add an operation or a feature to cut the stock.'),
    ).toBeVisible()
    expect(within(navigator()).getAllByRole('heading')[0]).toHaveTextContent('Operations')
    const partRow = within(navigator()).getByRole('region', { name: 'Part' })
    expect(
      partRow.compareDocumentPosition(within(navigator()).getAllByRole('heading')[0]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(within(navigator()).getByText(/^Stock: 120 × 60 × 20 · 6061-T6$/)).toBeInTheDocument()
    const part = Object.values(d.doc.parts)[0]!
    expect(part.name).toBe('Bracket 1')
    const snap = d.doc.snapshots[part.stock]!
    expect((snap.values as { length: { source: string } }).length.source).toBe('120')
    // the project's own block: nothing was added to the library (DF13)
    expect(snap.libraryItemId).toBeUndefined()
    expect(
      (
        expectOk(d.query('library.stock.list', {}, { kind: 'ui', id: 'test' })).value as {
          items: []
        }
      ).items,
    ).toHaveLength(0)
    // DF96: the own block is named after its material class and material, not "Block"
    expect((snap.values as { name: string }).name).toBe('Aluminium 6061-T6 120 × 60 × 20')
    // the read-out opens the Stock dialog again, now to change the stock (DF95)
    await user.click(within(navigator()).getByRole('button', { name: /^Stock: 120/ }))
    const again = await screen.findByRole('dialog', { name: 'Stock' })
    const change = within(again).getByRole('region', { name: 'Change the stock' })
    expect(within(change).getByRole('combobox', { name: 'Length (X)' })).toHaveValue('120')
    expect(within(change).getByText(/nothing is moved or clamped/)).toBeVisible()
    await expectNoAxeViolations()
    // nothing changed: Update stock just closes, no undo step
    const revision = d.revision
    await user.click(within(again).getByRole('button', { name: 'Update stock' }))
    await waitFor(() => expect(again).not.toBeInTheDocument())
    expect(d.revision).toBe(revision)
    // it opens by itself only once per project: undoing the part leaves the empty state
    await user.keyboard('{Control>}z{/Control}')
    await within(navigator()).findByRole('heading', { name: 'Set up the stock' })
    expect(screen.queryByRole('dialog', { name: 'Stock' })).not.toBeInTheDocument()
    await user.click(within(navigator()).getByRole('button', { name: 'Set up stock…' }))
    expect(await screen.findByRole('dialog', { name: 'Stock' })).toBeInTheDocument()
  })

  it('fills the block from a library stock; changed sizes save as a variant or update (DF13)', async () => {
    const ui = { kind: 'ui', id: 'test' } as const
    const values = {
      name: 'Aluminium plate 10',
      shape: 'block',
      length: '300',
      width: '200',
      thickness: '10',
      material: { name: '5083', class: 'aluminum' },
    }
    let root = { id: '' }
    const { user, d } = await renderDesign(false, async (d) => {
      root = (await d.dispatch('library.stock.add', { values }, ui)).unwrap().value as {
        id: string
      }
    })
    const dialog = await screen.findByRole('dialog', { name: 'Stock' })
    const form = within(dialog).getByRole('region', { name: 'Set up the part' })
    const from = await within(form).findByRole('combobox', { name: 'From library' })
    await user.click(from)
    await user.click(await screen.findByRole('option', { name: 'Aluminium plate 10' }))
    // the fields take its values; the material is shown but locked
    await waitFor(() =>
      expect(within(form).getByRole('combobox', { name: 'Length (X)' })).toHaveValue('300'),
    )
    expect(within(form).getByRole('textbox', { name: 'Material name' })).toHaveAttribute('readonly')
    expect(within(form).getByRole('combobox', { name: 'Material class' })).toBeDisabled()
    // unchanged: nothing to save
    expect(within(form).getByRole('button', { name: 'Save to library' })).toBeDisabled()
    await expectNoAxeViolations()
    // a cut piece: Save asks update or variant; the variant goes under the stock
    await retype(user, within(form).getByRole('combobox', { name: 'Length (X)' }), '150{Enter}')
    await user.click(within(form).getByRole('button', { name: 'Save to library' }))
    const ask = await screen.findByRole('dialog', { name: 'Save to library' })
    await expectNoAxeViolations()
    await user.click(within(ask).getByRole('button', { name: 'Save as variant' }))
    await waitFor(() => expect(ask).not.toBeInTheDocument())
    const list = () =>
      (
        expectOk(d.query('library.stock.list', {}, ui)).value as {
          items: { id: string; name: string; parentId?: string; length: { source: string } }[]
        }
      ).items
    await waitFor(() => expect(list()).toHaveLength(2))
    const variant = list().find((i) => i.parentId === root.id)!
    expect(variant.name).toBe('Aluminium plate 10 · 150 × 200 × 10')
    // the variant is chosen now, so Create part links the part's copy to it
    await waitFor(() =>
      expect(within(form).getByRole('combobox', { name: 'From library' })).toHaveTextContent(
        'Aluminium plate 10 · 150 × 200 × 10',
      ),
    )
    // Update changes the chosen stock in place
    await retype(user, within(form).getByRole('combobox', { name: 'Width (Y)' }), '120{Enter}')
    await user.click(within(form).getByRole('button', { name: 'Save to library' }))
    const again = await screen.findByRole('dialog', { name: 'Save to library' })
    await user.click(within(again).getByRole('button', { name: 'Update stock' }))
    await waitFor(() =>
      expect(list().find((i) => i.id === variant.id)).toMatchObject({
        width: { source: '120' },
        parentId: root.id,
      }),
    )
    await user.click(within(dialog).getByRole('button', { name: 'Create part' }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    const part = Object.values(d.doc.parts)[0]!
    expect(d.doc.snapshots[part.stock]!.libraryItemId).toBe(variant.id)
  })

  it('closes the Stock dialog it opened by itself when an agent creates the part', async () => {
    const { d } = await renderDesign(false)
    const dialog = await screen.findByRole('dialog', { name: 'Stock' })
    const agent = { kind: 'agent', id: 'http-1' } as const
    await act(async () => {
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
        agent,
      )
      const id = (stock.unwrap().value as { id: string }).id
      await d.dispatch('design.part.add', { name: 'Bracket', stockLibraryItemId: id }, agent, {
        expectedRevision: d.revision,
      })
    })
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(await within(navigator()).findByText(/^Stock: 100 × 60 × 20/)).toBeInTheDocument()
  })

  it('opens the part-setup dialogs from the toolbar; Escape closes them, focus returns', async () => {
    const { user } = await renderDesign()
    const tools = screen.getByRole('toolbar', { name: 'Part setup' })
    // Reference is a toggle for the Reference panel (DF3, Reference.test.tsx)
    for (const name of ['Stock', 'Shapes']) {
      const button = within(tools).getByRole('button', { name })
      // by keyboard: in jsdom a click lands on the panel separator (see retype)
      button.focus()
      await user.keyboard('{Enter}')
      const dialog = await screen.findByRole('dialog', { name })
      expect(dialog).toHaveAttribute('aria-describedby')
      await user.keyboard('{Escape}')
      await waitFor(() => expect(dialog).not.toBeInTheDocument())
      expect(button).toHaveFocus()
    }
    // plan and run have no part-setup group
    await user.click(screen.getByRole('radio', { name: 'Plan' }))
    expect(screen.queryByRole('toolbar', { name: 'Part setup' })).not.toBeInTheDocument()
  })

  it('adds operations, selects them and edits one parameter as one undo step', async () => {
    const { user, part, bridge } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    // the new operation is selected: row pressed, inspector shows it
    const row = await within(navigator()).findByRole('button', { name: /^Pocket 1/ })
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(within(inspector()).getByRole('heading', { name: 'Pocket 1' })).toBeInTheDocument()

    const depth = within(inspector()).getByLabelText('Depth', { selector: 'input' })
    // Tab commits only (Enter would apply too: Apply.test.tsx)
    await retype(user, depth, '8')
    await user.tab()
    await waitFor(() => expect(part().operations[0]).toMatchObject({ depth: { source: '8' } }))
    const updates = bridge.calls.filter((c) => c.name === 'design.pocket.update')
    expect(updates).toHaveLength(1)
    expect(updates[0]!.args).toMatchObject({ operationId: 'pocket1', depth: '8' })
    // one undo step, named
    expect(await screen.findByRole('button', { name: /^Undo Update pocket/ })).toBeInTheDocument()

    // the part (no selection) shows its summary again
    await user.click(row)
    expect(row).toHaveAttribute('aria-pressed', 'false')
    expect(within(inspector()).getByRole('heading', { name: 'Part' })).toBeInTheDocument()
    await expectNoAxeViolations()
  })

  it('adjust panel steps update the document live as one undo step; Escape reverts it', async () => {
    const { user, part, bridge, d } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    await within(navigator()).findByRole('button', { name: /^Pocket 1/ })
    const depthOf = () => (part().operations[0] as { depth: { source: string } }).depth.source
    const start = depthOf()
    const entries = d.history.undoable.length
    // focusing the field opens its adjust panel (ui.md#field, DF9)
    const adjust = () => within(inspector()).getByRole('combobox', { name: 'Depth' })

    await user.click(adjust())
    await screen.findByRole('dialog', { name: 'Adjust Depth' })
    await user.click(screen.getByRole('button', { name: 'Increase' }))
    await waitFor(() => expect(depthOf()).not.toBe(start)) // live: the document follows each step
    const first = depthOf()
    await user.click(screen.getByRole('button', { name: 'Increase' }))
    await waitFor(() => expect(depthOf()).not.toBe(first))
    const steps = bridge.calls.filter((c) => c.name === 'design.pocket.update')
    expect(steps).toHaveLength(2)
    expect(steps[0]!.gesture).toEqual(expect.any(String))
    expect(steps[1]!.gesture).toBe(steps[0]!.gesture)
    expect(d.history.undoable).toHaveLength(entries + 1) // one undo step for the session

    await user.keyboard('{Escape}')
    await waitFor(() => expect(depthOf()).toBe(start))
    expect(d.history.undoable).toHaveLength(entries)
    expect(d.history.redoable).toHaveLength(0) // a cancelled preview cannot be redone
    expect(bridge.calls.filter((c) => c.name === 'history.undo')).toEqual([
      { name: 'history.undo', args: { gesture: steps[0]!.gesture } },
    ])

    // a click outside keeps the value: one undo step reverts the whole session (the panel
    // closed on Escape; a click in the focused input reopens it)
    await user.click(adjust())
    await screen.findByRole('dialog', { name: 'Adjust Depth' })
    await user.click(screen.getByRole('button', { name: 'Increase' }))
    await user.click(screen.getByRole('button', { name: 'Increase' }))
    await user.click(within(inspector()).getByRole('heading', { name: 'Pocket 1' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const kept = depthOf()
    expect(kept).not.toBe(start)
    expect(d.history.undoable).toHaveLength(entries + 1)
    expectOk(await d.dispatch('history.undo', {}, { kind: 'ui', id: 'test' }))
    expect(depthOf()).toBe(start)
  })

  it('shows a command error at its field and keeps the document unchanged', async () => {
    const { user, part } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    const radius = await within(inspector()).findByLabelText('Corner radius', { selector: 'input' })
    await retype(user, radius, '50{Enter}') // > half the narrowest side
    expect(
      await within(inspector()).findByText(/The change was not applied|must be/i),
    ).toBeVisible()
    expect(part().operations[0]).toMatchObject({ shape: { cornerRadius: { source: '3 mm' } } })
    expect(radius).toHaveAttribute('aria-invalid', 'true')
  })

  it('changes the stock of a part in the Stock dialog as one undo step (DF95)', async () => {
    const { user, d, part } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    const opsBefore = structuredClone(part().operations)
    const snapshotId = part().stock
    await user.click(within(navigator()).getByRole('button', { name: /^Stock: 100/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Stock' })
    const form = within(dialog).getByRole('region', { name: 'Change the stock' })
    // the part's copy of a library stock: that stock is chosen, its material locked
    expect(within(form).getByRole('combobox', { name: 'From library' })).toHaveTextContent('Block')
    expect(within(form).getByRole('textbox', { name: 'Material name' })).toHaveAttribute('readonly')
    await retype(user, within(form).getByRole('combobox', { name: 'Length (X)' }), '150{Enter}')
    await retype(user, within(form).getByRole('combobox', { name: 'Thickness (Z)' }), '12{Enter}')
    await user.click(within(dialog).getByRole('button', { name: 'Update stock' }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    const snap = d.doc.snapshots[part().stock]!
    expect(part().stock).toBe(snapshotId)
    expect((snap.values as { length: { source: string } }).length.source).toBe('150')
    // a changed library stock becomes the part's own block (DF13), named as DF96 says
    expect(snap.libraryItemId).toBeUndefined()
    expect((snap.values as { name: string }).name).toBe('Aluminium 6061-T6 150 × 60 × 12')
    // the operations keep their values (no clamp)
    expect(part().operations).toEqual(opsBefore)
    expect(within(navigator()).getByText(/^Stock: 150 × 60 × 12/)).toBeInTheDocument()
    // one undo step takes it back
    await user.keyboard('{Control>}z{/Control}')
    await waitFor(() =>
      expect(
        (d.doc.snapshots[part().stock]!.values as { length: { source: string } }).length.source,
      ).toBe('100'),
    )
    expect(d.doc.snapshots[part().stock]!.libraryItemId).toBeDefined()
  })

  it('offers common general tolerances, each one command (DF97)', async () => {
    const { user, d } = await renderDesign()
    const tol = () => Object.values(d.doc.parts)[0]!.generalTolerance?.length?.source
    await user.click(await within(inspector()).findByRole('button', { name: 'Common tolerances' }))
    const menu = await screen.findByRole('menu', { name: 'Common tolerances' })
    const items = within(menu).getAllByRole('menuitemradio')
    expect(items.map((i) => i.querySelector('span')?.textContent)).toEqual([
      '±0.02 mm',
      '±0.05 mm',
      '±0.1 mm',
      '±0.2 mm',
      '±0.5 mm',
      'None: lengths are exact',
    ])
    expect(items.at(-1)).toHaveAttribute('aria-checked', 'true')
    await expectNoAxeViolations()
    await user.click(within(menu).getByRole('menuitemradio', { name: /±0\.1 mm/ }))
    await waitFor(() => expect(tol()).toBe('0.1'))
    const field = within(inspector()).getByLabelText('General tolerance (length)', {
      selector: 'input',
    })
    await waitFor(() => expect(field).toHaveValue('0.1'))
    await user.click(within(inspector()).getByRole('button', { name: 'Common tolerances' }))
    const again = await screen.findByRole('menu', { name: 'Common tolerances' })
    expect(within(again).getByRole('menuitemradio', { name: /±0\.1 mm/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await user.click(within(again).getByRole('menuitemradio', { name: /None/ }))
    await waitFor(() => expect(tol()).toBeUndefined())
  })

  it('every Add list offers the same items: the menu, the empty list and a face (DF98)', async () => {
    const { user, shell, bridge } = await renderDesign()
    const ids = (labels: (string | null | undefined)[], surface: AddSurface) =>
      labels.map((l) => ADD_ITEMS.find((i) => addItemLabel(i.id, surface) === l)?.id ?? l)
    const want = (surface: AddSurface) => addItemsFor(surface).map((i) => i.id)
    // the empty operation list
    const empty = within(navigator())
      .getAllByRole('button', { name: /^Add / })
      .filter((b) => b.closest('[class*="emptyOps"]') !== null)
      .map((b) => b.textContent)
    // the Add menu
    within(navigator()).getByRole('button', { name: 'Add' }).focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu', { name: 'Add' })
    const listed = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.querySelector('span')?.textContent)
    await user.keyboard('{Escape}')
    // a selected face's inspector
    act(() => shell.ui.getState().select('design', 'face:stock.top'))
    const face = within(inspector())
      .getAllByRole('button', { name: / here$/ })
      .map((b) => b.textContent)
    expect(ids(listed, 'menu')).toEqual(want('menu'))
    expect(ids(empty, 'empty')).toEqual(want('empty'))
    expect(ids(face, 'face')).toEqual(want('face'))
    // one list: what one surface has, the others have too (ADD_EXCEPTIONS lists the gaps; none)
    expect(want('empty')).toEqual(want('menu'))
    expect(want('face')).toEqual(want('menu'))
    // Pattern from a face sends the pattern on it (the test host has no 2D port to place it)
    await user.click(within(inspector()).getByRole('button', { name: 'Add pattern here' }))
    await waitFor(() =>
      expect(bridge.calls.find((c) => c.name === 'design.pattern.add')?.args).toMatchObject({
        on: 'stock.top',
      }),
    )
  })

  it('shows the general tolerance’s effective value while empty, and emptying it clears it', async () => {
    const { user, d } = await renderDesign()
    const field = await within(inspector()).findByLabelText('General tolerance (length)', {
      selector: 'input',
    })
    expect(field).toHaveValue('')
    expect(field).toHaveAttribute('placeholder', 'None: lengths are exact')
    const tol = () => Object.values(d.doc.parts)[0]!.generalTolerance?.length?.source
    await retype(user, field, '0.1{Enter}')
    await waitFor(() => expect(tol()).toBe('0.1'))
    await user.clear(field)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(tol()).toBeUndefined())
  })

  it('shows DFM warnings at the parameter, in the part summary and in the status bar', async () => {
    const { user } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    const radius = await within(inspector()).findByLabelText('Corner radius', { selector: 'input' })
    await retype(user, radius, '0{Enter}')
    // r = 0 always warns (design.md), rendered from code + params
    expect(
      await within(inspector()).findByText('A sharp inside corner cannot be cut by a round tool.'),
    ).toBeInTheDocument()
    // and no tool fits it at all (DF52), said at the Tool field
    expect(
      await within(inspector()).findByText(
        'No tool fits this operation, not even the smallest standard one. Corner radius 0 mm is smaller than the radius of the 1 mm flat end mill (0.5 mm).',
      ),
    ).toBeInTheDocument()
    expect(await within(status()).findByRole('button', { name: '2 warnings' })).toBeInTheDocument()
    const row = within(navigator()).getByRole('button', { name: /^Pocket 1/ })
    expect(row).toHaveTextContent('2 warnings')
    // DF67: the badge has its tooltip; DF70: the row has no action buttons that could cover or
    // move it, its actions are the row menu, which its description names
    expect(row.querySelector('[title="2 warnings"]')).not.toBeNull()
    expect(within(row.parentElement!).getAllByRole('button')).toEqual([row])
    expect(row).toHaveAccessibleDescription('Right-click or Shift+F10 for actions.')
    expect(row).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown Shift+F10 Delete')
  })

  it('moves operations with Alt+↑/↓ (announced) and removes them from the row menu or with Delete', async () => {
    const { user, part, addFromMenu } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add facing' }))
    await addFromMenu('Profile')
    await waitFor(() => expect(part().operations.map((o) => o.id)).toEqual(['facing1', 'profile1']))
    // D45: no move buttons, a drag grip instead
    expect(within(navigator()).queryByRole('button', { name: /^Move / })).toBeNull()

    const row = within(navigator()).getByRole('button', { name: /^Profile 1/ })
    row.focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    await waitFor(() => expect(part().operations.map((o) => o.id)).toEqual(['profile1', 'facing1']))
    expect(await screen.findByText('Moved Profile 1 to position 1 of 2.')).toBeInTheDocument()
    // Alt+↓ on the focused row moves it back
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await waitFor(() => expect(part().operations.map((o) => o.id)).toEqual(['facing1', 'profile1']))

    // DF70: no Remove button on the row; Remove is the row menu's last item
    expect(within(navigator()).queryByRole('button', { name: /^Remove / })).toBeNull()
    const facing = within(navigator()).getByRole('button', { name: /^Facing 1/ })
    await user.pointer({ keys: '[MouseRight]', target: facing })
    const menu = await screen.findByRole('menu', { name: 'Actions for Facing 1' })
    await user.click(within(menu).getByRole('menuitem', { name: 'Remove' }))
    await waitFor(() => expect(part().operations.map((o) => o.id)).toEqual(['profile1']))
    expect(await screen.findByText('Removed Facing 1')).toBeInTheDocument()
    await user.click(await findToastAction('Undo'))
    await waitFor(() => expect(part().operations.map((o) => o.id)).toEqual(['facing1', 'profile1']))
    // Delete on the focused row removes it too
    within(navigator())
      .getByRole('button', { name: /^Profile 1/ })
      .focus()
    await user.keyboard('{Delete}')
    await waitFor(() => expect(part().operations.map((o) => o.id)).toEqual(['facing1']))
    expect(await screen.findByText('Removed Profile 1')).toBeInTheDocument()
  })

  it('drags a row by its grip; a drop the move refuses says why and changes nothing (D45)', async () => {
    const { user, part, addFromMenu } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add facing' }))
    // the pocket's default `on` is the facing's floor, so it can't go before the facing
    await addFromMenu('Pocket')
    await addFromMenu('Profile')
    await waitFor(() =>
      expect(part().operations.map((o) => o.id)).toEqual(['facing1', 'pocket1', 'profile1']),
    )
    const restore = layOutRows()
    try {
      const rowOf = (name: RegExp) => within(navigator()).getByRole('button', { name })
      // the grip sits before the row icon, at the row's start (DF24)
      const profileRow = rowOf(/^Profile 1/)
      expect(profileRow.previousElementSibling).toBe(gripOf(profileRow))
      // the profile to the top: one design.operation.move, announced
      dragTo(gripOf(rowOf(/^Profile 1/)), 5)
      await waitFor(() =>
        expect(part().operations.map((o) => o.id)).toEqual(['profile1', 'facing1', 'pocket1']),
      )
      expect(await screen.findByText('Moved Profile 1 to position 1 of 3.')).toBeInTheDocument()

      // over the gap above the facing the indicator turns red and says why, before the drop
      const pocket = rowOf(/^Pocket 1/)
      dragTo(gripOf(pocket), 35, true)
      const why = 'Not moved: Pocket 1 uses Facing 1 floor, which has to come before it.'
      expect(within(navigator()).getByText(why)).toBeInTheDocument()
      const facingItem = rowOf(/^Facing 1/).closest('[data-reorder-item]')!
      expect(facingItem).toHaveAttribute('data-drop', 'before')
      expect(facingItem).toHaveAttribute('data-drop-refused')
      act(() => {
        pocket.dispatchEvent(new Event('pointerup', { bubbles: true }))
      })
      // released there: nothing moves, the refusal stays under the list and is announced
      expect(part().operations.map((o) => o.id)).toEqual(['profile1', 'facing1', 'pocket1'])
      expect(within(navigator()).getAllByText(why)).toHaveLength(2)
      expect(facingItem).not.toHaveAttribute('data-drop')

      // Alt+↑ there gives the command's refusal, the same text
      pocket.focus()
      await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
      await waitFor(() => expect(within(navigator()).getAllByText(why).length).toBeGreaterThan(0))
      expect(part().operations.map((o) => o.id)).toEqual(['profile1', 'facing1', 'pocket1'])
      await expectNoAxeViolations()
    } finally {
      restore()
    }
  })

  it('picks the on surface in the viewport (pick mode) or from the list', async () => {
    const { user, part, shell, addFromMenu } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add facing' }))
    await addFromMenu('Pocket')
    await within(inspector()).findByRole('heading', { name: 'Pocket 1' })
    // the default `on` is the last facing's floor
    expect(part().operations[1]).toMatchObject({ on: 'facing1.floor' })

    await user.click(
      within(inspector()).getByRole('button', { name: 'Pick the surface in the viewport' }),
    )
    const pick = shell.ui.getState().pick
    // every face target, sides and bottom included (task F1)
    expect(pick?.eligible).toEqual(
      new Set([
        'stock.top',
        'facing1.floor',
        'stock.bottom',
        'stock.side[0]',
        'stock.side[1]',
        'stock.side[2]',
        'stock.side[3]',
      ]),
    )
    expect(screen.getByRole('status')).toHaveTextContent('Pick a surface for On')
    act(() => {
      pick!.onPick('stock.top')
      shell.ui.getState().setPick(null)
    })
    await waitFor(() => expect(part().operations[1]).toMatchObject({ on: 'stock.top' }))
  })

  it('groups the on targets by direction; a side face reads its fields in u and v', async () => {
    const { user, part, bridge } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    await within(inspector()).findByRole('heading', { name: 'Pocket 1' })
    // on the top face the position reads X and Y
    expect(within(inspector()).getByLabelText('Position X', { selector: 'input' })).toBeVisible()
    const on = within(inspector()).getByRole('combobox', { name: 'On' })
    on.focus()
    await user.keyboard('{Enter}')
    const list = await screen.findByRole('listbox')
    const groups = within(list).getAllByRole('group')
    expect(groups.map((g) => g.firstElementChild?.textContent)).toEqual([
      'Top',
      'Bottom',
      'Front side',
      'Right side',
      'Back side',
      'Left side',
    ])
    await user.click(within(groups[3]!).getByRole('option', { name: /Stock right side/ }))
    await waitFor(() => expect(part().operations[0]).toMatchObject({ on: 'stock.side[1]' }))
    expect(
      bridge.calls.filter((c) => c.name === 'design.pocket.update').at(-1)!.args,
    ).toMatchObject({ on: 'stock.side[1]' })
    // the face frame's axes name the fields on a side face (design-v0.2.md#face-frame)
    expect(
      await within(inspector()).findByLabelText('Position u', { selector: 'input' }),
    ).toBeVisible()
    expect(within(inspector()).getByLabelText('Length (u)', { selector: 'input' })).toBeVisible()
    expect(within(inspector()).getByLabelText('Width (v)', { selector: 'input' })).toBeVisible()
    // the viewport's text summary says which face and anchor are shown
    expect(screen.getByRole('region', { name: '3D viewport' })).toHaveAccessibleDescription(
      /Selected: Pocket 1 on Stock right side, face axes u and v shown, anchor Centre\./,
    )
    await expectNoAxeViolations()
  })

  it('offers a stock-face on for facings and profiles', async () => {
    const { user, part, addFromMenu } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add facing' }))
    await within(inspector()).findByRole('heading', { name: 'Facing 1' })
    expect(within(inspector()).getByRole('combobox', { name: 'On' })).toHaveTextContent('Stock top')
    await addFromMenu('Profile')
    await within(inspector()).findByRole('heading', { name: 'Profile 1' })
    const on = within(inspector()).getByRole('combobox', { name: 'On' })
    on.focus()
    await user.keyboard('{Enter}')
    const options = within(await screen.findByRole('listbox')).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      'Stock top',
      'Stock bottom',
      'Stock front side',
      'Stock right side',
      'Stock back side',
      'Stock left side',
    ])
    await user.click(options[1]!)
    await waitFor(() => expect(part().operations[1]).toMatchObject({ on: 'stock.bottom' }))
  })

  it('re-anchors with the anchor picker without moving the feature, as one undo step', async () => {
    const { user, part, bridge, d } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    await within(inspector()).findByRole('heading', { name: 'Pocket 1' })
    const anchor = within(inspector()).getByRole('radiogroup', { name: 'Anchor' })
    expect(within(anchor).getByRole('radio', { name: 'Centre' })).toBeChecked()
    const entries = d.history.undoable.length
    await user.click(within(anchor).getByRole('radio', { name: 'Front left' }))
    await waitFor(() =>
      expect(part().operations[0]).toMatchObject({ shape: { anchor: { u: 'min', v: 'min' } } }),
    )
    expect(bridge.calls.filter((c) => c.name === 'design.pocket.update').at(-1)!.args).toEqual({
      partId: part().id,
      operationId: 'pocket1',
      anchor: { u: 'min', v: 'min' },
    })
    expect(d.history.undoable).toHaveLength(entries + 1)
    // the pocket (50, 30), 33 × 20 stays: the position now gives its front-left corner
    expect(within(inspector()).getByLabelText('Position X', { selector: 'input' })).toHaveValue(
      '33.5 mm',
    )
    expect(within(inspector()).getByLabelText('Position Y', { selector: 'input' })).toHaveValue(
      '20 mm',
    )
    expect(within(anchor).getByRole('radio', { name: 'Front left' })).toBeChecked()
    expect(within(anchor).getByRole('radio', { name: 'Front left' })).toHaveFocus()
    // arrow keys move the choice in the grid
    await user.keyboard('{ArrowRight}')
    await waitFor(() =>
      expect(part().operations[0]).toMatchObject({ shape: { anchor: { u: 'centre', v: 'min' } } }),
    )
    await expectNoAxeViolations()
  })

  it('disables the anchor picker while the position is a formula, with the reason', async () => {
    const { user, part, bridge } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    await within(inspector()).findByRole('heading', { name: 'Pocket 1' })
    const x = within(inspector()).getByLabelText('Position X', { selector: 'input' })
    await retype(user, x, '25 * 2{Enter}')
    await waitFor(() =>
      expect(part().operations[0]).toMatchObject({
        shape: { center: [{ source: '25 * 2' }, {}] },
      }),
    )
    const anchor = within(inspector()).getByRole('radiogroup', { name: 'Anchor' })
    expect(anchor).toHaveAttribute('aria-disabled', 'true')
    expect(
      within(inspector()).getByText('Remove the formula to change the anchor.'),
    ).toBeInTheDocument()
    expect(anchor).toHaveAccessibleDescription(/Remove the formula to change the anchor/)
    const before = bridge.calls.length
    await user.click(within(anchor).getByRole('radio', { name: 'Back right' }))
    expect(bridge.calls.length).toBe(before)
  })

  it('places a new pocket by the default-anchor setting', async () => {
    const { user, part, shell } = await renderDesign()
    act(() => shell.settings.getState().update({ defaultAnchor: { u: 'max', v: 'max' } }))
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    await within(inspector()).findByRole('heading', { name: 'Pocket 1' })
    // still centred at (50, 30): its back-right corner is the position
    expect(part().operations[0]).toMatchObject({
      shape: {
        anchor: { u: 'max', v: 'max' },
        center: [{ source: '66.5 mm' }, { source: '40 mm' }],
      },
    })
    expect(
      within(within(inspector()).getByRole('radiogroup', { name: 'Anchor' })).getByRole('radio', {
        name: 'Back right',
      }),
    ).toBeChecked()
  })

  it('a selected face shows in the inspector and Add puts operations on it (DF22)', async () => {
    const { user, shell, part, addFromMenu, container } = await renderDesign()
    // the empty part inspector says how to get there
    expect(
      within(inspector()).getByText(/Select a face in the viewport \(Alt\+click for a floor\)/),
    ).toBeInTheDocument()
    act(() => shell.ui.getState().select('design', 'face:stock.side[1]')) // as a stock click does
    expect(within(inspector()).getByText('Face: Stock right side')).toBeInTheDocument()
    expect(
      within(inspector()).getByText(/Facing right \(\+X\) · u → \+Y, v → \+Z/),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '3D viewport' })).toHaveAccessibleDescription(
      /Selected face: Stock right side/,
    )
    await expectNoAxeViolations(container)
    await user.click(within(inspector()).getByRole('button', { name: 'Add drilling here' }))
    const drill = part().operations.at(-1)!
    expect(drill).toMatchObject({ kind: 'drilling', on: 'stock.side[1]' })
    // the new operation is selected: its inspector shows
    expect(within(inspector()).queryByText('Face: Stock right side')).toBeNull()
    // Add from the menu with a face selected: a facing takes the stock face of its direction
    act(() => shell.ui.getState().select('design', 'face:stock.bottom'))
    await addFromMenu('Facing')
    expect(part().operations.at(-1)).toMatchObject({ kind: 'facing', on: 'stock.bottom' })
    // without a face, Add keeps its default
    act(() => shell.ui.getState().select('design', null))
    await addFromMenu('Pocket')
    expect(part().operations.at(-1)).toMatchObject({ kind: 'pocket', on: 'stock.top' })
  })

  it('Measure sits in the main toolbar (DF19) and toggles the viewport tool', async () => {
    const { user } = await renderDesign()
    const toolbar = screen.getByRole('toolbar', { name: 'Tools' })
    const button = within(toolbar).getByRole('button', { name: /Measure/ })
    await user.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('region', { name: '3D viewport' })).toHaveAttribute('data-measuring')
    await user.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })

  it('selection follows the viewport, and evaluation status reaches the status bar', async () => {
    const { user, shell, bridge, part } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    act(() => shell.ui.getState().select('design', null))
    act(() => shell.ui.getState().select('design', 'pocket1')) // as a viewport click does
    expect(within(navigator()).getByRole('button', { name: /^Pocket 1/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    act(() =>
      bridge.emitEvaluation({
        key: 'p1',
        partId: part().id,
        status: 'failed',
        error: {
          code: 'geometry.evaluation',
          message: 'boom',
          issues: [{ path: ['operations', 'pocket1'], rule: 'x', message: 'boom' }],
          frames: [],
        },
      }),
    )
    const chip = await within(status()).findByText('Evaluation failed at Pocket 1')
    expect(chip).toBeInTheDocument()
    expect(within(navigator()).getByText('Evaluation failed here')).toBeInTheDocument()
    act(() => shell.ui.getState().select('design', null))
    await user.click(chip)
    expect(shell.ui.getState().selection.design).toBe('pocket1')
  })
})
