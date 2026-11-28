// The Line inspector's geometry (engraved-patterns.md § Simple Line, DF147) against the fake bridge
// bound to a real dispatcher with the node 2D port. SL1: the Path picker's "New shape…" (an open
// path, picked here and opened in the Shape Editor, one undo step), "Edit shape…" and the "Edit in
// Shape Editor" button; the pocket picker's "Edit shape…". The 3D canvas is stubbed.
// Doc: docs/modes/engraved-patterns.md#simple-line-straight-and-arc-hardening-df147,
// docs/conventions/ui.md#shape-in-the-operation-inspector
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import type { PartDTO } from '../../../../core/design/part.dto'
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
import { Ok } from '../../../../shared/result'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge, designDispatcher, type FakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ 'data-testid': id }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={id} />
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

const src = { kind: 'ui', id: 'test' } as const
const WAVE = {
  kind: 'path',
  closed: false,
  start: ['0', '0'],
  segments: [{ kind: 'line', to: ['30', '0'] }],
}

async function renderLine() {
  const bridge: FakeBridge = createFakeBridge(undefined, 'project')
  const d: Dispatcher = await designDispatcher('Bracket', 'mm', { region2d: port })
  const stock = await d.dispatch(
    'library.stock.add',
    {
      values: {
        name: 'Block',
        shape: 'block',
        length: '100',
        width: '60',
        thickness: '20',
        material: { name: 'Plywood', class: 'sheetGood' },
      },
    },
    src,
  )
  await d.dispatch(
    'design.part.add',
    { name: 'Bracket', stockLibraryItemId: (stock.unwrap().value as { id: string }).id },
    src,
  )
  const partId = Object.keys(d.doc.parts)[0]!
  await d.dispatch('design.shape.add', { partId, items: [WAVE] }, src)
  bridge.bind(d, 'p1', { file: '/p/bracket.dfyom' })
  const shell = createShell(bridge, { region2d: Promise.resolve(Ok(port)) })
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  const part = (): PartDTO => Object.values(d.doc.parts)[0]!
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  return { ...r, bridge, d, part, partId }
}

const navigator = () => screen.getByRole('navigation', { name: 'Navigator' })
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })

async function choose(
  user: { keyboard(t: string): Promise<void>; click(e: Element): Promise<void> },
  name: string,
  option: RegExp | string,
) {
  within(inspector()).getByRole('combobox', { name }).focus()
  await user.keyboard('{Enter}')
  const list = await screen.findByRole('listbox')
  await user.click(within(list).getByRole('option', { name: option }))
}

describe('Line inspector: Shape Editor access (DF147 SL1)', () => {
  it('"New shape…" in the Path picker adds an open path, picks it and opens it, one undo step', async () => {
    const { user, d, part, partId, bridge } = await renderLine()
    await d.dispatch(
      'design.line.add',
      { partId, paths: [{ shapeId: 'shape1', center: ['50', '30'] }] },
      src,
    )
    await user.click(await within(navigator()).findByRole('button', { name: /^Line 1/ }))
    await within(inspector()).findByRole('heading', { name: 'Line 1' })
    const before = d.history.undoable.length
    await choose(user, 'Path 1', 'New shape…')
    await waitFor(() =>
      expect(part().operations[0]).toMatchObject({
        paths: [{ shapeId: 'shape2', center: [{ source: '50' }, { source: '30' }] }],
      }),
    )
    expect(part().shapes?.[1]?.items[0]).toMatchObject({ kind: 'path', closed: false })
    await waitFor(() =>
      expect(bridge.shapeEditorOpens).toEqual([{ partId: part().id, shapeId: 'shape2' }]),
    )
    expect(d.history.undoable).toHaveLength(before + 1)
    // the Line stays selected with the new shape chosen
    expect(within(inspector()).getByRole('heading', { name: 'Line 1' })).toBeVisible()
    // "Edit shape…" and the button open the picked shape again
    await choose(user, 'Path 1', 'Edit shape…')
    await user.click(within(inspector()).getByRole('button', { name: 'Edit in Shape Editor' }))
    expect(bridge.shapeEditorOpens).toEqual([
      { partId: part().id, shapeId: 'shape2' },
      { partId: part().id, shapeId: 'shape2' },
      { partId: part().id, shapeId: 'shape2' },
    ])
    expect(part().operations[0]).toMatchObject({ paths: [{ shapeId: 'shape2' }] })
    await expectNoAxeViolations(inspector())
  })

  it('the pocket picker lists "Edit shape…" for a named shape', async () => {
    const { user, d, part, partId, bridge } = await renderLine()
    await d.dispatch(
      'design.shape.add',
      { partId, items: [{ kind: 'circle', center: ['0', '0'], diameter: '20' }] },
      src,
    )
    await d.dispatch(
      'design.pocket.add',
      {
        partId,
        shape: { kind: 'named', shapeId: 'shape2', center: ['50', '30'] },
        depth: '2',
      },
      src,
    )
    await user.click(await within(navigator()).findByRole('button', { name: /^Pocket 1/ }))
    await within(inspector()).findByRole('heading', { name: 'Pocket 1' })
    await choose(user, 'Shape', 'Edit shape…')
    expect(bridge.shapeEditorOpens).toEqual([{ partId: part().id, shapeId: 'shape2' }])
    expect(part().operations[0]).toMatchObject({ shape: { kind: 'named', shapeId: 'shape2' } })
  })
})
