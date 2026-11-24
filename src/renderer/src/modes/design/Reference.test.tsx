// Reference model UI (task R3; the Reference panel since dogfood DF2–DF8) against the fake bridge
// bound to a real project runtime with an in-memory project session and file-reading in-process
// workers: the toolbar toggle and when the panel closes, import / replace / remove through the
// panel, the per-window eye and "See through stock" (no command, no undo step), the size read-out,
// unit, scale about the anchor, 90° turns, angles as one command per edit, Fit mode (preview,
// Apply, Cancel, closing cancels), errors, and the ghost's mesh read once per asset. The viewport
// canvas is stubbed; the preview and see-through state are read from the UI store.
// Doc: docs/conventions/ui.md#reference-panel-hardening-df2df8, docs/modes/reference-model.md#display
import { act, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createInProcessWorkers, memoryFiles } from '../../../../core/commands/jobs'
import type { ReferenceDTO } from '../../../../core/design/reference.dto'
import type { FittedLoop } from '../../../../core/design/reference-section'
import { Quantity } from '../../../../core/quantity/quantity'
import { binaryStl, boxSoup } from '../../../../core/design/stl.testing'
import { assetPathOf, type AssetRef } from '../../../../core/project/assets'
import type { ProjectSession } from '../../../../core/project/storage'
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
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
const BIG = '/models/big.stl'
const BIG_STL = binaryStl(boxSoup(40, 20, 10))

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

// jsdom's `import.meta.url` is not a file URL: read the vendored 2D module from the repository root
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: string): Uint8Array } }
  }
).process.getBuiltinModule('node:fs')
const region2d = loadRegion2dSync(
  fs.readFileSync('vendor/cavalier-contours/cavalier_contours.wasm'),
).expect('the vendored 2D module loads')

const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
/** The commands a bridge got (the Levels and Section rows read through queries meanwhile). */
const commandsOf = (bridge: { calls: readonly { name: string }[] }) =>
  bridge.calls.filter((c) => !/\.(find|list|get)$/.test(c.name))
const viewport = () => screen.getByRole('region', { name: '3D viewport' })
const field = (label: string) => within(inspector()).getByLabelText(label, { selector: 'input' })
const fitRegion = () => within(inspector()).getByRole('region', { name: 'Fit to stock' })
const toggle = () =>
  within(screen.getByRole('toolbar', { name: 'Part setup' })).getByRole('button', {
    name: 'Reference',
  })

/** Presses the toolbar's Reference toggle (in jsdom a click lands on the panel separator). */
async function pressToggle(): Promise<void> {
  await act(async () => {
    toggle().click()
    await Promise.resolve()
  })
}

/** Opens the Reference panel unless it is open (the narrow test window's overlay opens with it). */
async function openPanel(): Promise<void> {
  if (toggle().getAttribute('aria-pressed') !== 'true') await pressToggle()
  await waitFor(() =>
    expect(within(inspector()).getByRole('heading', { name: 'Reference' })).toBeVisible(),
  )
}

async function renderReference() {
  const bridge = createFakeBridge()
  const p = fakeProject({ [BOX]: BOX_STL, [BIG]: BIG_STL })
  const d = await designDispatcher('Bracket', 'mm', {
    project: p.session,
    workers: p.workers,
    region2d,
  })
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
  await screen.findByRole('toolbar', { name: 'Part setup' })
  const refs = () => Object.values(d.doc.references) as ReferenceDTO[]
  const ui = () => shell.ui.getState()
  /** Opens the panel (unless open) and imports BOX; the panel shows it. */
  const importBox = async () => {
    bridge.setFileChoice({ reference: BOX })
    await openPanel()
    await r.user.click(within(inspector()).getByRole('button', { name: 'Import STL…' }))
    await waitFor(() => expect(within(inspector()).getByTitle('box')).toBeVisible())
  }
  return { ...r, bridge, d, shell, refs, ui, importBox }
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

describe('reference model UI', () => {
  it('the toolbar toggle opens the panel in the sidebar; another selection closes it', async () => {
    const { user, ui } = await renderReference()
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    await openPanel()
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(within(inspector()).getByText(/Import an STL to show it on the stock/)).toBeVisible()
    await expectNoAxeViolations()
    // pressing it again closes it: the part shows
    await pressToggle()
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    expect(within(inspector()).getByRole('heading', { name: 'Part' })).toBeInTheDocument()
    // another selection needs the sidebar: the panel closes
    await openPanel()
    await user.click(
      await within(screen.getByRole('navigation', { name: 'Navigator' })).findByRole('button', {
        name: 'Add pocket',
      }),
    )
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'false'))
    expect(ui().referencePanel).toBe(false)
    expect(within(inspector()).getByRole('heading', { name: 'Pocket 1' })).toBeInTheDocument()
  })

  it('imports an STL through the file dialog: file line, size, fields, ghost mesh read once', async () => {
    const { user, bridge, refs, ui, importBox } = await renderReference()
    await openPanel()
    // a cancelled dialog imports nothing
    await user.click(within(inspector()).getByRole('button', { name: 'Import STL…' }))
    expect(bridge.calls.filter((c) => c.name === 'design.reference.import')).toHaveLength(0)

    await importBox()
    expect(bridge.calls.filter((c) => c.name === 'design.reference.import')).toEqual([
      { name: 'design.reference.import', args: { partId: expect.any(String), path: BOX } },
    ])
    // the file name (no name field, DF8) and the size in project units (DF6)
    expect(within(inspector()).getByTitle('box')).toHaveTextContent(/^box$/)
    expect(within(inspector()).queryByLabelText('Name')).not.toBeInTheDocument()
    expect(within(inspector()).getByText('STL · 12 triangles')).toBeInTheDocument()
    // placed size and file size agree at scale 1
    expect(within(inspector()).getAllByText('20 × 10 × 5 mm', { selector: 'dd' })).toHaveLength(2)
    expect(within(inspector()).getByText(/Unit guess: Read as mm/)).toBeInTheDocument()
    // the reference is the selection while the panel is open
    expect(ui().selection.design).toBe(refs()[0]!.id)
    // fitted centre + top: min corner (40, 25, −5)
    expect(field('Position X')).toHaveValue('40 mm')
    expect(field('Position Y')).toHaveValue('25 mm')
    expect(field('Position Z')).toHaveValue('-5 mm')
    await waitFor(() =>
      expect(viewport()).toHaveAccessibleDescription(/Reference box shown as a ghost\./),
    )
    expect(bridge.referenceMeshCalls).toEqual([refs()[0]!.id])
    await expectNoAxeViolations()
    // closing deselects it; reopening shows it again
    await pressToggle()
    expect(ui().selection.design).toBeNull()
    await openPanel()
    await waitFor(() => expect(ui().selection.design).toBe(refs()[0]!.id))
  })

  it('the eye and See through stock are window state only: no command, no undo step', async () => {
    const { user, bridge, d, ui, importBox } = await renderReference()
    await importBox()
    await waitFor(() => expect(viewport()).toHaveAccessibleDescription(/Reference box shown/))
    const calls = bridge.calls.length
    const revision = d.revision
    const eye = within(inspector()).getByRole('button', { name: 'Show reference' })
    expect(eye).toHaveAttribute('aria-pressed', 'true')
    await user.click(eye)
    expect(eye).toHaveAttribute('aria-pressed', 'false')
    expect(within(inspector()).getByText('hidden')).toBeInTheDocument()
    expect(viewport()).not.toHaveAccessibleDescription(/Reference box/)
    expect(within(inspector()).getByText('Hidden in this window.')).toBeInTheDocument()
    await user.click(eye)
    await waitFor(() => expect(viewport()).toHaveAccessibleDescription(/Reference box shown/))
    // see through stock: on by default, off by the checkbox
    const see = within(inspector()).getByRole('checkbox', { name: 'See through stock' })
    expect(see).toBeChecked()
    expect(ui().seeThroughStock).toBe(true)
    await user.click(see)
    expect(ui().seeThroughStock).toBe(false)
    await user.click(see)
    expect(ui().seeThroughStock).toBe(true)
    // nothing reached the project; the mesh was not read again
    expect(bridge.calls).toHaveLength(calls)
    expect(d.revision).toBe(revision)
    expect(bridge.referenceMeshCalls).toHaveLength(1)
  })

  it('turns by 90° (one undo step each), edits angles and unit; scale keeps the anchor', async () => {
    const { user, d, refs, importBox } = await renderReference()
    await importBox()
    const ref = () => refs()[0]!
    const undoable = d.history.undoable.length

    await user.click(within(inspector()).getByRole('button', { name: 'Turn +90° about Z' }))
    await waitFor(() => expect(ref().rotation.z.source).toBe('90°'))
    expect(field('Rotation Z')).toHaveValue('90°')
    expect(d.history.undoable).toHaveLength(undoable + 1)
    expect(await screen.findByRole('button', { name: /^Undo Rotate reference/ })).toBeVisible()
    await user.click(within(inspector()).getByRole('button', { name: 'Turn −90° about Z' }))
    await waitFor(() => expect(ref().rotation.z.source).toBe('0°'))
    await retype(user, field('Rotation Y'), '15{Enter}')
    await waitFor(() => expect(ref().rotation.y.source).toBe('15'))
    await retype(user, field('Rotation Y'), '0{Enter}')
    await waitFor(() => expect(ref().rotation.y.source).toBe('0'))
    await user.click(within(inspector()).getByRole('radio', { name: 'inch' }))
    await waitFor(() => expect(ref().sourceUnit).toBe('inch'))
    expect(await within(inspector()).findByText(/sticks out of the stock/)).toBeInTheDocument()
    await user.click(within(inspector()).getByRole('radio', { name: 'mm' }))
    await waitFor(() => expect(ref().sourceUnit).toBe('mm'))

    // the anchor sits with the scale, with its hint; scale 2 about the centre: 40 × 20 × 10 with
    // the centre (50, 30) and the top (0) kept → min corner (30, 20, −10), one undo step
    const anchors = within(inspector()).getByRole('radiogroup', { name: 'Anchor' })
    expect(within(inspector()).getByText(/stays in place when the scale changes/)).toBeVisible()
    const before = d.history.undoable.length
    await retype(user, field('Scale'), '2{Enter}')
    await waitFor(() => expect(ref().scale.source).toBe('2'))
    expect(field('Position X')).toHaveValue('30 mm')
    expect(field('Position Y')).toHaveValue('20 mm')
    expect(field('Position Z')).toHaveValue('-10 mm')
    expect(within(inspector()).getByText('40 × 20 × 10 mm', { selector: 'dd' })).toBeVisible()
    expect(d.history.undoable).toHaveLength(before + 1)
    // about the front-left corner: (30, 20) stays, the top stays
    await user.click(within(anchors).getByRole('radio', { name: 'Front left' }))
    await retype(user, field('Scale'), '1{Enter}')
    await waitFor(() => expect(ref().scale.source).toBe('1'))
    expect(field('Position X')).toHaveValue('30 mm')
    expect(field('Position Y')).toHaveValue('20 mm')
    expect(field('Position Z')).toHaveValue('-5 mm')
  })

  it('Fit mode: settings with a live preview, Apply as one command, Cancel sends none', async () => {
    const { user, bridge, d, refs, ui, importBox } = await renderReference()
    await importBox()
    const ref = () => refs()[0]!
    await user.click(within(inspector()).getByRole('button', { name: 'Fit to stock…' }))
    const region = fitRegion()
    // position and rotation cannot be edited while fitting
    expect(within(inspector()).queryByLabelText('Position X')).not.toBeInTheDocument()
    expect(within(inspector()).queryByLabelText('Rotation Z')).not.toBeInTheDocument()
    expect(within(region).getByRole('checkbox', { name: 'Scale to fit' })).toHaveFocus()
    // default: scale to fit X and Y, margin 0, centre, top: min(100/20, 60/10) = 5
    expect(within(region).getByRole('status')).toHaveTextContent('Scale 5 · 100 × 50 × 25 mm')
    expect(ui().referencePreview).toMatchObject({ referenceId: ref().id })
    expect(ui().referencePreview!.placement.scale).toBe(5)
    await expectNoAxeViolations()
    // thickness governs too: 20/5 = 4; with a margin of 5: min(90/20, 50/10, 4) = 4
    await user.click(within(region).getByRole('checkbox', { name: 'Thickness (Z)' }))
    await retype(user, within(region).getByLabelText('Margin', { selector: 'input' }), '5{Enter}')
    await waitFor(() =>
      expect(within(region).getByRole('status')).toHaveTextContent('Scale 4 · 80 × 40 × 20 mm'),
    )
    expect(ui().referencePreview!.placement.position).toEqual({ x: 10, y: 10, z: -20 })
    await user.click(within(region).getByRole('radio', { name: 'Bottom' }))
    expect(within(region).getByText(/Which face of the model lines up/)).toBeVisible()
    // Cancel: no command, preview dropped, focus back on Fit to stock…
    const calls = commandsOf(bridge).length
    await user.click(within(region).getByRole('button', { name: 'Cancel' }))
    expect(commandsOf(bridge)).toHaveLength(calls)
    expect(ui().referencePreview).toBeNull()
    expect(within(inspector()).getByRole('button', { name: 'Fit to stock…' })).toHaveFocus()
    expect(ref().scale.source).toBe('1')

    // Apply: one update with the fit, one undo step
    await user.click(within(inspector()).getByRole('button', { name: 'Fit to stock…' }))
    await user.click(within(fitRegion()).getByRole('checkbox', { name: 'Width (Y)' }))
    // X alone governs and cannot be unchecked: 100/20 = 5 → 100 × 50 × 25
    expect(within(fitRegion()).getByRole('checkbox', { name: 'Length (X)' })).toBeDisabled()
    const undoable = d.history.undoable.length
    await user.click(within(fitRegion()).getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(ref().scale.source).toBe('5'))
    expect(bridge.calls.filter((c) => c.name === 'design.reference.update').at(-1)!.args).toEqual({
      partId: expect.any(String),
      referenceId: ref().id,
      fit: { anchor: { u: 'centre', v: 'centre' }, z: 'top', scaleTo: ['x'] },
    })
    expect(d.history.undoable).toHaveLength(undoable + 1)
    expect(
      await screen.findByRole('button', { name: /^Undo Fit reference to stock/ }),
    ).toBeVisible()
    expect(within(inspector()).queryByRole('region', { name: 'Fit to stock' })).toBeNull()
    expect(field('Position Z')).toHaveValue('-25 mm')
    expect(ui().referencePreview).toBeNull()
    expect(bridge.referenceMeshCalls).toHaveLength(1)
  })

  it('closing the panel cancels the fit; Escape cancels it too', async () => {
    const { user, bridge, ui, importBox } = await renderReference()
    await importBox()
    const calls = commandsOf(bridge).length
    await user.click(within(inspector()).getByRole('button', { name: 'Fit to stock…' }))
    expect(ui().referencePreview).not.toBeNull()
    await user.keyboard('{Escape}')
    expect(within(inspector()).queryByRole('region', { name: 'Fit to stock' })).toBeNull()
    expect(ui().referencePreview).toBeNull()
    await user.click(within(inspector()).getByRole('button', { name: 'Fit to stock…' }))
    expect(ui().referencePreview).not.toBeNull()
    await pressToggle()
    expect(ui().referencePreview).toBeNull()
    await openPanel()
    expect(within(inspector()).queryByRole('region', { name: 'Fit to stock' })).toBeNull()
    expect(commandsOf(bridge)).toHaveLength(calls)
  })

  it('Levels and Section rows: floors from both sides, a level sets the depth, Create shape sends one import (DF60)', async () => {
    const { user, bridge, d, importBox } = await renderReference()
    // one flat end mill Ø 3.175 in the library: the rounding default is its radius
    const diameter = Quantity.parse('3.175 mm', { kind: 'length', defaultUnit: 'mm' })
      .unwrap()
      .toDTO()
    bridge.handle('library.tool.list', () => ({
      ok: true,
      value: {
        items: [
          { type: 'flatEndMill', diameter },
          { type: 'drill', diameter },
        ],
      },
      revision: 0,
    }))
    await importBox()
    const levels = within(inspector()).getByRole('region', { name: 'Levels' })
    // the box (20 × 10 × 5, fitted centre + top of the 20 thick stock): its top from the top, its
    // underside from the bottom, 15 up
    await waitFor(() =>
      expect(
        within(levels).getByRole('button', { name: /^Depth 0 mm, area 200 mm², visible 200 mm²/ }),
      ).toBeVisible(),
    )
    expect(within(levels).getByRole('heading', { name: 'From top' })).toBeVisible()
    expect(within(levels).getByRole('heading', { name: 'From bottom' })).toBeVisible()
    const underside = within(levels).getByRole('button', { name: /^Depth 15 mm/ })

    // the section at the middle of the box by default: one outline, no inside corners
    const section = within(inspector()).getByRole('region', { name: 'Section' })
    expect(within(section).getByLabelText('Section depth', { selector: 'input' })).toHaveValue(
      '2.5 mm',
    )
    await waitFor(() => expect(within(section).getByText('Outline 20 mm × 10 mm')).toBeVisible())
    expect(within(section).getByText('none')).toBeVisible()
    await expectNoAxeViolations()

    // choosing the underside level cuts just below it: the plane misses the box
    await user.click(underside)
    await waitFor(() =>
      expect(within(section).getByText('The plane misses the model at this depth.')).toBeVisible(),
    )
    await retype(
      user,
      within(section).getByLabelText('Section depth', { selector: 'input' }),
      '3{Enter}',
    )
    await waitFor(() => expect(within(section).getByText('Outline 20 mm × 10 mm')).toBeVisible())

    // rounding off by default; on, it offers the end mill's radius
    await user.click(
      within(section).getByRole('checkbox', { name: 'Round sharp inside corners to' }),
    )
    expect(
      within(section).getByLabelText('Round sharp inside corners to', { selector: 'input' }),
    ).toHaveValue('1.5875 mm')
    const undoable = d.history.undoable.length
    await user.click(within(section).getByRole('button', { name: 'Create shape' }))
    await waitFor(() => expect(within(section).getByText('Shape created.')).toBeVisible())
    expect(bridge.calls.filter((c) => c.name === 'design.shape.import').at(-1)!.args).toEqual({
      partId: expect.any(String),
      split: 'file',
      from: {
        referenceId: expect.any(String),
        face: 'stock.top',
        depth: '3 mm',
        loops: 'all',
        roundInside: '1.5875 mm',
      },
    })
    expect(d.history.undoable).toHaveLength(undoable + 1)
    expect(Object.values(d.doc.parts)[0]!.shapes!.map((s) => s.name)).toEqual(['Section 3 mm'])
  })

  it('the fitted loops and the hovered level go to the viewport; closing the panel clears them (DF60)', async () => {
    const { user, bridge, ui, importBox } = await renderReference()
    const square: FittedLoop = {
      role: 'outer',
      open: false,
      loop: {
        elements: [
          { kind: 'line', a: [0, 0], b: [20, 0] },
          { kind: 'line', a: [20, 0], b: [20, 10] },
          { kind: 'line', a: [20, 10], b: [0, 10] },
          { kind: 'line', a: [0, 10], b: [0, 0] },
        ],
      },
      area: 200,
      bounds: { min: [0, 0], max: [20, 10] },
      sharp: [],
      maxDeviation: 0,
    }
    bridge.setReferenceSection(() => ({ ok: true, segments: new Float32Array(), loops: [square] }))
    await importBox()
    // the window asks the worker for the fitted loops at the section plane (2.5 mm below the top)
    await waitFor(() =>
      expect(bridge.referenceSectionCalls.some((c) => c.fit === true && c.level === -2.5)).toBe(
        true,
      ),
    )
    await waitFor(() => expect(ui().referenceOverlay?.loops).toEqual([square]))
    expect(ui().referenceOverlay).toMatchObject({ direction: '+z', depth: 2.5, hover: null })
    // the Cavities filter leaves the outline out of the drawing too
    const section = within(inspector()).getByRole('region', { name: 'Section' })
    await user.click(within(section).getByRole('radio', { name: 'Cavities' }))
    await waitFor(() => expect(ui().referenceOverlay?.loops).toEqual([]))

    // pointing at a level row highlights that level; leaving it drops the highlight
    const levels = within(inspector()).getByRole('region', { name: 'Levels' })
    const top = await within(levels).findByRole('button', { name: /^Depth 0 mm/ })
    await user.hover(top)
    expect(ui().referenceOverlay?.hover).toEqual({ depth: 0, facing: 'face' })
    await user.unhover(top)
    expect(ui().referenceOverlay?.hover).toBeNull()

    await pressToggle()
    await waitFor(() => expect(ui().referenceOverlay).toBeNull())
  })

  it('Holes list: groups with their pattern, rings on the ghost, Add as Bolt hole / Drilling is one undo step (DF60 P3)', async () => {
    const { user, bridge, d, ui, importBox } = await renderReference()
    const countersunk = {
      count: 4,
      holes: [
        [10, 10],
        [90, 10],
        [10, 50],
        [90, 50],
      ],
      size: {
        diameter: 2.447,
        top: 0,
        depth: 20,
        bottom: 'through',
        mouth: { type: 'countersink', diameter: 4.861, angle: 82.85 },
      },
      pattern: { kind: 'grid', origin: [10, 10], pitch: [80, 40], count: [2, 2] },
      suggest: {
        command: 'design.hole.add',
        args: {
          on: 'stock.top',
          center: ['10 mm', '10 mm'],
          type: 'countersink',
          csDiameter: '4.861 mm',
          csAngle: '82°',
          fastener: 'M2',
          fit: 'normal',
          diameter: '2.447 mm',
          bottom: 'through',
        },
        clones: { rows: [{ kind: 'grid', cols: 2, rows: 2, du: '80 mm', dv: '40 mm' }] },
      },
    }
    const pins = {
      count: 2,
      holes: [
        [30, 30],
        [47, 21],
      ],
      size: { diameter: 1.2, top: 0, depth: 6, bottom: 'flat' },
      suggest: {
        command: 'design.drilling.add',
        args: {
          on: 'stock.top',
          center: ['30 mm', '30 mm'],
          diameter: '1.2 mm',
          depth: '6 mm',
          bottom: 'flat',
        },
      },
      note: 'noTool',
      smallestTool: 1.588,
    }
    const sunken = {
      count: 1,
      holes: [[70, 30]],
      size: {
        diameter: 3.4,
        top: 4,
        depth: 20,
        bottom: 'through',
        mouth: { type: 'counterbore', diameter: 6.5, depth: 7.2 },
      },
      suggest: {
        command: 'design.hole.add',
        args: { on: 'stock.top', center: ['70 mm', '30 mm'] },
        note: 'belowFace',
      },
    }
    bridge.handle('design.reference.find', async (args) => {
      if ((args as { kind: string }).kind === 'holes')
        return {
          ok: true,
          value: { kind: 'holes', groups: [countersunk, pins, sunken], holeCount: 7 },
          revision: 0,
        }
      const q = await d.queryAsync('design.reference.find', args, { kind: 'ui', id: 'test' })
      return { ok: true, ...q.expect('a section or levels read') }
    })
    await importBox()
    const holes = within(inspector()).getByRole('region', { name: 'Holes' })
    await waitFor(() =>
      expect(
        within(holes).getByText('4 × Ø 2.45 mm countersunk Ø 4.86 mm 83°, through, grid 2 × 2'),
      ).toBeVisible(),
    )
    expect(within(holes).getByText('2 × Ø 1.2 mm, 6 mm deep')).toBeVisible()
    expect(within(holes).getByText('No tool under Ø 1.59 mm')).toBeVisible()
    // a mouth below the face cannot be added from here: the button says why
    const below = within(holes).getByRole('button', { name: /^Add as Bolt hole: 1 × Ø 3.4 mm/ })
    expect(below).toBeDisabled()
    expect(within(holes).getByText(/The mouth is 4 mm below top/)).toBeVisible()
    // all seven holes are rings on the ghost
    await waitFor(() => expect(ui().referenceOverlay?.holes).toHaveLength(7))
    expect(ui().referenceOverlay?.holes?.[0]).toEqual({ center: [10, 10], diameter: 2.447, top: 0 })
    await expectNoAxeViolations()

    // the countersunk grid: one Bolt hole and its Clones, one undo step
    const part = () => Object.values(d.doc.parts)[0]!
    let undoable = d.history.undoable.length
    await user.click(within(holes).getByRole('button', { name: /^Add as Bolt hole: 4 ×/ }))
    await waitFor(() => expect(within(holes).getByText('4 Bolt holes added.')).toBeVisible())
    expect(d.history.undoable).toHaveLength(undoable + 1)
    const sent = commandsOf(bridge).slice(-2) as { name: string; args: unknown; gesture?: string }[]
    expect(sent.map((c) => c.name)).toEqual(['design.hole.add', 'design.clones.add'])
    expect(sent[0]!.gesture).toBeDefined()
    expect(sent[1]!.gesture).toBe(sent[0]!.gesture)
    expect(sent[1]!.args).toMatchObject({
      source: { featureId: expect.any(String) },
      rows: [{ kind: 'grid', cols: 2, rows: 2 }],
    })

    // the pin list: one Drilling per hole at its centre, one undo step
    undoable = d.history.undoable.length
    const ops = part().operations.length
    await user.click(within(holes).getByRole('button', { name: /^Add as Drilling: 2 ×/ }))
    await waitFor(() => expect(within(holes).getByText('2 drillings added.')).toBeVisible())
    expect(d.history.undoable).toHaveLength(undoable + 1)
    expect(part().operations.length).toBe(ops + 2)
    expect(
      (commandsOf(bridge).slice(-2) as unknown as { args: unknown }[]).map(
        (c) => (c.args as { center: string[] }).center,
      ),
    ).toEqual([
      ['30 mm', '30 mm'],
      ['47 mm', '21 mm'],
    ])
  })

  it('Read from offers the setups of the part plans; a setup sends face: { setupId } (DF60 P2)', async () => {
    const { user, bridge, d, importBox } = await renderReference()
    await importBox()
    const partId = Object.keys(d.doc.parts)[0]!
    await d.dispatch('plan.create', { partId }, { kind: 'ui', id: 'test' })
    const plan = Object.values(d.doc.plans)[0]!
    const setup = plan.setups[0]!
    within(inspector()).getByRole('combobox', { name: 'Read from' }).focus()
    await user.keyboard('{Enter}')
    const list = await screen.findByRole('listbox')
    const groups = within(list).getAllByRole('group')
    expect(groups.map((g) => g.firstElementChild?.textContent)).toEqual(['Stock', 'Setups'])
    await user.click(
      within(groups[1]!).getByRole('option', { name: `${setup.name} · ${plan.name}` }),
    )
    await waitFor(() =>
      expect(
        bridge.calls.some(
          (c) =>
            c.name === 'design.reference.find' &&
            JSON.stringify((c.args as { face: unknown }).face) ===
              JSON.stringify({ setupId: setup.id }),
        ),
      ).toBe(true),
    )
    await expectNoAxeViolations()
  })

  it('Compare: the switch runs the job after each evaluation, colours from the worker, regions frame the view; Hide stops it (DF60 P5)', async () => {
    const { user, bridge, d, ui, importBox } = await renderReference()
    await importBox()
    const partId = Object.keys(d.doc.parts)[0]!
    const ok = (value: unknown) => ({ ok: true as const, value, revision: 0 })
    const region = {
      kind: 'missing' as const,
      volume: 12.5,
      maxDev: 0.42,
      at: [10, 5, -2] as const,
      bounds: [
        [8, 4, -3],
        [12, 6, -1],
      ] as const,
      surfaces: ['stock.top'],
      operationIds: [] as string[],
    }
    const result = (evaluation: string, regions: (typeof region)[]) => ({
      method: 'boolean',
      threshold: 0.1,
      stats: {
        missingVolume: 12.5,
        extraVolume: 0,
        maxMissing: 0.42,
        maxExtra: 0,
        referenceVolume: 1000,
        partVolume: 990,
      },
      regions,
      below: { count: 2, volume: 0.1 },
      evaluation,
    })
    const runs: unknown[] = []
    let answer = result('h1', [region])
    bridge.handle('design.reference.compare', (args) => {
      runs.push(args)
      return ok({ jobId: `j${runs.length}` })
    })
    bridge.handle('job.wait', () => ok({ state: 'finished', outcome: { ok: true, value: answer } }))
    bridge.handle('job.abort', () => ok({}))
    bridge.setReferenceCompareView((r) => ({
      ok: true,
      distances: new Float32Array(r.positions.length / 3).fill(-0.42),
    }))
    const mesh = (z: number) => ({
      positions: new Float32Array([0, 0, z, 10, 0, z, 0, 10, z]),
      indices: new Uint32Array([0, 1, 2]),
      triangleSurface: new Uint32Array([0]),
      surfaces: ['stock.top'],
    })
    const first = mesh(0)
    act(() =>
      bridge.emitEvaluation({ key: 'p1', partId, status: 'done', inputHash: 'h1', mesh: first }),
    )

    const compare = within(inspector()).getByRole('region', { name: 'Compare' })
    // off: nothing runs
    await new Promise((r) => setTimeout(r, 400))
    expect(runs).toHaveLength(0)
    await user.click(within(compare).getByRole('switch', { name: 'Show on the part' }))
    await waitFor(() =>
      expect(
        within(compare).getByText('1 region over 0.1 mm · worst 0.42 mm missing'),
      ).toBeVisible(),
    )
    expect(runs).toEqual([
      {
        partId,
        referenceId: expect.any(String),
        source: { kind: 'part' },
        threshold: 0.1,
        limit: 20,
      },
    ])
    // the per-vertex distances of the mesh shown
    expect(bridge.referenceCompareViewCalls.at(-1)!.positions).toBe(first.positions)
    expect(ui().compareResult.view?.distances).toEqual(new Float32Array([-0.42, -0.42, -0.42]))
    expect(
      screen.getByRole('img', { name: /^Compare legend: Missing up to 0.42 mm/ }),
    ).toBeVisible()
    expect(
      screen.getByText(/Compare: 1 region over 0.1 mm, worst 0.42 mm missing\./),
    ).toBeInTheDocument()
    await expectNoAxeViolations()

    // a region frames the view (at least 10 mm) and is drawn chosen
    const row = within(compare).getByRole('button', { name: 'Missing 0.42 mm, 13 mm³' })
    await user.click(row)
    expect(row).toHaveAttribute('aria-pressed', 'true')
    expect(ui().viewportFocus?.box).toEqual({ min: [5, 0, -7], max: [15, 10, 3] })

    // an edit: the next evaluation runs again and its result replaces the last
    answer = result('h2', [])
    const second = mesh(-1)
    act(() =>
      bridge.emitEvaluation({ key: 'p1', partId, status: 'done', inputHash: 'h2', mesh: second }),
    )
    await waitFor(() =>
      expect(
        within(compare).getByText('The design matches the reference within 0.1 mm.'),
      ).toBeVisible(),
    )
    expect(runs).toHaveLength(2)
    expect(ui().compareResult.view?.positions).toBe(second.positions)
    expect(ui().compareRegion).toBeNull()

    // a result of an older evaluation is dropped (an edit landed meanwhile)
    answer = result('h3-stale', [region])
    act(() =>
      bridge.emitEvaluation({ key: 'p1', partId, status: 'done', inputHash: 'h4', mesh: mesh(-2) }),
    )
    await waitFor(() => expect(runs).toHaveLength(3))
    await new Promise((r) => setTimeout(r, 50))
    expect(ui().compareResult.view?.positions).toBe(second.positions)

    // Hide in the viewport legend turns it off: no more runs
    await user.click(screen.getByRole('button', { name: 'Hide' }))
    expect(ui().referenceCompare).toBeNull()
    expect(within(compare).getByRole('switch', { name: 'Show on the part' })).not.toBeChecked()
    act(() =>
      bridge.emitEvaluation({ key: 'p1', partId, status: 'done', inputHash: 'h5', mesh: mesh(-3) }),
    )
    await new Promise((r) => setTimeout(r, 400))
    expect(runs).toHaveLength(3)
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
    await openPanel()
    await user.click(within(inspector()).getByRole('button', { name: 'Import STL…' }))
    expect(
      await within(inspector()).findByText('The reference could not be imported.'),
    ).toBeInTheDocument()
    expect(refs()).toHaveLength(0)
  })

  it('replaces the STL: the new file is imported and selected, the old record removed', async () => {
    const { user, bridge, refs, ui, importBox } = await renderReference()
    await importBox()
    const old = refs()[0]!.id
    bridge.setFileChoice({ reference: BIG })
    await user.click(within(inspector()).getByRole('button', { name: 'Replace STL…' }))
    await waitFor(() => expect(refs().map((r) => r.name)).toEqual(['big']))
    expect(refs()[0]!.id).not.toBe(old)
    expect(ui().selection.design).toBe(refs()[0]!.id)
    expect(await within(inspector()).findByTitle('big')).toBeInTheDocument()
    expect(ui().referencePanel).toBe(true)
  })

  it('removes a reference with an undo toast; the panel shows its empty state', async () => {
    const { user, refs, importBox } = await renderReference()
    await importBox()
    await user.click(within(inspector()).getByRole('button', { name: 'Remove reference' }))
    await waitFor(() => expect(refs()).toHaveLength(0))
    expect(within(inspector()).getByText(/Import an STL to show it on the stock/)).toBeVisible()
    await user.click(await findToastAction('Undo'))
    await waitFor(() => expect(refs()).toHaveLength(1))
    expect(await within(inspector()).findByTitle('box')).toBeInTheDocument()
  })

  it('a failed mesh read says so in the panel and the viewport', async () => {
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
