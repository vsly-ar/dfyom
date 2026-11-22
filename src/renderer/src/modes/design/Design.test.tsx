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

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

async function renderDesign(withPart = true) {
  const bridge: FakeBridge = createFakeBridge()
  const d: Dispatcher = await designDispatcher()
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
  // test windows are narrow: the inspector is an overlay, opened by its toggle
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const addFromMenu = async (label: string) => {
    within(navigator()).getByRole('button', { name: 'Add operation' }).focus()
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
  it('sets up the part from a new block of stock', async () => {
    const { user, d } = await renderDesign(false)
    const form = await screen.findByRole('region', { name: 'Set up the part' })
    const length = within(form).getByRole('textbox', { name: 'Length (X)' })
    await retype(user, length, '120{Enter}')
    await user.click(within(form).getByRole('button', { name: 'Create part' }))
    await within(navigator()).findByRole('heading', { name: 'No operations yet' })
    const part = Object.values(d.doc.parts)[0]!
    const snap = d.doc.snapshots[part.stock]!
    expect((snap.values as { length: { source: string } }).length.source).toBe('120')
    await expectNoAxeViolations()
  })

  it('adds operations, selects them and edits one parameter as one undo step', async () => {
    const { user, part, bridge } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    // the new operation is selected: row pressed, inspector shows it
    const row = await within(navigator()).findByRole('button', { name: /^Pocket 1/ })
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(within(inspector()).getByRole('heading', { name: 'Pocket 1' })).toBeInTheDocument()

    const depth = within(inspector()).getByLabelText('Depth', { selector: 'input' })
    await retype(user, depth, '8{Enter}')
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

  it('adjust popover steps update the document live as one undo step; Escape reverts it', async () => {
    const { user, part, bridge, d } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    await within(navigator()).findByRole('button', { name: /^Pocket 1/ })
    const depthOf = () => (part().operations[0] as { depth: { source: string } }).depth.source
    const start = depthOf()
    const entries = d.history.undoable.length
    const adjust = () => within(inspector()).getByRole('button', { name: 'Adjust Depth' })

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

    // a click outside keeps the value: one undo step reverts the whole session
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

  it('shows DFM warnings at the parameter, in the part summary and in the status bar', async () => {
    const { user } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    const radius = await within(inspector()).findByLabelText('Corner radius', { selector: 'input' })
    await retype(user, radius, '0{Enter}')
    // r = 0 always warns (design.md), rendered from code + params
    expect(
      await within(inspector()).findByText('A sharp inside corner cannot be cut by a round tool.'),
    ).toBeInTheDocument()
    expect(await within(status()).findByRole('button', { name: '1 warning' })).toBeInTheDocument()
    const row = within(navigator()).getByRole('button', { name: /^Pocket 1/ })
    expect(row).toHaveTextContent('1 warning')
  })

  it('moves operations up and down and removes one with an undo toast', async () => {
    const { user, part, addFromMenu } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add facing' }))
    await addFromMenu('Add profile')
    await waitFor(() => expect(part().operations.map((o) => o.id)).toEqual(['facing1', 'profile1']))

    await user.click(within(navigator()).getByRole('button', { name: 'Move Profile 1 up' }))
    await waitFor(() => expect(part().operations.map((o) => o.id)).toEqual(['profile1', 'facing1']))
    // Alt+↓ on the focused row moves it back
    const row = within(navigator()).getByRole('button', { name: /^Profile 1/ })
    row.focus()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await waitFor(() => expect(part().operations.map((o) => o.id)).toEqual(['facing1', 'profile1']))

    await user.click(within(navigator()).getByRole('button', { name: 'Remove Facing 1' }))
    await waitFor(() => expect(part().operations.map((o) => o.id)).toEqual(['profile1']))
    expect(await screen.findByText('Removed Facing 1')).toBeInTheDocument()
    await user.click(await findToastAction('Undo'))
    await waitFor(() => expect(part().operations.map((o) => o.id)).toEqual(['facing1', 'profile1']))
  })

  it('picks the on surface in the viewport (pick mode) or from the list', async () => {
    const { user, part, shell, addFromMenu } = await renderDesign()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add facing' }))
    await addFromMenu('Add pocket')
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
    expect(within(inspector()).getByRole('combobox', { name: 'On' })).toHaveTextContent(
      'Stock top · stock.top',
    )
    await addFromMenu('Add profile')
    await within(inspector()).findByRole('heading', { name: 'Profile 1' })
    const on = within(inspector()).getByRole('combobox', { name: 'On' })
    on.focus()
    await user.keyboard('{Enter}')
    const options = within(await screen.findByRole('listbox')).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      'Stock top · stock.top',
      'Stock bottom · stock.bottom',
      'Stock front side · stock.side[0]',
      'Stock right side · stock.side[1]',
      'Stock back side · stock.side[2]',
      'Stock left side · stock.side[3]',
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
