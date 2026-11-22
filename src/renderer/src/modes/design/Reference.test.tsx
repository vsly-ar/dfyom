// Reference model UI (task R3) against the fake bridge bound to a real project runtime with an
// in-memory project session and file-reading in-process workers: import through the file dialog,
// the Reference dialog's row (D45) and its per-window eye (no command, no undo step), the inspector (unit, scale,
// 90° turns, angles, fit) as one command per edit, remove with undo, errors, and the ghost's mesh
// read once per asset. The viewport canvas is stubbed.
// Doc: docs/modes/reference-model.md#display, docs/conventions/ui.md#reference-ghost-v02
import { act, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createInProcessWorkers, memoryFiles } from '../../../../core/commands/jobs'
import type { ReferenceDTO } from '../../../../core/design/reference.dto'
import { binaryStl, boxSoup } from '../../../../core/design/stl.testing'
import { assetPathOf, type AssetRef } from '../../../../core/project/assets'
import type { ProjectSession } from '../../../../core/project/storage'
import { fail, Ok } from '../../../../shared/result'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge, designDispatcher } from '../../test/bridge'
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

const BOX = '/models/box.stl'
/** A 20 × 10 × 5 mm box: read as mm on a 100 × 60 × 20 stock. */
const BOX_STL = binaryStl(boxSoup(20, 10, 5))

/** A session that copies the "user's" files into an in-memory work folder (asset store). */
function fakeProject(sources: Record<string, Uint8Array>) {
  const files = new Map<string, Uint8Array>()
  let n = 0
  const session = {
    importAsset(source: string) {
      const bytes = sources[source]
      if (bytes === undefined)
        return Promise.resolve(
          fail('input.malformed', `cannot read ${source}`, {
            issues: [{ path: ['path'], rule: 'unreadableFile', message: 'no such file' }],
          }),
        )
      const sha256 = (++n).toString(16).padStart(64, '0')
      const path = assetPathOf(sha256, 'stl')
      files.set(`/work/${path}`, bytes)
      return Promise.resolve(Ok({ path, sha256, size: bytes.length } satisfies AssetRef))
    },
    assetFile: (path: string) => Ok(`/work/${path}`),
  } as unknown as ProjectSession
  return { session, workers: createInProcessWorkers({ files: memoryFiles(files) }) }
}

async function renderReference() {
  const bridge = createFakeBridge()
  const p = fakeProject({ [BOX]: BOX_STL })
  const d = await designDispatcher('Bracket', 'mm', { project: p.session, workers: p.workers })
  const src = { kind: 'ui', id: 'test' } as const
  const stock = await d.dispatch(
    'library.stock.add',
    {
      values: {
        name: 'Block',
        shape: 'block',
        length: '100',
        width: '60',
        thickness: '20',
        material: { name: 'Pine', class: 'softwood' },
      },
    },
    src,
  )
  await d.dispatch(
    'design.part.add',
    { name: 'Bracket', stockLibraryItemId: (stock.unwrap().value as { id: string }).id },
    src,
  )
  bridge.bind(d, 'p1', { file: '/p/bracket.dfyom' })
  const shell = createShell(bridge)
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  // test windows are narrow: the inspector is an overlay, opened by its toggle
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const refs = () => Object.values(d.doc.references) as ReferenceDTO[]
  // a finished import selects the reference and closes the dialog (D45)
  const importBox = async () => {
    bridge.setFileChoice({ reference: BOX })
    const dialog = await referenceGroup()
    await r.user.click(within(dialog).getByRole('button', { name: 'Import STL…' }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
  }
  return { ...r, bridge, d, shell, refs, importBox }
}

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

/** The Reference dialog (D45), opened from the toolbar's Part setup group unless it is open. */
async function referenceGroup(): Promise<HTMLElement> {
  const open = screen.queryByRole('dialog', { name: 'Reference' })
  if (open !== null) return open
  const tools = screen.getByRole('toolbar', { name: 'Part setup' })
  act(() => within(tools).getByRole('button', { name: 'Reference' }).click())
  return screen.findByRole('dialog', { name: 'Reference' })
}
/** Closes the open dialog by Done (the inspector is hidden from queries while a modal is open). */
async function closeDialog(user: { click(e: Element): Promise<void> }): Promise<void> {
  const dialog = screen.getByRole('dialog')
  await user.click(within(dialog).getByRole('button', { name: 'Done' }))
  await waitFor(() => expect(dialog).not.toBeInTheDocument())
}
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
const viewport = () => screen.getByRole('region', { name: '3D viewport' })
const field = (label: string) => within(inspector()).getByLabelText(label, { selector: 'input' })

describe('reference model UI', () => {
  it('imports an STL through the file dialog: row, inspector, ghost mesh read once', async () => {
    const { user, bridge, refs, importBox } = await renderReference()
    expect(
      within(await referenceGroup()).getByText(/Import an STL to show it on the stock/),
    ).toBeInTheDocument()
    // a cancelled dialog imports nothing
    await user.click(within(await referenceGroup()).getByRole('button', { name: 'Import STL…' }))
    expect(bridge.calls.filter((c) => c.name === 'design.reference.import')).toHaveLength(0)

    await importBox()
    expect(bridge.calls.filter((c) => c.name === 'design.reference.import')).toEqual([
      { name: 'design.reference.import', args: { partId: expect.any(String), path: BOX } },
    ])
    const row = within(await referenceGroup()).getByRole('button', { name: /^box/ })
    expect(row).toHaveAttribute('aria-pressed', 'true') // selected: the inspector follows
    expect(row).toHaveTextContent('12 triangles')
    // the name is its own line (ellipsis with a tooltip), the count under it
    expect(within(row).getByTitle('box')).toHaveTextContent(/^box$/)
    await expectNoAxeViolations()
    await closeDialog(user)
    expect(within(inspector()).getByRole('heading', { name: 'box' })).toBeInTheDocument()
    expect(within(inspector()).getByText('STL · 12 triangles · 20 × 10 × 5')).toBeInTheDocument()
    expect(within(inspector()).getByText(/Unit guess: Read as mm/)).toBeInTheDocument()
    // fitted centre + top: min corner (40, 25, −5)
    expect(field('Position X')).toHaveValue('40 mm')
    expect(field('Position Y')).toHaveValue('25 mm')
    expect(field('Position Z')).toHaveValue('-5 mm')
    expect(refs()).toHaveLength(1)
    // the ghost: its triangles asked for once, then drawn (the viewport says so)
    await waitFor(() =>
      expect(viewport()).toHaveAccessibleDescription(/Reference box shown as a ghost\./),
    )
    expect(bridge.referenceMeshCalls).toEqual([refs()[0]!.id])
    await expectNoAxeViolations()
  })

  it('the eye hides the ghost in this window only: no command, no undo step, mesh kept', async () => {
    const { user, bridge, d, importBox } = await renderReference()
    await importBox()
    await waitFor(() => expect(viewport()).toHaveAccessibleDescription(/Reference box shown/))
    const calls = bridge.calls.length
    const revision = d.revision
    const eye = within(await referenceGroup()).getByRole('button', { name: 'Show reference' })
    expect(eye).toHaveAttribute('aria-pressed', 'true')
    await user.click(eye)
    expect(eye).toHaveAttribute('aria-pressed', 'false')
    expect(within(await referenceGroup()).getByRole('button', { name: /^box/ })).toHaveTextContent(
      'hidden',
    )
    await closeDialog(user)
    expect(viewport()).not.toHaveAccessibleDescription(/Reference box/)
    expect(within(inspector()).getByText('Hidden in this window.')).toBeInTheDocument()
    await user.click(within(await referenceGroup()).getByRole('button', { name: 'Show reference' }))
    await closeDialog(user)
    await waitFor(() => expect(viewport()).toHaveAccessibleDescription(/Reference box shown/))
    // nothing reached the project; the mesh was not read again
    expect(bridge.calls).toHaveLength(calls)
    expect(d.revision).toBe(revision)
    expect(bridge.referenceMeshCalls).toHaveLength(1)
  })

  it('turns by 90° (one undo step each), edits angles, scale and unit, and fits to the stock', async () => {
    const { user, bridge, d, refs, importBox } = await renderReference()
    await importBox()
    const ref = () => refs()[0]!
    const undoable = d.history.undoable.length

    await user.click(within(inspector()).getByRole('button', { name: 'Turn +90° about Z' }))
    await waitFor(() => expect(ref().rotation.z.source).toBe('90°'))
    expect(field('Rotation Z')).toHaveValue('90°')
    expect(d.history.undoable).toHaveLength(undoable + 1)
    expect(await screen.findByRole('button', { name: /^Undo Rotate reference/ })).toBeVisible()
    await user.click(within(inspector()).getByRole('button', { name: 'Turn −90° about X' }))
    await waitFor(() => expect(ref().rotation.x.source).toBe('-90°'))

    await retype(user, field('Rotation Y'), '15{Enter}')
    await waitFor(() => expect(ref().rotation.y.source).toBe('15'))
    await retype(user, field('Scale'), '2{Enter}')
    await waitFor(() => expect(ref().scale.source).toBe('2'))
    await user.click(within(inspector()).getByRole('radio', { name: 'inch' }))
    await waitFor(() => expect(ref().sourceUnit).toBe('inch'))
    // 20 × 10 × 5 in at scale 2, turned: far outside the stock
    expect(await within(inspector()).findByText(/sticks out of the stock/)).toBeInTheDocument()

    // back to mm, no rotation, scale 1; fit front-left at the bottom
    await user.click(within(inspector()).getByRole('radio', { name: 'mm' }))
    await retype(user, field('Scale'), '1{Enter}')
    for (const axis of ['X', 'Y', 'Z']) await retype(user, field(`Rotation ${axis}`), '0{Enter}')
    await waitFor(() => expect(ref().rotation.y.source).toBe('0'))
    await user.click(
      within(within(inspector()).getByRole('radiogroup', { name: 'Anchor' })).getByRole('radio', {
        name: 'Front left',
      }),
    )
    await user.click(within(inspector()).getByRole('radio', { name: 'Bottom' }))
    await user.click(within(inspector()).getByRole('button', { name: 'Fit to stock' }))
    await waitFor(() => expect(field('Position X')).toHaveValue('0 mm'))
    expect(field('Position Y')).toHaveValue('0 mm')
    expect(field('Position Z')).toHaveValue('-20 mm')
    expect(bridge.calls.filter((c) => c.name === 'design.reference.update').at(-1)!.args).toEqual({
      partId: expect.any(String),
      referenceId: ref().id,
      fit: { anchor: { u: 'min', v: 'min' }, z: 'bottom' },
    })
    expect(within(inspector()).getByText('The reference fits inside the stock.')).toBeVisible()
    // placement edits never read the mesh again
    expect(bridge.referenceMeshCalls).toHaveLength(1)
  })

  it('shows a command error at its field and keeps the record', async () => {
    const { user, refs, importBox } = await renderReference()
    await importBox()
    await retype(user, field('Scale'), '0{Enter}')
    await waitFor(() => expect(field('Scale')).toHaveAttribute('aria-invalid', 'true'))
    expect(refs()[0]!.scale.source).toBe('1')
  })

  it('an unreadable file shows the import error and adds nothing', async () => {
    const { user, bridge, refs } = await renderReference()
    bridge.setFileChoice({ reference: '/models/missing.stl' })
    await user.click(within(await referenceGroup()).getByRole('button', { name: 'Import STL…' }))
    expect(
      await within(await referenceGroup()).findByText('The reference could not be imported.'),
    ).toBeInTheDocument()
    expect(refs()).toHaveLength(0)
  })

  it('removes a reference with an undo toast', async () => {
    const { user, refs, importBox } = await renderReference()
    await importBox()
    await user.click(within(await referenceGroup()).getByRole('button', { name: 'Remove box' }))
    await waitFor(() => expect(refs()).toHaveLength(0))
    // Remove keeps the dialog open; the undo toast is there once it closes
    await closeDialog(user)
    expect(within(inspector()).getByRole('heading', { name: 'Part' })).toBeInTheDocument()
    await user.click(await findToastAction('Undo'))
    await waitFor(() => expect(refs()).toHaveLength(1))
    expect(within(await referenceGroup()).getByRole('button', { name: /^box/ })).toBeInTheDocument()
  })

  it('a failed mesh read says so in the inspector and the viewport', async () => {
    const { bridge, importBox } = await renderReference()
    bridge.setReferenceMesh(() => ({
      ok: false,
      error: { code: 'persist.io', message: 'gone', issues: [], frames: [] },
    }))
    await importBox()
    expect(
      await within(inspector()).findByText('The mesh could not be read for the viewport.'),
    ).toBeInTheDocument()
    expect(viewport()).toHaveAccessibleDescription(/Reference box could not be shown\./)
  })
})
