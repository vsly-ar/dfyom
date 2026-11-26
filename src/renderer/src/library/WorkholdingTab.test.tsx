// The Library window's Workholding tab (WL3) against the fake bridge with the real app registry
// and an in-memory library: the list grouped by device type with the built-ins after the user's
// items, the Default / Built-in chips and the size cells; a built-in is read-only and duplicated
// to edit; the draft's Save with the Default switch (one default per type); a built-in made the
// default clears the user's flag; New workholding per type with the Range group; inch built-ins;
// axe. Docs: docs/modes/workholding-library.md#library-window-tab, docs/conventions/testing.md
import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Dispatcher } from '../../../core/commands/dispatcher'
import { Library } from '../../../core/library/library'
import type { LibraryItemDTO } from '../../../core/library/library-item'
import { createMemoryLibraryStorage } from '../../../core/library/memory-storage'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { App } from '../App'
import { createShell, ShellProvider } from '../shell/ShellContext'
import { createFakeBridge, designDispatcher } from '../test/bridge'
import { expectNoAxeViolations, renderUi } from '../test/render'

const UI = { kind: 'ui', id: 'test' } as const

type Row = LibraryItemDTO & Record<string, unknown>

/** The built-in toe clamp's row (not the "Toe clamps" heading, not a copy). */
const CLAMP = /^Toe clamp(?!s| copy)/

async function renderWorkholding(opts: { strapDefault?: boolean } = {}) {
  const library = (await Library.open(createMemoryLibraryStorage())).unwrap()
  const d: Dispatcher = await designDispatcher('Bracket', 'mm', { library })
  const strap = (
    (
      await d.dispatch(
        'library.workholding.add',
        {
          values: {
            type: 'toeClamp',
            name: 'Strap clamp M8',
            width: '25',
            length: '80',
            top: '30',
            gripMin: '5',
            gripMax: '20',
            stud: 'M8',
            ...(opts.strapDefault === true ? { default: true } : {}),
          },
          units: 'mm',
        },
        UI,
      )
    ).unwrap().value as LibraryItemDTO
  ).id
  const bridge = createFakeBridge(DEFAULT_SETTINGS, 'library')
  bridge.appScope(d, library)
  bridge.emitLibraryContext({ project: null, target: null, tab: 'workholding' })
  const shell = createShell(bridge)
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  const grid = () => screen.getByRole('grid', { name: 'Workholding' })
  const row = (name: string | RegExp) => within(grid()).getByRole('row', { name })
  const editor = () => screen.getByRole('region', { name: 'Item editor' })
  const get = (id: string) =>
    d.query('library.workholding.get', { id, units: 'mm' }, UI).unwrap().value as Row
  const list = () =>
    (d.query('library.workholding.list', { units: 'mm' }, UI).unwrap().value as { items: Row[] })
      .items
  await within(await screen.findByRole('grid', { name: 'Workholding' })).findByRole('row', {
    name: /Strap clamp M8/,
  })
  return { ...r, d, strap, grid, row, editor, get, list }
}

const input = (scope: HTMLElement, label: string) =>
  within(scope).getByLabelText(label, { selector: 'input' })

describe('Library window: Workholding tab (WL3)', () => {
  it('lists devices grouped by type, built-ins after the user’s items, with chips and sizes', async () => {
    const { grid, row, editor } = await renderWorkholding()
    expect(screen.getByRole('tab', { name: 'Workholding' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    const rows = within(grid())
      .getAllByRole('row')
      .map((r) => r.textContent ?? '')
    // header, then "Toe clamps": the user's clamp before the built-in, then the other types
    expect(rows[1]).toBe('Toe clamps')
    expect(rows[2]).toMatch(/^Strap clamp M8/)
    expect(rows[3]).toMatch(/^Toe clamp/)
    expect(rows.slice(4).join('|')).toMatch(
      /Vises\|Machine vise 150.*\|Screws\|Screw, flush head.*\|Bases\|Spoilboard.*\|Fixture plate.*\|Surface holds\|Double-sided tape/,
    )
    expect(row(/Strap clamp M8/)).toHaveTextContent('25 × 80, top 30 mm')
    expect(row(/Strap clamp M8/)).toHaveTextContent('grip 5–20 mm · M8')
    expect(row(CLAMP)).toHaveTextContent('Default')
    expect(row(CLAMP)).toHaveTextContent('Built-in')
    expect(row(/Strap clamp M8/)).not.toHaveTextContent('Default')
    expect(row(/Machine vise 150/)).toHaveTextContent('jaws 150 mm')
    expect(row(/Screw, flush head/)).toHaveTextContent('head Ø 8 mm')
    // the first row is selected: its form with the device drawing and the Range group
    await waitFor(() =>
      expect(within(editor()).getByRole('heading', { name: 'Strap clamp M8' })).toBeVisible(),
    )
    expect(within(editor()).getByRole('img', { name: 'Device drawing' })).toBeInTheDocument()
    expect(input(editor(), 'Strap width')).toHaveValue('25')
    expect(input(editor(), 'Grip to')).toHaveValue('20')
    await expectNoAxeViolations()
  })

  it('filters by device type and highlights the focused dimension', async () => {
    const { user, grid, editor } = await renderWorkholding()
    await user.click(screen.getByRole('combobox', { name: 'Device type' }))
    await user.click(await screen.findByRole('option', { name: 'Vise' }))
    const names = within(grid())
      .getAllByRole('row')
      .map((r) => r.textContent ?? '')
    expect(names.slice(1)).toEqual([expect.stringMatching(/^Vises/), expect.any(String)])
    expect(names[2]).toMatch(/^Machine vise 150/)
    await user.click(input(editor(), 'Strap length'))
    expect(
      within(editor()).getByRole('img', { name: 'Device drawing: Strap length highlighted' }),
    ).toBeInTheDocument()
  })

  it('shows a built-in read-only; Duplicate makes an editable copy; Default and Save store it', async () => {
    const { user, row, editor, list } = await renderWorkholding()
    await user.click(row(CLAMP))
    const e = editor()
    expect(within(e).getByRole('heading', { name: 'Toe clamp' })).toBeVisible()
    expect(within(e).getByText('Built-in: duplicate it to change the sizes.')).toBeVisible()
    expect(input(e, 'Strap length')).toHaveAttribute('readonly')
    expect(input(e, 'Name')).toHaveAttribute('readonly')
    expect(within(e).queryByRole('button', { name: 'Save' })).toBeNull()
    expect(within(e).queryByRole('button', { name: 'Remove…' })).toBeNull()
    // the built-in is the type's default: on, and it cannot be switched off
    const builtinSwitch = within(e).getByRole('switch', { name: 'Default for toe clamps' })
    expect(builtinSwitch).toBeChecked()
    expect(builtinSwitch).toBeDisabled()
    await expectNoAxeViolations()

    await user.click(within(e).getByRole('button', { name: 'Duplicate' }))
    await waitFor(() =>
      expect(within(editor()).getByRole('heading', { name: 'Toe clamp copy' })).toBeVisible(),
    )
    const length = input(editor(), 'Strap length')
    expect(length).not.toHaveAttribute('readonly')
    await user.clear(length)
    await user.type(length, '70{Enter}')
    const sw = within(editor()).getByRole('switch', { name: 'Default for toe clamps' })
    expect(sw).not.toBeChecked()
    await user.click(sw)
    await user.click(within(editor()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(list().some((i) => i.name === 'Toe clamp copy')).toBe(true))
    const copy = list().find((i) => i.name === 'Toe clamp copy')!
    expect(copy).toMatchObject({ length: { source: '70' }, default: true, isDefault: true })
    expect(copy['builtIn']).toBeUndefined()
    await waitFor(() => expect(row(/Toe clamp copy/)).toHaveTextContent('Default'))
    expect(row(CLAMP)).not.toHaveTextContent('Default')
  })

  it('making a built-in the default clears the user’s default of its type', async () => {
    const { user, row, editor, get, strap } = await renderWorkholding({ strapDefault: true })
    expect(row(/Strap clamp M8/)).toHaveTextContent('Default')
    expect(row(CLAMP)).not.toHaveTextContent('Default')
    await user.click(row(CLAMP))
    const sw = within(editor()).getByRole('switch', { name: 'Default for toe clamps' })
    expect(sw).not.toBeChecked()
    await user.click(sw)
    await waitFor(() => expect(get(strap)['default']).toBeUndefined())
    await waitFor(() => expect(row(CLAMP)).toHaveTextContent('Default'))
    expect(row(/Strap clamp M8/)).not.toHaveTextContent('Default')
  })

  it('New workholding offers the six types; a vise with its Range closed while empty', async () => {
    const { user, editor, list } = await renderWorkholding()
    await user.click(screen.getByRole('button', { name: 'New workholding' }))
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent)
    expect(items).toEqual(['Toe clamp', 'Vise', 'Screw', 'Block', 'Base', 'Surface hold'])
    await user.click(screen.getByRole('menuitem', { name: 'Vise' }))
    const e = editor()
    expect(within(e).getByRole('heading', { name: 'Machine vise' })).toBeVisible()
    expect(input(e, 'Jaw width')).toHaveValue('150')
    const range = within(e).getByRole('button', { name: /Range/ })
    expect(range).toHaveAttribute('aria-expanded', 'false')
    expect(range).toHaveTextContent('None')
    await user.click(range)
    const opening = input(editor(), 'Max opening')
    await user.type(opening, '100{Enter}')
    await user.click(within(editor()).getByRole('checkbox', { name: 'Soft jaws' }))
    await user.click(within(editor()).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(list().find((i) => i.name === 'Machine vise')).toMatchObject({
        type: 'vise',
        soft: true,
        maxOpening: { source: '100' },
      }),
    )
  })

  it('a grip range past the strap length is an error at its field; Save focuses it', async () => {
    const { user, row, editor } = await renderWorkholding()
    await user.click(row(/Strap clamp M8/))
    const max = input(editor(), 'Grip to')
    await user.clear(max)
    await user.type(max, '90{Enter}')
    await user.click(within(editor()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(input(editor(), 'Grip to')).toHaveAttribute('aria-invalid', 'true'))
    expect(document.activeElement).toBe(input(editor(), 'Grip to'))
  })

  it('lists the built-ins in inches when the window shows inches (L5)', async () => {
    const { user, row, editor } = await renderWorkholding()
    await user.click(screen.getByRole('radio', { name: 'in' }))
    await waitFor(() => expect(row(/Machine vise 6"/)).toHaveTextContent('jaws 6 in'))
    expect(row(CLAMP)).toHaveTextContent('1.25 × 2.5, top 1 in')
    await user.click(row(CLAMP))
    expect(input(editor(), 'Strap width')).toHaveValue('1 1/4"')
  })
})
