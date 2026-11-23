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

  it('keeps material, coating and notes in a collapsed Details group, open across items and tabs (DF1)', async () => {
    const { user, row, editor, add } = await renderLibrary()
    await add('tool', {
      ...TOOL,
      name: 'Flat 8',
      diameter: '8',
      toolMaterial: 'carbide',
      coating: 'TiAlN',
      notes: 'From the red box',
    })
    await user.click(await waitFor(() => row(/Flat 8/)))
    const details = () => within(editor()).getByRole('button', { name: /^Details/ })
    // closed: the cutting geometry and presets show, the secondary fields do not; the heading
    // names what it holds
    expect(details()).toHaveAttribute('aria-expanded', 'false')
    expect(details()).toHaveTextContent('Details· Carbide · TiAlN')
    expect(within(editor()).getByLabelText('Diameter', { selector: 'input' })).toBeInTheDocument()
    expect(within(editor()).getByRole('heading', { name: 'Presets' })).toBeInTheDocument()
    expect(within(editor()).queryByRole('combobox', { name: 'Tool material' })).toBeNull()
    expect(within(editor()).queryByLabelText('Coating')).toBeNull()
    expect(within(editor()).queryByLabelText('Notes')).toBeNull()
    await user.click(details())
    expect(details()).toHaveAttribute('aria-expanded', 'true')
    expect(details()).toHaveTextContent(/^Details$/)
    expect(within(editor()).getByRole('combobox', { name: 'Tool material' })).toHaveTextContent(
      'Carbide',
    )
    expect(within(editor()).getByLabelText('Coating')).toHaveValue('TiAlN')
    expect(within(editor()).getByLabelText('Notes')).toHaveValue('From the red box')
    await expectNoAxeViolations()
    // remembered in this window: another item, another tab and back
    await user.click(row(/Flat 6/))
    await waitFor(() =>
      expect(within(editor()).getByRole('heading', { name: 'Flat 6' })).toBeInTheDocument(),
    )
    expect(details()).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('tab', { name: 'Stock' }))
    await user.click(screen.getByRole('tab', { name: 'Tools' }))
    await waitFor(() => expect(details()).toHaveAttribute('aria-expanded', 'true'))
    await user.click(details())
    expect(within(editor()).queryByRole('combobox', { name: 'Tool material' })).toBeNull()
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
    // the library has a Flat 6: the default name never repeats it (DF47)
    await waitFor(() =>
      expect(within(editor()).getByRole('heading', { name: 'Flat 6 (2)' })).toBeInTheDocument(),
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

  it('DF47: a typed name that repeats another item’s saves, with a soft warning at Name', async () => {
    const { user, row, editor, library } = await renderLibrary()
    await user.click(screen.getByRole('button', { name: 'New tool' }))
    const name = await within(editor()).findByRole('textbox', { name: 'Name' })
    expect(name).toHaveValue('Flat 6 (2)')
    expect(within(editor()).queryByText(/already named/)).toBeNull()
    await user.clear(name)
    await user.type(name, 'flat 6 ')
    expect(
      within(editor()).getByText(
        'Another tool is already named flat 6: a different name tells them apart in lists.',
      ),
    ).toBeInTheDocument()
    await expectNoAxeViolations()
    await user.click(within(editor()).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(library.list('tool').items.map((i) => i.toDTO().name)).toEqual(
        expect.arrayContaining(['Flat 6', 'flat 6']),
      ),
    )
    expect(row(/^flat 6/)).toHaveAttribute('aria-selected', 'true')
  })

  it('lists stock variants under their parent; New variant; a parent with variants is kept (DF13)', async () => {
    const { user, editor, add, library } = await renderLibrary()
    const block = {
      shape: 'block',
      length: '300',
      width: '200',
      thickness: '10',
      material: { name: '5083', class: 'aluminum' },
    }
    await add('stock', { ...block, name: 'Zinc plate' })
    const plate = await add('stock', { ...block, name: 'Aluminium plate 10' })
    await user.click(screen.getByRole('tab', { name: 'Stock' }))
    const grid = () => screen.getByRole('grid', { name: 'Stock' })
    const rows = () =>
      within(grid())
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.getAttribute('aria-label') ?? r.textContent)
    await user.click(await within(grid()).findByRole('row', { name: /^Aluminium plate 10/ }))
    await user.click(within(editor()).getByRole('button', { name: 'New variant' }))
    await waitFor(() =>
      expect(
        within(editor()).getByRole('heading', { name: 'Aluminium plate 10 variant' }),
      ).toBeInTheDocument(),
    )
    const length = within(editor()).getByLabelText('Length (X)', { selector: 'input' })
    await user.clear(length)
    await user.type(length, '150{Enter}')
    await user.click(within(editor()).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(
        library
          .list('stock')
          .items.find((i) => i.parentId.isSome())
          ?.parentId.unwrap(),
      ).toBe(plate),
    )
    // the variant follows its parent (before Zinc plate), named as a variant of it
    await waitFor(() =>
      expect(rows()).toEqual([
        expect.stringMatching(/^Aluminium plate 10/),
        'Aluminium plate 10 variant, variant of Aluminium plate 10',
        expect.stringMatching(/^Zinc plate/),
      ]),
    )
    expect(
      within(editor()).getByRole('button', { name: 'Variant of Aluminium plate 10' }),
    ).toBeInTheDocument()
    await expectNoAxeViolations()
    // the parent link selects the parent; with a variant it cannot be removed
    await user.click(
      within(editor()).getByRole('button', { name: 'Variant of Aluminium plate 10' }),
    )
    await waitFor(() =>
      expect(
        within(editor()).getByRole('heading', { name: 'Aluminium plate 10' }),
      ).toBeInTheDocument(),
    )
    const remove = within(editor()).getByRole('button', { name: 'Remove…' })
    expect(remove).toBeDisabled()
    expect(remove).toHaveAttribute('title', 'Remove its variants first.')
  })

  it('a new chamfer mill (U4): offered type with its V-bit hint, angle and tip fields, drawing, Angle column, V-bit search', async () => {
    const { user, row, grid, editor, library } = await renderLibrary()
    await user.click(screen.getByRole('button', { name: 'New tool' }))
    // the library has a Flat 6: the default name never repeats it (DF47)
    await waitFor(() =>
      expect(within(editor()).getByRole('heading', { name: 'Flat 6 (2)' })).toBeInTheDocument(),
    )
    within(editor()).getByRole('combobox', { name: 'Type' }).focus()
    await user.keyboard('{Enter}')
    const list = await screen.findByRole('listbox')
    const option = within(list).getByRole('option', { name: 'Chamfer mill' })
    expect(option).toHaveAccessibleDescription(/V-bit/)
    await user.click(option)
    // angle and tip right after the diameter; the name follows "Chamfer 90° Ø6"
    // value fields are comboboxes (their adjust panel), text fields textboxes: every text input
    const labels = [...editor().querySelectorAll<HTMLInputElement>('input[type="text"]')].map(
      (i) => i.getAttribute('aria-label') ?? (i as HTMLInputElement).labels?.[0]?.textContent,
    )
    expect(labels.indexOf('Included angle')).toBe(labels.indexOf('Diameter') + 1)
    expect(labels.indexOf('Tip diameter')).toBe(labels.indexOf('Diameter') + 2)
    const tip = within(editor()).getByLabelText('Tip diameter', { selector: 'input' })
    expect(tip).toHaveAttribute('placeholder', '0: pointed')
    // an empty stickout shows the flute length it takes, marked as the default (DF48)
    expect(within(editor()).getByLabelText('Stickout', { selector: 'input' })).toHaveAttribute(
      'placeholder',
      expect.stringMatching(/^Default: [\d.]+ mm$/),
    )
    await waitFor(() =>
      expect(within(editor()).getByRole('heading', { name: 'Chamfer 90° Ø6' })).toBeInTheDocument(),
    )
    await user.click(within(editor()).getByLabelText('Included angle', { selector: 'input' }))
    expect(
      await within(editor()).findByRole('img', {
        name: 'Tool drawing: included angle highlighted',
      }),
    ).toBeInTheDocument()
    // the legend names the drawing's ISO symbols (DF48)
    const legend = editor().querySelector<HTMLElement>(
      'dl[aria-label="Dimensions in the drawing"]',
    )!
    expect(legend).toHaveTextContent('DCDiameter')
    expect(legend).toHaveTextContent('LCFFlute length')
    // the draft row shows its type icon like a saved one (DF48)
    expect(row(/Chamfer 90° Ø6/).querySelector('[title="Chamfer mill"] svg')).not.toBeNull()
    // short headers explain themselves (DF48)
    expect(
      within(grid()).getByRole('button', { name: 'Sort by Corner radius (RE)' }),
    ).toHaveAttribute('title', 'Corner radius (RE)')
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
    // the library is app-wide: the window never shows the opener's project name (D45)
    expect(screen.queryByText(/Bracket/)).not.toBeInTheDocument()
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
