// Split parts 4a in Design against the fake bridge bound to a real project runtime (core plan
// fixture with the 2D port): "Split part…" in the part inspector, the split editor (add a line,
// the margin), the preview and piece chips, pieces indented under their source in the part menu,
// a read-only piece ("Piece 1 of 4 of Bracket · Edit the split"), with axe on each state. The
// viewport canvas is stubbed. 4c: Split to fit…, the blank chips and their menu, the switch. Doc: docs/conventions/ui.md#split-part-split-parts-4a
import { act, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
import { Ok } from '../../../../shared/result'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { testStock } from '../../../../core/design/design.fixture'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { useDesignPart } from './useDesign'
import { COMMIT_MS, useSplitScene } from './useSplitScene'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: string): Uint8Array } }
  }
).process
const port = loadRegion2dSync(
  fs.getBuiltinModule('node:fs').readFileSync('vendor/cavalier-contours/cavalier_contours.wasm'),
).expect('the vendored 2D module loads')

async function renderSplit(before?: (s: Awaited<ReturnType<typeof planSetup>>) => Promise<void>) {
  const s = await planSetup({ services: { region2d: port } })
  await before?.(s)
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  const shell = createShell(bridge, { region2d: Promise.resolve(Ok(port)) })
  shell.ui.getState().setMode('design')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  const nav = () => screen.getByRole('navigation', { name: 'Navigator' })
  const partRow = () => within(nav()).getByRole('region', { name: 'Part' })
  const split = () => screen.getByRole('region', { name: 'Split' })
  /** The whole split editor (DF110 S4: the Split group, the Joints and Blanks accordions). */
  const editor = () => screen.getByRole('complementary', { name: 'Inspector' })
  /** Opens the Blanks accordion (closed by default, DF110 S4): margin, library stocks. */
  const openBlanks = async () => {
    const b = screen.getByRole('button', { name: /^Blanks/ })
    if (b.getAttribute('aria-expanded') === 'false') await r.user.click(b)
  }
  const openMenu = async () => {
    within(partRow())
      .getByRole('button', { name: /^Parts/ })
      .focus()
    await r.user.keyboard('{Enter}')
    return screen.findByRole('menu', { name: /^Parts/ })
  }
  const callsOf = (name: string) => bridge.calls.filter((c) => c.name === name).map((c) => c.args)
  const pieces = () => Object.values(s.d.doc.parts).filter((p) => p.derivedFrom !== undefined)
  await within(nav()).findByRole('region', { name: 'Part' })
  // test windows are narrow: the inspector is an overlay, opened by its toggle
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  await screen.findByRole('region', { name: 'Split' })
  /** Chooses the lines' joint (a select since 4d: five joints). */
  const lineJoint = async (name: string) => {
    await r.user.click(within(editor()).getByRole('combobox', { name: 'Lines joined by' }))
    await r.user.click(within(await screen.findByRole('listbox')).getByRole('option', { name }))
  }
  return {
    ...r,
    s,
    shell,
    bridge,
    nav,
    partRow,
    split,
    editor,
    openBlanks,
    openMenu,
    callsOf,
    pieces,
    lineJoint,
  }
}

describe('split part (split parts 4a)', () => {
  it('Split part… makes a level at half height; the editor adds a line; preview and chips', async () => {
    const t = await renderSplit()
    const T = 20
    await t.user.click(within(t.split()).getByRole('button', { name: 'Split part…' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(2))
    expect(t.callsOf('design.split.set')).toEqual([
      { partId: t.s.partId, split: { lines: [], levels: [`${-T / 2} mm`], margin: '5 mm' } },
    ])
    const section = t.split()
    expect(within(section).getByRole('heading', { name: 'Split · 2 pieces' })).toBeVisible()
    expect(within(section).getByRole('group', { name: 'Split preview' })).toBeVisible()
    expect(within(section).getByRole('img', { name: 'Split preview: Top' })).toBeVisible()
    // U9 Q132: one row per blank, a numbered chip per piece named by its whole chip text
    const chipList = within(section).getByRole('list', { name: '2 pieces' })
    expect(within(chipList).getAllByRole('listitem')).toHaveLength(1)
    expect(within(chipList).getAllByRole('listitem')[0]!.textContent).toMatch(
      /^12.* × 10 mm · own blank$/,
    )
    expect(
      within(chipList)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      expect.stringMatching(/^1 · .* × 10 mm · own blank$/),
      expect.stringMatching(/^2 · .* × 10 mm · own blank$/),
    ])
    expect(within(section).getByLabelText('Level at Z', { selector: 'input' })).toBeVisible()
    // the level's findings under its field (4a polish): one, its glue face (U9 Q131), and a count
    expect(
      within(section).getByText(/^The glue face at the level at Z -10 mm is 4 mm wide/),
    ).toBeVisible()
    expect(within(section).getByText('4 more in Warnings')).toBeVisible()
    // the warning list names the split, not an "Unknown operation" (design review U9)
    const list = screen.getByRole('region', { name: 'Warnings' })
    await waitFor(() => expect(within(list).getAllByText('Split').length).toBeGreaterThan(0))
    expect(within(list).queryByText('Unknown operation')).toBeNull()
    // focus in its field highlights the level in the viewport preview
    within(section).getByLabelText('Level at Z', { selector: 'input' }).focus()
    expect(t.shell.ui.getState().splitFocus).toEqual({ kind: 'level', index: 0 })
    within(section).getByRole('button', { name: 'Add level' }).focus()
    expect(t.shell.ui.getState().splitFocus).toBeNull()
    await expectNoAxeViolations()
    await t.user.click(within(section).getByRole('button', { name: 'Add line at X' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(4))
    expect(t.callsOf('design.split.set').at(-1)).toMatchObject({
      split: { lines: [{ axis: 'x', at: '50 mm' }] },
    })
    expect(within(t.split()).getByRole('heading', { name: 'Split · 4 pieces' })).toBeVisible()
    await expectNoAxeViolations()
  })

  it('lists pieces under their source; a piece is read-only and leads back to the split', async () => {
    const t = await renderSplit()
    await t.user.click(within(t.split()).getByRole('button', { name: 'Split part…' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(2))
    const menu = await t.openMenu()
    const items = within(menu).getAllByRole('menuitemradio')
    expect(items.map((i) => i.textContent)).toEqual(['Bracket', 'Bracket · 1', 'Bracket · 2'])
    expect(items.map((i) => i.hasAttribute('data-inset'))).toEqual([false, true, true])
    await expectNoAxeViolations()
    await t.user.click(items[1]!)
    const inspector = await screen.findByText('Piece 1 of 2 of Bracket')
    expect(inspector).toBeVisible()
    // no Add menu on a piece; the navigator says why
    expect(within(t.nav()).queryByRole('button', { name: 'Add operation' })).toBeNull()
    expect(within(t.nav()).getByText('Read-only: this piece follows Bracket.')).toBeVisible()
    // its rows select only: no grip, no row menu, no Delete or Alt+↑/↓ (the core would refuse)
    const list = within(t.nav()).getByRole('list', { name: 'Operations in design order' })
    expect(within(list).queryAllByTitle('Drag to reorder (Alt+↑/↓)')).toHaveLength(0)
    const rows = within(list).getAllByRole('button')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.getAttribute('aria-keyshortcuts') ?? '').not.toMatch(/Alt|Delete|Shift\+F10/)
      expect(row.closest('[data-row-menu]')).toBeNull()
    }
    const before = t.bridge.calls.length
    rows[0]!.focus()
    await t.user.keyboard('{Delete}{Alt>}{ArrowDown}{/Alt}{Shift>}{F10}{/Shift}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(t.bridge.calls.slice(before).filter((c) => /remove|move/.test(c.name))).toEqual([])
    await expectNoAxeViolations()
    await t.user.click(screen.getByRole('button', { name: 'Edit the split' }))
    await waitFor(() => expect(t.shell.ui.getState().designPart).toBe(t.s.partId))
    expect(within(t.split()).getByRole('heading', { name: 'Split · 2 pieces' })).toBeVisible()
  })

  it('Split part… is in the part menu; the part row’s context menu then offers Edit the split', async () => {
    const t = await renderSplit()
    const menu = await t.openMenu()
    await t.user.click(within(menu).getByRole('menuitem', { name: /^Split part…/ }))
    await waitFor(() => expect(t.pieces()).toHaveLength(2))
    expect(t.callsOf('design.split.set')).toHaveLength(1)
    expect(within(t.split()).getByRole('heading', { name: 'Split · 2 pieces' })).toBeVisible()
    // the part row: Shift+F10 opens its menu with Edit the split
    within(t.partRow()).getByRole('button', { name: 'Bracket' }).focus()
    await t.user.keyboard('{Shift>}{F10}{/Shift}')
    const rowMenu = await screen.findByRole('menu', { name: 'Actions for Bracket' })
    expect(within(rowMenu).getByRole('menuitem', { name: 'Edit the split' })).toBeVisible()
    await expectNoAxeViolations()
    await t.user.keyboard('{Escape}')
    // on a piece the entry leads to its source
    await t.user.click(within(await t.openMenu()).getAllByRole('menuitemradio')[2]!)
    await screen.findByText('Piece 2 of 2 of Bracket')
    await t.user.click(within(await t.openMenu()).getByRole('menuitem', { name: 'Edit the split' }))
    await waitFor(() => expect(t.shell.ui.getState().designPart).toBe(t.s.partId))
  })

  it('the viewport drag: a live preview, snapped, committed as one gesture; Escape reverts', async () => {
    const t = await renderSplit()
    await t.user.click(within(t.split()).getByRole('button', { name: 'Split part…' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(2))
    // the design scene's split overlay, as the viewport gets it (the canvas is stubbed here)
    let scene: ReturnType<typeof useSplitScene> | undefined
    function Probe() {
      scene = useSplitScene(useDesignPart(), true, [])
      return null
    }
    renderUi(
      <ShellProvider shell={t.shell}>
        <Probe />
      </ShellProvider>,
    )
    await waitFor(() => expect(scene?.split?.cuts).toHaveLength(1))
    expect(scene!.split!.cells).toHaveLength(2)
    expect(scene!.summary).toMatch(/^Split preview: 2 pieces pulled apart\./)
    const sets = () => t.bridge.calls.filter((c) => c.name === 'design.split.set')
    const before = sets().length
    // press, move (within COMMIT_MS of the press: preview only), release: one commit, snapped
    act(() => scene!.split!.onDrag('start', 'level-0', -10, { alt: false }))
    act(() => scene!.split!.onDrag('move', 'level-0', -6.4, { alt: false }))
    expect(scene!.split!.cuts[0]).toMatchObject({ at: -6, dragging: true })
    expect(sets()).toHaveLength(before)
    act(() => scene!.split!.onDrag('end', 'level-0', -6.4, { alt: false }))
    await waitFor(() => expect(sets()).toHaveLength(before + 1))
    expect(sets().at(-1)).toMatchObject({
      args: { split: { levels: ['-6 mm'] } },
      gesture: expect.stringMatching(/^split-drag-/),
    })
    await waitFor(() => expect(scene!.split!.cuts[0]).toMatchObject({ at: -6, dragging: false }))
    // the field follows
    expect(within(t.split()).getByLabelText('Level at Z', { selector: 'input' })).toHaveValue(
      '-6 mm',
    )
    // a longer drag commits on the way (Alt: no snapping); Escape reverts the whole gesture
    act(() => scene!.split!.onDrag('start', 'level-0', -6, { alt: false }))
    await new Promise((r) => setTimeout(r, COMMIT_MS + 20))
    act(() => scene!.split!.onDrag('move', 'level-0', -12.346, { alt: true }))
    await waitFor(() =>
      expect(sets().at(-1)).toMatchObject({ args: { split: { levels: ['-12.35 mm'] } } }),
    )
    act(() => scene!.split!.onDrag('cancel', 'level-0', -6, { alt: false }))
    await waitFor(() =>
      expect(t.bridge.calls.at(-1)).toMatchObject({
        name: 'history.undo',
        args: { gesture: expect.stringMatching(/^split-drag-/) },
      }),
    )
    await waitFor(() => expect(scene!.split!.cuts[0]).toMatchObject({ at: -6, dragging: false }))
  })

  it('Remove split removes the pieces in one command', async () => {
    const t = await renderSplit()
    await t.user.click(within(t.split()).getByRole('button', { name: 'Split part…' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(2))
    // P10: the destructive action last, after the Split, Joints and Blanks groups, untitled
    const remove = screen.getByRole('region', { name: 'Remove split' })
    expect(within(t.split()).queryByRole('button', { name: 'Remove split' })).toBeNull()
    const blanks = screen.getByRole('region', { name: /^Blanks/ })
    expect(blanks.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await t.user.click(within(remove).getByRole('button', { name: 'Remove split' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(0))
    expect(screen.queryByRole('region', { name: 'Remove split' })).toBeNull()
    expect(t.callsOf('design.split.set').at(-1)).toEqual({ partId: t.s.partId, split: null })
    expect(within(t.split()).getByRole('button', { name: 'Split part…' })).toBeVisible()
  })

  it('Add curved line (4e): a new open shape and a line along it in one undo step', async () => {
    const t = await renderSplit()
    await t.user.click(within(t.split()).getByRole('button', { name: 'Split part…' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(2))
    const entries = t.s.d.history.undoable.length
    await t.user.click(within(t.split()).getByRole('button', { name: 'Add curved line' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(4))
    const add = t.bridge.calls.filter((c) => c.name === 'design.shape.add').at(-1)!
    const set = t.bridge.calls.filter((c) => c.name === 'design.split.set').at(-1)!
    expect(add.gesture).toEqual(expect.any(String))
    expect(set.gesture).toBe(add.gesture)
    expect(set.args).toMatchObject({ split: { lines: [{ shape: 'shape1' }] } })
    expect(t.s.d.history.undoable).toHaveLength(entries + 1)
    // the row: the shape picked by name, Edit shape and remove; the preview draws its path
    const section = t.split()
    expect(within(section).getByRole('combobox', { name: 'Line along shape' })).toHaveTextContent(
      'Split curve 1',
    )
    expect(within(section).getByRole('button', { name: 'Edit shape' })).toBeVisible()
    expect(
      within(section).getByRole('button', { name: 'Remove line along Split curve 1' }),
    ).toBeVisible()
    // its only shape is used: no "Line along shape" to add
    expect(within(section).queryByRole('button', { name: 'Line along shape' })).toBeNull()
    await expectNoAxeViolations()
    await t.user.click(
      within(section).getByRole('button', { name: 'Remove line along Split curve 1' }),
    )
    await waitFor(() => expect(t.pieces()).toHaveLength(2))
    // the shape stays: it can be a line again
    expect(within(t.split()).getByRole('button', { name: 'Line along shape' })).toBeVisible()
  })

  it('dowels on the level (4b): the joint control, Ø and depth, positions, Place again', async () => {
    const t = await renderSplit()
    await t.user.click(within(t.split()).getByRole('button', { name: 'Split part…' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(2))
    const joint = () => within(t.editor()).getByRole('group', { name: 'Levels joined by' })
    await t.user.click(within(joint()).getByRole('radio', { name: 'Dowels' }))
    await waitFor(() => expect(t.s.part().split?.joint.dowels).toBeDefined())
    expect(t.callsOf('design.split.set').at(-1)).toMatchObject({ split: { dowels: {} } })
    const section = t.editor()
    expect(within(section).getByLabelText('Dowel Ø', { selector: 'input' })).toBeVisible()
    expect(within(section).getByLabelText('Hole depth', { selector: 'input' })).toBeVisible()
    const holes = t.s.part().split!.joint.dowels!.holes
    // the level's read-out and the positions list (one X and Y field per hole)
    expect(within(section).getByText(holes.length === 1 ? '1 dowel' : `${holes.length} dowels`))
    expect(within(section).getByText(`Dowel positions (${holes.length})`)).toBeInTheDocument()
    expect(
      within(section).queryAllByLabelText(/^Dowel \d+ X$/, { selector: 'input' }),
    ).toHaveLength(holes.length)
    await expectNoAxeViolations()
    // a new Ø lets the depth default for it; the holes are kept
    const dia = within(section).getByLabelText('Dowel Ø', { selector: 'input' })
    await t.user.clear(dia)
    await t.user.type(dia, '4{Enter}')
    await waitFor(() =>
      expect(t.callsOf('design.split.set').at(-1)).toMatchObject({
        split: { dowels: { diameter: '4', holes: expect.any(Array) } },
      }),
    )
    expect(t.callsOf('design.split.set').at(-1)).not.toHaveProperty('split.dowels.depth')
    await t.user.click(within(t.editor()).getByRole('button', { name: 'Place dowels again' }))
    await waitFor(() =>
      expect(t.callsOf('design.split.set').at(-1)).not.toHaveProperty('split.dowels.holes'),
    )
    // Butt again: no dowels sent, none kept
    await t.user.click(within(joint()).getByRole('radio', { name: 'Butt' }))
    await waitFor(() => expect(t.s.part().split?.joint.dowels).toBeUndefined())
    expect(t.callsOf('design.split.set').at(-1)).not.toHaveProperty('split.dowels')
    await expectNoAxeViolations()
  })

  it('a set joint’s settings are collapsed with a one-line summary; a click opens them (U9 Q131)', async () => {
    const t = await renderSplit(async (s) => {
      await s.run('design.split.set', {
        partId: s.partId,
        split: { lines: [], levels: ['-10 mm'], margin: '5 mm', dowels: {} },
      })
    })
    const section = t.editor()
    const settings = within(section).getByText('Dowel settings')
    // DF110 S4: Joints an open accordion, Blanks a closed one, each with its summary
    expect(within(section).getByRole('button', { name: /^Joints/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    const blanks = within(section).getByRole('button', { name: /^Blanks/ })
    expect(blanks).toHaveAttribute('aria-expanded', 'false')
    expect(blanks).toHaveTextContent('Margin 5 mm · own blocks')
    expect(within(section).getByText(/^Ø.* mm · .* mm deep · \d+ holes?$/)).toBeVisible()
    expect(within(section).getByLabelText('Dowel Ø', { selector: 'input' })).not.toBeVisible()
    await t.user.click(settings)
    await waitFor(() =>
      expect(within(section).getByLabelText('Dowel Ø', { selector: 'input' })).toBeVisible(),
    )
    // the library stocks come after the cuts
    const level = within(section).getByLabelText('Level at Z', { selector: 'input' })
    await t.openBlanks()
    const stocks = within(section).getByRole('switch', { name: 'Use library stocks' })
    expect(level.compareDocumentPosition(stocks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await expectNoAxeViolations()
  })

  it('keys on lines (4b-2): Puzzle / Dovetail, the clearance kept by later edits, Butt drops it', async () => {
    const t = await renderSplit()
    await t.user.click(within(t.split()).getByRole('button', { name: 'Split part…' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(2))
    // the lines' joint shows once there is a line
    expect(within(t.editor()).queryByRole('group', { name: 'Lines joined by' })).toBeNull()
    await t.user.click(within(t.split()).getByRole('button', { name: 'Add line at X' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(4))
    expect(within(t.editor()).getByRole('group', { name: 'Lines joined by' })).toBeVisible()
    await t.lineJoint('Puzzle')
    await waitFor(() => expect(t.s.part().split?.joint.kind).toBe('puzzle'))
    expect(t.callsOf('design.split.set').at(-1)).toMatchObject({ split: { joint: 'puzzle' } })
    const section = t.editor()
    const clearance = within(section).getByLabelText('Key clearance', { selector: 'input' })
    expect(clearance).toHaveValue('0.15 mm')
    // the read-out: the keys placed (with their tool) or why none fits, and a count per line
    expect(within(section).getByText(/needs a tool of Ø|No key fits yet/)).toBeVisible()
    expect(within(section).getByText(/^\d+ keys?$/)).toBeVisible()
    await expectNoAxeViolations()
    await t.user.clear(clearance)
    await t.user.type(clearance, '0.2{Enter}')
    await waitFor(() =>
      expect(t.callsOf('design.split.set').at(-1)).toMatchObject({
        split: { joint: 'puzzle', clearance: '0.2' },
      }),
    )
    // a later edit sends the joint and the clearance it shows
    await t.lineJoint('Dovetail')
    await waitFor(() => expect(t.s.part().split?.joint.kind).toBe('dovetail'))
    await t.openBlanks()
    const margin = within(t.editor()).getByLabelText('Blank margin', { selector: 'input' })
    await t.user.clear(margin)
    await t.user.type(margin, '6{Enter}')
    await waitFor(() =>
      expect(t.callsOf('design.split.set').at(-1)).toMatchObject({
        split: { margin: '6', joint: 'dovetail', clearance: '0.2' },
      }),
    )
    await t.lineJoint('Butt')
    await waitFor(() => expect(t.s.part().split?.joint.kind).toBe('butt'))
    expect(t.callsOf('design.split.set').at(-1)).not.toHaveProperty('split.joint')
    expect(t.callsOf('design.split.set').at(-1)).not.toHaveProperty('split.clearance')
    await expectNoAxeViolations()
  })

  it('Test fit… (4b-3): one or three coupon parts of the key; the first is shown', async () => {
    const t = await renderSplit()
    await t.user.click(within(t.split()).getByRole('button', { name: 'Split part…' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(2))
    await t.user.click(within(t.split()).getByRole('button', { name: 'Add line at X' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(4))
    expect(within(t.editor()).getByRole('group', { name: 'Lines joined by' })).toBeVisible()
    // butt lines: no Test fit
    expect(within(t.editor()).queryByRole('button', { name: 'Test fit…' })).toBeNull()
    await t.lineJoint('Puzzle')
    await waitFor(() => expect(t.s.part().split?.joint.kind).toBe('puzzle'))
    await t.user.click(within(t.editor()).getByRole('button', { name: 'Test fit…' }))
    const menu = await screen.findByRole('menu', { name: 'Test fit…' })
    expect(within(menu).getByRole('menuitem', { name: 'One coupon at 0.15 mm' })).toBeVisible()
    await expectNoAxeViolations()
    await t.user.click(
      within(menu).getByRole('menuitem', { name: '3 coupons: 0.1 mm, 0.15 mm, 0.2 mm' }),
    )
    await waitFor(() =>
      expect(t.callsOf('design.split.testFit')).toEqual([
        { partId: t.s.partId, clearances: ['0.1 mm', '0.15 mm', '0.2 mm'] },
      ]),
    )
    const coupons = Object.values(t.s.d.doc.parts).filter((p) =>
      / · test fit [\d.]+ mm$/.test(p.name),
    )
    expect(coupons.map((p) => p.name.replace(/^.* · /, ''))).toEqual([
      'test fit 0.1 mm',
      'test fit 0.15 mm',
      'test fit 0.2 mm',
    ])
    // the first coupon shows: an ordinary split source with its own Split section
    await waitFor(() => expect(t.shell.ui.getState().designPart).toBe(coupons[0]!.id))
    await waitFor(() =>
      expect(within(t.split()).getByRole('heading', { name: 'Split · 2 pieces' })).toBeVisible(),
    )
    expect(within(t.editor()).getByLabelText('Key clearance', { selector: 'input' })).toHaveValue(
      '0.1 mm',
    )
    await expectNoAxeViolations()
  })

  it('blanks on library stocks (4c): Split to fit…, the chips name the blank, the menu, the switch', async () => {
    const ids: Record<string, string> = {}
    const t = await renderSplit(async (s) => {
      for (const [k, l, w, th] of [
        ['plate', '120', '80', '10'],
        ['big', '200', '100', '20'],
      ] as const)
        ids[k] = (
          (await s.run('library.stock.add', {
            values: {
              ...testStock(),
              name: `Plate ${l} × ${w} × ${th}`,
              length: l,
              width: w,
              thickness: th,
            },
          })) as { id: string }
        ).id
    })
    await t.user.click(within(t.split()).getByRole('button', { name: 'Split to fit…' }))
    const fit = await screen.findByRole('menu', { name: 'Split to fit…' })
    await expectNoAxeViolations()
    await t.user.click(within(fit).getByRole('menuitem', { name: /^Plate 120 × 80 × 10 · / }))
    await waitFor(() => expect(t.pieces()).toHaveLength(2))
    expect(t.callsOf('design.split.suggest')).toEqual([
      { partId: t.s.partId, stockLibraryItemId: ids['plate'] },
    ])
    expect(t.callsOf('design.split.set')).toEqual([
      {
        partId: t.s.partId,
        split: { lines: [], levels: ['-10 mm'], margin: '5 mm', useStocks: true },
      },
    ])
    const chips = () =>
      within(within(t.split()).getByRole('list', { name: '2 pieces' })).getAllByRole('button')
    const name = (c: HTMLElement) => c.getAttribute('aria-label')
    expect(chips().map(name)).toEqual([
      '1 · 120 × 80 × 10 mm · Plate 120 × 80 × 10',
      '2 · 120 × 80 × 10 mm · Plate 120 × 80 × 10',
    ])
    await t.openBlanks()
    expect(within(t.editor()).getByRole('switch', { name: 'Use library stocks' })).toBeChecked()
    await expectNoAxeViolations()
    // the first piece on the bigger plate, by hand
    await t.user.click(chips()[0]!)
    // the menu is named by its chip (Radix labels it by the trigger)
    const menu = await screen.findByRole('menu', { name: /^1 · 120 × 80 × 10 mm/ })
    expect(within(menu).getByRole('menuitemradio', { name: 'Automatic' })).toBeChecked()
    await expectNoAxeViolations()
    await t.user.click(within(menu).getByRole('menuitemradio', { name: 'Plate 200 × 100 × 20' }))
    const first = t.pieces().find((p) => p.derivedFrom?.index === 1)!
    await waitFor(() =>
      expect(t.callsOf('design.part.update')).toEqual([
        { partId: first.id, blank: { stockLibraryItemId: ids['big'] } },
      ]),
    )
    await waitFor(() =>
      expect(name(chips()[0]!)).toBe('1 · 200 × 100 × 20 mm · Plate 200 × 100 × 20'),
    )
    // library stocks off: the chosen blank stays, the other piece is back on its own block
    await t.user.click(within(t.editor()).getByRole('switch', { name: 'Use library stocks' }))
    await waitFor(() => expect(name(chips()[1]!)).toMatch(/^2 · .* · own blank$/))
    expect(name(chips()[0]!)).toMatch(/Plate 200 × 100 × 20$/)
    // two blanks: two rows
    expect(
      within(within(t.split()).getByRole('list', { name: '2 pieces' })).getAllByRole('listitem'),
    ).toHaveLength(2)
  })

  it('fingers and a half lap on lines (4d): the select, their settings and read-outs, no Test fit for a lap', async () => {
    const t = await renderSplit()
    await t.user.click(within(t.split()).getByRole('button', { name: 'Split part…' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(2))
    await t.user.click(within(t.split()).getByRole('button', { name: 'Add line at X' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(4))
    await t.user.click(within(t.editor()).getByRole('combobox', { name: 'Lines joined by' }))
    const list = await screen.findByRole('listbox')
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'Butt',
      'Puzzle',
      'Dovetail',
      expect.stringMatching(/^Finger/),
      expect.stringMatching(/^Half lap/),
    ])
    await expectNoAxeViolations()
    await t.user.click(within(list).getByRole('option', { name: /^Finger/ }))
    await waitFor(() => expect(t.s.part().split?.joint.kind).toBe('finger'))
    expect(t.callsOf('design.split.set').at(-1)).toMatchObject({ split: { joint: 'finger' } })
    let section = t.editor()
    expect(within(section).getByText('Finger settings')).toBeVisible()
    expect(within(section).getByLabelText('Joint clearance', { selector: 'input' })).toHaveValue(
      '0.15 mm',
    )
    expect(within(section).getByText(/T-bones for the Ø|No fingers fit yet/)).toBeVisible()
    expect(within(section).getByRole('button', { name: 'Test fit…' })).toBeVisible()
    await expectNoAxeViolations()
    await t.lineJoint('Half lap')
    await waitFor(() => expect(t.s.part().split?.joint.kind).toBe('halfLap'))
    section = t.editor()
    expect(within(section).getByText('Lap settings')).toBeVisible()
    expect(
      within(section).getByText(/cut from its bottom \(a flip\)|No half lap fits yet/),
    ).toBeVisible()
    expect(within(section).queryByRole('button', { name: 'Test fit…' })).toBeNull()
    await expectNoAxeViolations()
  })

  it('Detach (4d): the piece inspector’s button makes a piece a plain part', async () => {
    const t = await renderSplit()
    await t.user.click(within(t.split()).getByRole('button', { name: 'Split part…' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(2))
    await t.user.click(within(await t.openMenu()).getAllByRole('menuitemradio')[2]!)
    expect(await screen.findByText('Piece 2 of 2 of Bracket')).toBeVisible()
    const piece = t.pieces()[1]!
    await t.user.click(screen.getByRole('button', { name: 'Detach' }))
    await waitFor(() => expect(t.s.d.doc.parts[piece.id]!.derivedFrom).toBeUndefined())
    expect(t.callsOf('design.part.update').at(-1)).toEqual({ partId: piece.id, detach: true })
    expect(t.s.part().split!.detached).toEqual([2])
    // a plain part now: its inspector, no piece line
    await waitFor(() => expect(screen.queryByText('Piece 2 of 2 of Bracket')).toBeNull())
    await expectNoAxeViolations()
  })
})
