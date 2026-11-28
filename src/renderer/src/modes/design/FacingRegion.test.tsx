// A facing's Region (design.md § Facing region, DF145 FR3) in the Design inspector against the
// fake bridge bound to a real dispatcher with the node 2D port: Whole face / Band / Shape, a band's
// edge and width, a shape region with the pocket's picker ("New shape…" picks and opens it, "Edit
// shape…"), back to the whole face. The 3D canvas is stubbed.
// Doc: docs/modes/design.md#facing-region-hardening-df145,
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

async function renderFacing() {
  const bridge: FakeBridge = createFakeBridge(undefined, 'project')
  const d: Dispatcher = await designDispatcher('Bracket', 'mm', { region2d: port })
  const stock = await d.dispatch(
    'library.stock.add',
    {
      values: {
        name: 'Plate',
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
  await d.dispatch('design.facing.add', { partId, depth: '0.5' }, src)
  bridge.bind(d, 'p1', { file: '/p/bracket.dfyom' })
  const shell = createShell(bridge, { region2d: Promise.resolve(Ok(port)) })
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  const part = (): PartDTO => Object.values(d.doc.parts)[0]!
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  await r.user.click(await within(navigator()).findByRole('button', { name: /^Facing 1/ }))
  await within(inspector()).findByRole('heading', { name: 'Facing 1' })
  return { ...r, bridge, d, part }
}

const navigator = () => screen.getByRole('navigation', { name: 'Navigator' })
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
const regionOf = (p: PartDTO) => (p.operations[0] as { region?: unknown }).region

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

describe('facing region (DF145 FR3)', () => {
  it('Band: from an edge, a width; back to the whole face', async () => {
    const { user, part } = await renderFacing()
    const radio = (name: string) => within(inspector()).getByRole('radio', { name })
    expect(radio('Whole face')).toBeChecked()
    expect(within(inspector()).queryByRole('combobox', { name: 'From edge' })).toBeNull()

    // a quarter of the face across the front edge to start from
    await user.click(radio('Band'))
    await waitFor(() =>
      expect(regionOf(part())).toMatchObject({
        band: { edge: 'front', width: { source: '15 mm' } },
      }),
    )
    const width = within(inspector()).getByLabelText('Width', {
      selector: 'input',
    }) as HTMLInputElement
    await user.clear(width)
    await user.type(width, '22{Enter}')
    await waitFor(() =>
      expect(regionOf(part())).toMatchObject({ band: { edge: 'front', width: { source: '22' } } }),
    )
    await choose(user, 'From edge', 'Back (Y max)')
    await waitFor(() =>
      expect(regionOf(part())).toMatchObject({ band: { edge: 'back', width: { source: '22' } } }),
    )
    await expectNoAxeViolations(inspector())

    // a width wider than the face is refused at the field
    await user.clear(width)
    await user.type(width, '61{Enter}')
    expect(await within(inspector()).findByText(/at most|wider|exceed/i)).toBeVisible()
    expect(regionOf(part())).toMatchObject({ band: { width: { source: '22' } } })

    await user.click(radio('Whole face'))
    await waitFor(() => expect(regionOf(part())).toBeUndefined())
  })

  it('Shape: the pocket picker; "New shape…" picks and opens it, one undo step', async () => {
    const { user, part, d, bridge } = await renderFacing()
    await user.click(within(inspector()).getByRole('radio', { name: 'Shape' }))
    await waitFor(() =>
      expect(regionOf(part())).toMatchObject({
        shape: { kind: 'rectangle', length: { source: '50 mm' }, width: { source: '30 mm' } },
      }),
    )
    // the pocket's Shape fields, sent as the region's shape
    const length = within(inspector()).getByLabelText('Length (X)', {
      selector: 'input',
    }) as HTMLInputElement
    await user.clear(length)
    await user.type(length, '40{Enter}')
    await waitFor(() =>
      expect(regionOf(part())).toMatchObject({ shape: { length: { source: '40' } } }),
    )
    await expectNoAxeViolations(inspector())

    const before = d.history.undoable.length
    await choose(user, 'Shape', 'New shape…')
    await waitFor(() =>
      expect(regionOf(part())).toMatchObject({ shape: { kind: 'named', shapeId: 'shape1' } }),
    )
    await waitFor(() =>
      expect(bridge.shapeEditorOpens).toEqual([{ partId: part().id, shapeId: 'shape1' }]),
    )
    expect(d.history.undoable).toHaveLength(before + 1)
    await choose(user, 'Shape', 'Edit shape…')
    expect(bridge.shapeEditorOpens).toHaveLength(2)
    expect(within(inspector()).getByRole('heading', { name: 'Facing 1' })).toBeVisible()
  })
})
