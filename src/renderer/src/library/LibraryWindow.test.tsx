// The Library window against the fake bridge (window kind `library`) with the real app registry
// and an in-memory library: landmarks and tabs, the list (used chip, search, arrow keys), the item
// editor's draft (Unsaved, Save, Revert), the leave prompt, New / Duplicate / Remove…, a stale
// revision with Overwrite, the close request, the unit system (L5), and axe.
// Doc: docs/conventions/ui-library-window.md, docs/conventions/testing.md
import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Dispatcher } from '../../../core/commands/dispatcher'
import { Library } from '../../../core/library/library'
import type { LibraryItemDTO } from '../../../core/library/library-item'
import { createMemoryLibraryStorage } from '../../../core/library/memory-storage'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import type { LibraryContext } from '../../../shared/preload-api'
import { App } from '../App'
import { createShell, ShellProvider } from '../shell/ShellContext'
import { createFakeBridge, designDispatcher } from '../test/bridge'
import { expectNoAxeViolations, renderUi } from '../test/render'

const UI = { kind: 'ui', id: 'test' } as const

const TOOL = {
  type: 'flatEndMill',
  fluteLength: '20',
  overallLength: '50',
  fluteCount: '2',
}

async function renderLibrary(context: Partial<LibraryContext> = {}) {
  const library = (await Library.open(createMemoryLibraryStorage())).unwrap()
  const d: Dispatcher = await designDispatcher('Bracket', 'mm', { library })
  const add = async (kind: string, values: object, units = 'mm') =>
    (
      (await d.dispatch(`library.${kind}.add`, { values, units }, UI)).unwrap()
        .value as LibraryItemDTO
    ).id
  const flat6 = await add('tool', { ...TOOL, name: 'Flat 6', diameter: '6' })
  const drill = await add(
    'tool',
    {
      ...TOOL,
      name: 'Drill 1/4',
      type: 'drill',
      diameter: '1/4',
      pointAngle: '118',
      fluteLength: '1',
      overallLength: '2 1/2',
    },
    'inch',
  )
  const bridge = createFakeBridge(DEFAULT_SETTINGS, 'library')
  bridge.appScope(d, library)
  bridge.emitLibraryContext({ project: null, target: null, tab: 'tool', ...context })
  const shell = createShell(bridge)
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  const grid = () => screen.getByRole('grid', { name: 'Tools' })
  const row = (name: string | RegExp) => within(grid()).getByRole('row', { name })
  const editor = () => screen.getByRole('region', { name: 'Item editor' })
  const get = (kind: string, id: string) =>
    d.query(`library.${kind}.get`, { id }, UI).unwrap().value as LibraryItemDTO
  await within(await screen.findByRole('grid', { name: 'Tools' })).findByRole('row', {
    name: /Flat 6/,
  })
  return { ...r, d, bridge, library, flat6, drill, grid, row, editor, get, add }
}

describe('Library window', () => {
  it('has the landmarks, the tabs and a list of the tab’s items', async () => {
    const { user, row, editor } = await renderLibrary()
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Library items' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(document.title).toBe('Library')
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(tabs).toEqual(['Machines', 'Tools', 'Stock'])
    expect(screen.getByRole('tab', { name: 'Tools' })).toHaveAttribute('aria-selected', 'true')
    // the first item is selected; its stored source keeps its unit system (L5)
    await waitFor(() => expect(row(/Drill 1\/4/)).toHaveAttribute('aria-selected', 'true'))
    expect(row(/Drill 1\/4/)).toHaveTextContent('1/4"')
    expect(row(/Flat 6/)).toHaveTextContent('6 mm')
    expect(within(editor()).getByRole('heading', { name: 'Drill 1/4' })).toBeInTheDocument()
    expect(within(editor()).getByLabelText('Diameter', { selector: 'input' })).toHaveValue('1/4 in')
    await user.click(screen.getByRole('tab', { name: 'Machines' }))
    expect(await screen.findByRole('grid', { name: 'Machines' })).toBeInTheDocument()
    expect(screen.getByText('No machines yet.')).toBeInTheDocument()
    // the empty list says how to start; the editor does not ask to select an item
    expect(editor().textContent).toBe('')
    await expectNoAxeViolations()
  })

  it('searches, selects with the arrow keys and moves into the editor with Enter', async () => {
    const { user, row, grid, editor } = await renderLibrary()
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'flat')
    expect(within(grid()).queryByRole('row', { name: /Drill/ })).toBeNull()
    await user.clear(screen.getByRole('searchbox', { name: 'Search' }))
    await waitFor(() => expect(row(/Drill 1\/4/)).toHaveAttribute('aria-selected', 'true'))
    row(/Drill 1\/4/).focus()
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(row(/Flat 6/)).toHaveAttribute('aria-selected', 'true'))
    expect(within(editor()).getByRole('heading', { name: 'Flat 6' })).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(editor()).toContainElement(document.activeElement as HTMLElement)
  })

  it('holds a draft: Unsaved, Save sends one update, Revert drops it', async () => {
    const { user, row, editor, get, flat6, bridge } = await renderLibrary()
    await user.click(row(/Flat 6/))
    const fl = within(editor()).getByLabelText('Flute length', { selector: 'input' })
    await user.clear(fl)
    await user.type(fl, '22{Enter}')
    await waitFor(() => expect(row(/Flat 6/)).toHaveTextContent('Unsaved'))
    expect(bridge.libraryReports.at(-1)).toEqual({ draft: 'Flat 6', tab: 'tool' })
    // Revert
    await user.click(within(editor()).getByRole('button', { name: 'Revert' }))
    await waitFor(() => expect(row(/Flat 6/)).not.toHaveTextContent('Unsaved'))
    expect(within(editor()).getByLabelText('Flute length', { selector: 'input' })).toHaveValue('20')
    // edit again and save with Ctrl/Cmd+S
    const fl2 = within(editor()).getByLabelText('Flute length', { selector: 'input' })
    await user.clear(fl2)
    await user.type(fl2, '22{Enter}')
    await user.keyboard('{Control>}s{/Control}{Meta>}s{/Meta}')
    await waitFor(() => expect(get('tool', flat6)).toMatchObject({ fluteLength: { source: '22' } }))
    expect(get('tool', flat6).revision).toBe(2)
    await waitFor(() => expect(row(/Flat 6/)).not.toHaveTextContent('Unsaved'))
    expect(bridge.libraryReports.at(-1)).toEqual({ draft: null, tab: 'tool' })
  })

  it('a Recommended preset follows the calculator until a value is typed (library.md#recommended-presets)', async () => {
    const { user, row, editor, get, add } = await renderLibrary()
    const id = await add('tool', {
      ...TOOL,
      name: 'Flat 8',
      diameter: '8',
      toolMaterial: 'carbide',
      presets: [
        {
          name: 'Alu',
          materialClass: 'aluminum',
          spindleSpeed: '1000',
          feedRate: '100',
          plungeRate: '50',
        },
        { name: 'Any', spindleSpeed: '1000', feedRate: '100', plungeRate: '50' },
      ],
    })
    await user.click(await waitFor(() => row(/Flat 8/)))
    const preset = (name: string) => within(editor()).getByRole('listitem', { name })
    const speed = () =>
      within(preset('Alu')).getByLabelText('Spindle speed of Alu', { selector: 'input' })
    const box = (name: string) =>
      within(preset(name)).getByRole('checkbox', { name: 'Recommended' })
    // a preset for any material cannot follow: the reason is its description
    expect(box('Any')).toBeDisabled()
    expect(box('Any')).toHaveAccessibleDescription('Choose a material to follow the calculator.')
    expect(box('Alu')).toBeEnabled()
    await user.click(box('Alu'))
    expect(box('Alu')).toBeChecked()
    await waitFor(() => expect(speed()).not.toHaveValue('1000'))
    const followed = (speed() as HTMLInputElement).value
    // a tool change: the preset follows
    const dc = within(editor()).getByLabelText('Diameter', { selector: 'input' })
    await user.clear(dc)
    await user.type(dc, '4{Enter}')
    await waitFor(() => expect(speed()).not.toHaveValue(followed))
    await user.keyboard('{Control>}s{/Control}{Meta>}s{/Meta}')
    await waitFor(() => expect(get('tool', id).revision).toBe(2))
    expect(get('tool', id)).toMatchObject({
      presets: [{ name: 'Alu', recommended: true }, { name: 'Any' }],
    })
    // typing a value ends the following; the values stay
    await user.clear(speed())
    await user.type(speed(), '12000{Enter}')
    expect(box('Alu')).not.toBeChecked()
    expect(speed()).toHaveValue('12000')
  })

  it('asks before leaving a draft: Save / Discard / Cancel', async () => {
    const { user, row, editor, get, flat6 } = await renderLibrary()
    await user.click(row(/Flat 6/))
    const name = within(editor()).getByRole('textbox', { name: 'Name' })
    await user.clear(name)
    await user.type(name, 'Flat 6 long')
    await user.click(row(/Drill/))
    let prompt = await screen.findByRole('dialog', { name: 'Save changes to Flat 6 long?' })
    await user.click(within(prompt).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(row(/Flat 6/)).toHaveAttribute('aria-selected', 'true')
    await user.click(row(/Drill/))
    prompt = await screen.findByRole('dialog', { name: 'Save changes to Flat 6 long?' })
    await user.click(within(prompt).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(row(/Drill/)).toHaveAttribute('aria-selected', 'true'))
    expect(get('tool', flat6).name).toBe('Flat 6 long')
    // Discard
    const n2 = within(editor()).getByRole('textbox', { name: 'Name' })
    await user.type(n2, ' x')
    await user.click(row(/Flat 6 long/))
    prompt = await screen.findByRole('dialog', { name: 'Save changes to Drill 1/4 x?' })
    await user.click(within(prompt).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(row(/Flat 6 long/)).toHaveAttribute('aria-selected', 'true'))
    expect(screen.queryByText('Drill 1/4 x')).toBeNull()
  })

  it('adds a new tool, duplicates it and removes the copy after confirming', async () => {
    const { user, row, editor, library } = await renderLibrary()
    await user.click(screen.getByRole('button', { name: 'New tool' }))
    await waitFor(() =>
      expect(within(editor()).getByRole('heading', { name: 'Flat 6' })).toBeInTheDocument(),
    )
    const d = within(editor()).getByLabelText('Diameter', { selector: 'input' })
    await user.clear(d)
    await user.type(d, '8{Enter}')
    await user.click(within(editor()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(row(/Flat 8/)).toHaveAttribute('aria-selected', 'true'))
    expect(library.list('tool').items.map((i) => i.toDTO().name)).toContain('Flat 8')
    await user.click(within(editor()).getByRole('button', { name: 'Duplicate' }))
    await waitFor(() =>
      expect(within(editor()).getByRole('heading', { name: 'Flat 8 copy' })).toBeInTheDocument(),
    )
    await user.click(within(editor()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(row(/Flat 8 copy/)).toHaveAttribute('aria-selected', 'true'))
    await user.click(within(editor()).getByRole('button', { name: 'Remove…' }))
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Remove Flat 8 copy from the library?',
    })
    expect(confirm).toHaveTextContent('Projects keep their copies.')
    await user.click(within(confirm).getByRole('button', { name: 'Remove tool' }))
    await waitFor(() =>
      expect(library.list('tool').items.map((i) => i.toDTO().name)).not.toContain('Flat 8 copy'),
    )
    await expectNoAxeViolations()
  })

  it('a new chamfer mill (U4): offered type with its V-bit hint, angle and tip fields, drawing, Angle column, V-bit search', async () => {
    const { user, row, grid, editor, library } = await renderLibrary()
    await user.click(screen.getByRole('button', { name: 'New tool' }))
    await waitFor(() =>
      expect(within(editor()).getByRole('heading', { name: 'Flat 6' })).toBeInTheDocument(),
    )
    within(editor()).getByRole('combobox', { name: 'Type' }).focus()
    await user.keyboard('{Enter}')
    const list = await screen.findByRole('listbox')
    const option = within(list).getByRole('option', { name: 'Chamfer mill' })
    expect(option).toHaveAccessibleDescription(/V-bit/)
    await user.click(option)
    // angle and tip right after the diameter; the name follows "Chamfer 90° Ø6"
    const labels = within(editor())
      .getAllByRole('textbox')
      .map((i) => i.getAttribute('aria-label') ?? (i as HTMLInputElement).labels?.[0]?.textContent)
    expect(labels.indexOf('Included angle')).toBe(labels.indexOf('Diameter') + 1)
    expect(labels.indexOf('Tip diameter')).toBe(labels.indexOf('Diameter') + 2)
    const tip = within(editor()).getByLabelText('Tip diameter', { selector: 'input' })
    expect(tip).toHaveAttribute('placeholder', '0: pointed')
    await waitFor(() =>
      expect(within(editor()).getByRole('heading', { name: 'Chamfer 90° Ø6' })).toBeInTheDocument(),
    )
    await user.click(within(editor()).getByLabelText('Included angle', { selector: 'input' }))
    expect(
      await within(editor()).findByRole('img', {
        name: 'Tool drawing: included angle highlighted',
      }),
    ).toBeInTheDocument()
    await expectNoAxeViolations()
    await user.click(within(editor()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(row(/Chamfer 90° Ø6/)).toHaveAttribute('aria-selected', 'true'))
    await waitFor(() => expect(row(/Chamfer 90° Ø6/)).not.toHaveTextContent('Unsaved'))
    const saved = library.list('tool').items.map((i) => i.toDTO())
    expect(saved.find((t) => t.name === 'Chamfer 90° Ø6')).toMatchObject({
      type: 'chamferMill',
      angle: { source: '90' },
    })
    // the Angle column: 90° for the chamfer mill, empty for the others
    expect(within(grid()).getByRole('columnheader', { name: /Angle/ })).toBeInTheDocument()
    expect(row(/Chamfer 90° Ø6/)).toHaveTextContent('90°')
    expect(row(/Flat 6/)).not.toHaveTextContent('°')
    // "V-bit" finds chamfer mills
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'v-bit')
    expect(row(/Chamfer 90° Ø6/)).toBeInTheDocument()
    expect(within(grid()).queryByRole('row', { name: /Flat 6/ })).toBeNull()
  })

  it('offers Reload or Overwrite when the item changed elsewhere', async () => {
    const { user, row, editor, d, get, flat6 } = await renderLibrary()
    await user.click(row(/Flat 6/))
    const fl = within(editor()).getByLabelText('Flute length', { selector: 'input' })
    await user.clear(fl)
    await user.type(fl, '24{Enter}')
    // an agent edits the same item
    await d.dispatch(
      'library.tool.update',
      {
        id: flat6,
        revision: 1,
        values: { ...TOOL, name: 'Flat 6', diameter: '6', notes: 'agent' },
      },
      { kind: 'agent', id: 'a1' },
    )
    const alert = await within(editor()).findByRole('alert')
    expect(alert).toHaveTextContent('changed elsewhere')
    await user.click(within(alert).getByRole('button', { name: 'Overwrite' }))
    await waitFor(() => expect(get('tool', flat6).revision).toBe(3))
    expect(get('tool', flat6)).toMatchObject({ fluteLength: { source: '24' } })
  })

  it('answers a close request: Save then close (and quit)', async () => {
    const { user, row, editor, bridge, get, flat6 } = await renderLibrary()
    await user.click(row(/Flat 6/))
    const fl = within(editor()).getByLabelText('Flute length', { selector: 'input' })
    await user.clear(fl)
    await user.type(fl, '21{Enter}')
    bridge.emitLibraryCloseRequest({ name: 'Flat 6', quit: true })
    const prompt = await screen.findByRole('dialog', { name: 'Save changes to Flat 6?' })
    await user.click(within(prompt).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(bridge.libraryCloses).toEqual([true]))
    expect(get('tool', flat6)).toMatchObject({ fluteLength: { source: '21' } })
  })

  it('shows the project’s used items and follows its unit system, switchable (L5)', async () => {
    const { user, row, editor, flat6, bridge } = await renderLibrary({
      project: { key: 'p1', name: 'Bracket', unitSystem: 'inch', used: [] },
    })
    bridge.emitLibraryContext({
      project: { key: 'p1', name: 'Bracket', unitSystem: 'inch', used: [flat6] },
      target: { kind: 'tool', itemId: flat6, seq: 1 },
      tab: 'tool',
    })
    await waitFor(() => expect(row(/Flat 6/)).toHaveAttribute('aria-selected', 'true'))
    expect(row(/Flat 6/)).toHaveTextContent('Used')
    const units = screen.getByRole('radiogroup', { name: 'Units' })
    expect(within(units).getByRole('radio', { name: 'in' })).toHaveAttribute('aria-checked', 'true')
    // a source entered in mm reads with its unit in the inch window
    expect(within(editor()).getByLabelText('Diameter', { selector: 'input' })).toHaveValue('6 mm')
    await user.click(within(units).getByRole('radio', { name: 'mm' }))
    await waitFor(() =>
      expect(within(editor()).getByLabelText('Diameter', { selector: 'input' })).toHaveValue('6'),
    )
    expect(bridge.settingsPatches).toContainEqual({ libraryUnits: 'mm' })
  })

  it('imports GRBL $$ settings into a saved machine: compare, untick, apply only the ticked', async () => {
    const { user, editor, get, add } = await renderLibrary()
    const id = await add('machine', {
      name: 'Router',
      controller: 'grbl',
      travel: { x: '800', y: '800', z: '100' },
      maxFeedRate: { x: '5000', y: '5000', z: '1000' },
      spindle: { control: 'manual', maxSpeed: '30000' },
      programUnits: 'mm',
      toolChanger: 'none',
    })
    await user.click(screen.getByRole('tab', { name: 'Machines' }))
    const grid = await screen.findByRole('grid', { name: 'Machines' })
    await user.click(await within(grid).findByRole('row', { name: /Router/ }))
    // the full form has the new fields
    expect(
      within(editor()).getByLabelText('Junction deviation', { selector: 'input' }),
    ).toHaveValue('')
    expect(
      within(editor()).getByLabelText('Steps per mm X', { selector: 'input' }),
    ).toBeInTheDocument()
    await user.click(within(editor()).getByRole('button', { name: 'Import $$…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Import GRBL settings' })
    const text = within(dialog).getByLabelText('GRBL $$ output')
    // nothing found: a message, still on the paste step
    await user.type(text, 'hello')
    await user.click(within(dialog).getByRole('button', { name: 'Compare' }))
    expect(await within(dialog).findByText(/No GRBL settings found/)).toBeInTheDocument()
    await user.clear(text)
    await user.click(text)
    await user.paste('ok\n$11=0.020\n$110=6000.000 (x max rate)\n$130=700\n$30=24000\n$0=10')
    await user.click(within(dialog).getByRole('button', { name: 'Compare' }))
    const jd = await within(dialog).findByRole('checkbox', {
      name: 'Junction deviation ($11): not set → 0.02 mm',
    })
    const rate = within(dialog).getByRole('checkbox', {
      name: 'Max feed rate X ($110): 5000 mm/min → 6000 mm/min',
    })
    expect(jd).toBeChecked()
    expect(within(dialog).getByText(/Soft limits are off/)).toBeInTheDocument()
    expect(within(dialog).getByText(/a dial router ignores/)).toBeInTheDocument()
    expect(within(dialog).getByText('Not used by DFYOM: $0.')).toBeInTheDocument()
    await expectNoAxeViolations()
    await user.click(rate)
    expect(rate).not.toBeChecked()
    await user.click(within(dialog).getByRole('button', { name: 'Apply 1 change' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const stored = get('machine', id) as unknown as {
      revision: number
      junctionDeviation?: { source: string }
      maxFeedRate: { x: { source: string } }
    }
    expect(stored.revision).toBe(2)
    expect(stored.junctionDeviation?.source).toBe('0.02')
    expect(stored.maxFeedRate.x.source).toBe('5000')
    await waitFor(() =>
      expect(
        within(editor()).getByLabelText('Junction deviation', { selector: 'input' }),
      ).toHaveValue('0.02'),
    )
  })

  it('offers Import $$… only for a saved machine without unsaved changes', async () => {
    const { user, editor } = await renderLibrary()
    await user.click(screen.getByRole('tab', { name: 'Machines' }))
    await screen.findByRole('grid', { name: 'Machines' })
    await user.click(screen.getByRole('button', { name: /New machine/ }))
    expect(within(editor()).getByRole('button', { name: 'Import $$…' })).toBeDisabled()
  })
})
