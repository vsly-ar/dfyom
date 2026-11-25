// Split parts 4a in Design against the fake bridge bound to a real project runtime (core plan
// fixture with the 2D port): "Split part…" in the part inspector, the split editor (add a line,
// the margin), the preview and piece chips, pieces indented under their source in the part menu,
// a read-only piece ("Piece 1 of 4 of Bracket · Edit the split"), with axe on each state. The
// viewport canvas is stubbed. Doc: docs/conventions/ui.md#split-part-split-parts-4a
import { act, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
import { Ok } from '../../../../shared/result'
import { planSetup } from '../../../../core/plan/plan.fixture'
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

async function renderSplit() {
  const s = await planSetup({ services: { region2d: port } })
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
  return { ...r, s, shell, bridge, nav, partRow, split, openMenu, callsOf, pieces }
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
    expect(
      within(within(section).getByRole('list', { name: '2 pieces' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringMatching(/^1 · .* × 10 mm · own blank$/),
      expect.stringMatching(/^2 · .* × 10 mm · own blank$/),
    ])
    expect(within(section).getByLabelText('Level at Z', { selector: 'input' })).toBeVisible()
    // the level's findings under its field (4a polish), at most three and a count
    expect(
      within(section).getByText(/^The glue face at level -10 is about 4 mm wide/),
    ).toBeVisible()
    expect(within(section).getByText('2 more in Warnings')).toBeVisible()
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
    await t.user.click(within(t.split()).getByRole('button', { name: 'Remove split' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(0))
    expect(t.callsOf('design.split.set').at(-1)).toEqual({ partId: t.s.partId, split: null })
    expect(within(t.split()).getByRole('button', { name: 'Split part…' })).toBeVisible()
  })

  it('dowels on the level (4b): the joint control, Ø and depth, positions, Place again', async () => {
    const t = await renderSplit()
    await t.user.click(within(t.split()).getByRole('button', { name: 'Split part…' }))
    await waitFor(() => expect(t.pieces()).toHaveLength(2))
    const joint = () => within(t.split()).getByRole('group', { name: 'Levels joined by' })
    await t.user.click(within(joint()).getByRole('radio', { name: 'Dowels' }))
    await waitFor(() => expect(t.s.part().split?.joint.dowels).toBeDefined())
    expect(t.callsOf('design.split.set').at(-1)).toMatchObject({ split: { dowels: {} } })
    const section = t.split()
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
    await t.user.click(within(t.split()).getByRole('button', { name: 'Place dowels again' }))
    await waitFor(() =>
      expect(t.callsOf('design.split.set').at(-1)).not.toHaveProperty('split.dowels.holes'),
    )
    // Butt again: no dowels sent, none kept
    await t.user.click(within(joint()).getByRole('radio', { name: 'Butt' }))
    await waitFor(() => expect(t.s.part().split?.joint.dowels).toBeUndefined())
    expect(t.callsOf('design.split.set').at(-1)).not.toHaveProperty('split.dowels')
    await expectNoAxeViolations()
  })
})
