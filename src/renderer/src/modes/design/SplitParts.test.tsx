// Split parts 4a in Design against the fake bridge bound to a real project runtime (core plan
// fixture with the 2D port): "Split part…" in the part inspector, the split editor (add a line,
// the margin), the preview and piece chips, pieces indented under their source in the part menu,
// a read-only piece ("Piece 1 of 4 of Bracket · Edit the split"), with axe on each state. The
// viewport canvas is stubbed. Doc: docs/conventions/ui.md#split-part-split-parts-4a
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
import { Ok } from '../../../../shared/result'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'

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
  return { ...r, s, shell, nav, partRow, split, openMenu, callsOf, pieces }
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
      within(section)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringMatching(/^1 · .* × 10 mm · own blank$/),
      expect.stringMatching(/^2 · .* × 10 mm · own blank$/),
    ])
    expect(within(section).getByLabelText('Level at Z', { selector: 'input' })).toBeVisible()
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
    await expectNoAxeViolations()
    await t.user.click(screen.getByRole('button', { name: 'Edit the split' }))
    await waitFor(() => expect(t.shell.ui.getState().designPart).toBe(t.s.partId))
    expect(within(t.split()).getByRole('heading', { name: 'Split · 2 pieces' })).toBeVisible()
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
})
