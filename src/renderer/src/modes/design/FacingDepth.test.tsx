// The facing depth down to the reference model (DF4) in the Design window: Add facing takes it as
// the new facing's depth, the Depth field offers it as its recommended value ("Use …"), and a
// reference at the stock top suggests nothing. Fake bridge bound to a real project runtime with an
// in-memory asset store and file-reading in-process workers; the viewport canvas is stubbed.
// Doc: docs/modes/reference-model.md#facing-depth-from-the-reference-df4
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createInProcessWorkers, memoryFiles } from '../../../../core/commands/jobs'
import type { PartDTO } from '../../../../core/design/part.dto'
import { binaryStl, boxSoup } from '../../../../core/design/stl.testing'
import { assetPathOf, type AssetRef } from '../../../../core/project/assets'
import type { UnitSystem } from '../../../../core/project/document'
import type { ProjectSession } from '../../../../core/project/storage'
import { Ok } from '../../../../shared/result'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge, designDispatcher } from '../../test/bridge'
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

const BOX = '/models/box.stl'

/** A session that copies the box STL into an in-memory work folder (asset store). */
function fakeProject() {
  const files = new Map<string, Uint8Array>()
  const session = {
    importAsset() {
      const sha256 = '1'.padStart(64, '0')
      const path = assetPathOf(sha256, 'stl')
      const bytes = binaryStl(boxSoup(20, 10, 5))
      files.set(`/work/${path}`, bytes)
      return Promise.resolve(Ok({ path, sha256, size: bytes.length } satisfies AssetRef))
    },
    assetFile: (path: string) => Ok(`/work/${path}`),
  } as unknown as ProjectSession
  return { session, workers: createInProcessWorkers({ files: memoryFiles(files) }) }
}

/** A 100 × 60 × 20 block with a 20 × 10 × 5 reference whose top is `top` (a z source). */
async function renderWithReference(top: string, units: UnitSystem = 'mm') {
  const bridge = createFakeBridge()
  const p = fakeProject()
  const d = await designDispatcher('Bracket', units, { project: p.session, workers: p.workers })
  const src = { kind: 'ui', id: 'test' } as const
  const stock = await d.dispatch(
    'library.stock.add',
    {
      values: {
        name: 'Block',
        shape: 'block',
        length: '100 mm',
        width: '60 mm',
        thickness: '20 mm',
        material: { name: 'Pine', class: 'softwood' },
      },
    },
    src,
  )
  const added = await d.dispatch(
    'design.part.add',
    { name: 'Bracket', stockLibraryItemId: (stock.unwrap().value as { id: string }).id },
    src,
  )
  const partId = (added.unwrap().value as { partId: string }).partId
  const imported = await d.dispatch('design.reference.import', { partId, path: BOX }, src)
  const referenceId = (imported.unwrap().value as { referenceId: string }).referenceId
  await d.dispatch(
    'design.reference.update',
    { partId, referenceId, position: { z: `${top} - 5 mm` } },
    src,
  )
  // the ghost's triangles: the same box, so the window measures from the mesh
  bridge.setReferenceMesh(() => ({
    ok: true,
    positions: Float32Array.from(boxSoup(20, 10, 5)),
    edges: new Float32Array(0),
  }))
  bridge.bind(d, 'p1', { file: '/p/bracket.dfyom' })
  const r = renderUi(
    <ShellProvider shell={createShell(bridge)}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const part = (): PartDTO => Object.values(d.doc.parts)[0]!
  const depthOf = (i = 0) =>
    (part().operations[i] as unknown as { depth: { source: string } }).depth.source
  return { ...r, d, part, depthOf }
}

const navigator = () => screen.getByRole('navigation', { name: 'Navigator' })
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })

describe('facing depth from the reference (DF4)', () => {
  it('adds a facing that faces down to the reference and recommends it on Depth', async () => {
    const { user, depthOf } = await renderWithReference('-0.48 mm')
    await user.click(await within(navigator()).findByRole('button', { name: 'Add facing' }))
    await within(inspector()).findByRole('heading', { name: 'Facing 1' })
    expect(depthOf()).toBe('0.48 mm')
    const depth = within(inspector()).getByLabelText('Depth', { selector: 'input' })
    expect(depth).toHaveValue('0.48 mm')

    // a different depth: the pencil offers the reference's depth again
    await user.clear(depth)
    await user.type(depth, '1{Enter}', { skipClick: true })
    await waitFor(() => expect(depthOf()).toBe('1'))
    await user.click(within(inspector()).getByRole('button', { name: 'Adjust Depth' }))
    const dialog = await screen.findByRole('dialog', { name: 'Adjust Depth' })
    expect(within(dialog).getByText(/0\.48 mm, down to box/)).toBeInTheDocument()
    await expectNoAxeViolations()
    await user.click(within(dialog).getByRole('button', { name: 'Use 0.48 mm' }))
    await waitFor(() => expect(depthOf()).toBe('0.48 mm'))
  })

  it('suggests nothing for a reference at the stock top: the default depth stays', async () => {
    const { user, depthOf } = await renderWithReference('0 mm')
    await user.click(await within(navigator()).findByRole('button', { name: 'Add facing' }))
    await within(inspector()).findByRole('heading', { name: 'Facing 1' })
    expect(depthOf()).toBe('0.5 mm')
    await user.click(within(inspector()).getByRole('button', { name: 'Adjust Depth' }))
    const dialog = await screen.findByRole('dialog', { name: 'Adjust Depth' })
    expect(within(dialog).queryByText(/down to/)).toBeNull()
  })

  it('rounds down in an inch project', async () => {
    const { user, depthOf } = await renderWithReference('-0.5 mm', 'inch')
    await user.click(await within(navigator()).findByRole('button', { name: 'Add facing' }))
    await within(inspector()).findByRole('heading', { name: 'Facing 1' })
    // 0.5 mm = 0.019685…″
    expect(depthOf()).toBe('0.0196"')
  })
})
