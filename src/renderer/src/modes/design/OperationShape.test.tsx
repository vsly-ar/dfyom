// The operation inspector for shapes (task U2) against the fake bridge bound to a real dispatcher
// with the node 2D port: the shape picker (inline kinds, named shapes with "Used by", one update
// per choice), rotation and mirror, side On set with an open path's pick, the tab positions (Add
// tab turns the count into positions, Space evenly clears them, typing ends a marker key run), and Import SVG from
// the Shapes dialog, the shape picker (uses the first shape, one undo step) and the Shape Editor
// window (DF49, DF94; file dialog, options, `design.shape.import`, report). The 3D canvas is stubbed.
// Doc: docs/conventions/ui.md#shape-in-the-operation-inspector, #tab-markers, #import-report,
// #import-svg-where-it-is-looked-for-df49
import { act, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import { createInProcessWorkers, memoryFiles } from '../../../../core/commands/jobs'
import type { PartDTO } from '../../../../core/design/part.dto'
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
import { Ok } from '../../../../shared/result'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge, designDispatcher, type FakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { registerTabKeyRun } from './tab-key-run'
import type { TabOverlay } from '../../viewport'

/** The tab overlay the viewport last handed the (stubbed) scene, to drive the markers' keys. */
const scene = vi.hoisted(() => ({ tabs: null as TabOverlay | null }))
/** The `tabs` prop of the first element under `node` that has one. */
function tabsIn(node: unknown): TabOverlay | null | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const t = tabsIn(n)
      if (t !== undefined) return t
    }
    return undefined
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return undefined
  const props = (node as { props: Record<string, unknown> }).props
  if ('tabs' in props) return props['tabs'] as TabOverlay | null
  return tabsIn(props['children'])
}
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, ...rest }: { children: ReactNode; 'data-testid'?: string }) => {
    const t = tabsIn(children)
    if (t !== undefined) scene.tabs = t
    return <div data-testid={rest['data-testid']} />
  },
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

const fs = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: 'node:fs'): { readFileSync(p: string): Uint8Array }
    }
  }
).process
const read = (p: string) => fs.getBuiltinModule('node:fs').readFileSync(p)
const port = loadRegion2dSync(read('vendor/cavalier-contours/cavalier_contours.wasm')).expect(
  'the vendored 2D module loads',
)
const SVG = '/drawings/enclosure-sections.svg'
const files = memoryFiles(
  new Map([[SVG, new Uint8Array(read('src/core/design/__fixtures__/enclosure-sections.svg'))]]),
)

const src = { kind: 'ui', id: 'test' } as const

/** A project window, or (`shapes`) a Shape Editor window on the same project (DF94). */
async function renderOps(kind: 'project' | 'shapes' = 'project') {
  const bridge: FakeBridge = createFakeBridge(undefined, kind)
  const d: Dispatcher = await designDispatcher('Bracket', 'mm', {
    region2d: port,
    workers: createInProcessWorkers({ files }),
  })
  const stock = await d.dispatch(
    'library.stock.add',
    {
      values: {
        name: 'Block',
        shape: 'block',
        length: '100',
        width: '60',
        thickness: '20',
        material: { name: '6061-T6', class: 'aluminum' },
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
  bridge.bind(d, 'p1', { file: '/p/bracket.dfyom' })
  const shell = createShell(bridge, { region2d: Promise.resolve(Ok(port)) })
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  const part = (): PartDTO => Object.values(d.doc.parts)[0]!
  if (kind === 'project') await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
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

describe('operation inspector for shapes', () => {
  it('picks a named shape for a pocket and back, one update each', async () => {
    const { user, d, part, partId, bridge } = await renderOps()
    await d.dispatch(
      'design.shape.add',
      {
        partId,
        items: [{ kind: 'polygon', center: ['0', '0'], sides: '6', diameter: '30' }],
      },
      src,
    )
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    await within(inspector()).findByRole('heading', { name: 'Pocket 1' })

    within(inspector()).getByRole('combobox', { name: 'Shape' }).focus()
    await user.keyboard('{Enter}')
    const list = await screen.findByRole('listbox')
    const groups = within(list).getAllByRole('group')
    expect(groups.map((g) => g.firstElementChild?.textContent)).toEqual(['Inline', 'Shapes'])
    expect(within(groups[1]!).getByRole('option', { name: /Shape 1/ })).toHaveTextContent(
      'Not used',
    )
    expect(within(groups[1]!).getByRole('option', { name: 'New shape…' })).toBeInTheDocument()
    const before = bridge.calls.length
    await user.click(within(groups[1]!).getByRole('option', { name: /Shape 1/ }))
    await waitFor(() =>
      expect(part().operations[0]).toMatchObject({ shape: { kind: 'named', shapeId: 'shape1' } }),
    )
    expect(
      bridge.calls.slice(before).filter((c) => c.name === 'design.pocket.update'),
    ).toHaveLength(1)
    // a named shape shows rotation and mirror, and "Edit shape"
    expect(
      within(inspector()).getByLabelText('Rotation', { selector: 'input' }),
    ).toBeInTheDocument()
    const mirror = within(inspector()).getByRole('switch', { name: 'Mirror (flip x)' })
    await user.click(mirror)
    await waitFor(() =>
      expect(part().operations[0]).toMatchObject({ shape: { kind: 'named', mirror: true } }),
    )
    expect(within(inspector()).getByRole('button', { name: 'Edit shape' })).toBeInTheDocument()
    // Scale (D2, U3): its own illustration and (i) tip; 1 is not stored, another factor is
    const scale = within(inspector()).getByLabelText('Scale', { selector: 'input' })
    expect(scale).toHaveValue('1')
    const label = within(inspector()).getByText('Scale', { selector: 'label' }).closest('label')!
    expect(label.querySelector('svg[data-icon="scale"]')).not.toBeNull()
    await user.clear(scale)
    await user.type(scale, '1.02{Enter}', { skipClick: true })
    await waitFor(() =>
      expect(part().operations[0]).toMatchObject({ shape: { kind: 'named', scale: 1.02 } }),
    )
    act(() => scale.blur())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await expectNoAxeViolations(inspector())

    // the used shape in the Shapes dialog: its row menu's Remove says why it is refused (DF70),
    // Delete does nothing
    const tools = screen.getByRole('toolbar', { name: 'Part setup' })
    act(() => within(tools).getByRole('button', { name: 'Shapes' }).click())
    const shapes = await screen.findByRole('dialog', { name: 'Shapes' })
    const row = within(shapes).getByRole('button', { name: /^Shape 1/ })
    expect(row).toHaveTextContent('Used by 1')
    expect(row).toHaveAccessibleDescription(
      'Right-click or Shift+F10 for actions. Used by Pocket 1.',
    )
    row.focus()
    await user.keyboard('{Delete}')
    expect(part().shapes).toHaveLength(1)
    await user.keyboard('{Shift>}{F10}{/Shift}')
    const menu = await screen.findByRole('menu', { name: 'Actions for Shape 1' })
    const remove = within(menu).getByRole('menuitem', { name: /^Remove/ })
    expect(remove).toHaveAttribute('aria-disabled', 'true')
    expect(remove).toHaveTextContent('Used by Pocket 1.')
    await expectNoAxeViolations(document.body)
    await user.click(remove)
    expect(part().shapes).toHaveLength(1)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // back to an inline rectangle sized from the shape's bounding box
    await choose(user, 'Shape', 'Rectangle')
    await waitFor(() =>
      expect(part().operations[0]).toMatchObject({ shape: { kind: 'rectangle' } }),
    )
    expect(within(inspector()).getByRole('button', { name: 'Convert to shape' })).toBeVisible()
  })

  it('"New shape…" adds a shape, places it and opens it as one undo step (U4)', async () => {
    const { user, d, part, bridge } = await renderOps()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    await within(inspector()).findByRole('heading', { name: 'Pocket 1' })
    const before = d.history.undoable.length
    await choose(user, 'Shape', 'New shape…')
    await waitFor(() =>
      expect(part().operations[0]).toMatchObject({ shape: { kind: 'named', shapeId: 'shape1' } }),
    )
    // opened in the Shape Editor window (DF94); "Edit shape" opens it again
    await waitFor(() =>
      expect(bridge.shapeEditorOpens).toEqual([{ partId: part().id, shapeId: 'shape1' }]),
    )
    await user.click(within(inspector()).getByRole('button', { name: 'Edit shape' }))
    expect(bridge.shapeEditorOpens).toHaveLength(2)
    expect(part().shapes).toHaveLength(1)
    expect(d.history.undoable).toHaveLength(before + 1)
    expect(d.history.undoable.at(-1)?.title).toBe('Add shape')
    await d.dispatch('history.undo', {}, src)
    expect(part().shapes).toBeUndefined()
    expect(part().operations[0]).toMatchObject({ shape: { kind: 'rectangle' } })
  })

  it('"Place as drawn" puts a named shape at its own coordinates, one undo step (X2-2)', async () => {
    const { user, d, part, partId } = await renderOps()
    // a 30 × 20 rectangle whose own min corner is (12.3456, 7.5): where it was drawn
    await d.dispatch(
      'design.shape.add',
      {
        partId,
        items: [{ kind: 'rectangle', center: ['27.3456', '17.5'], length: '30', width: '20' }],
      },
      src,
    )
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    await within(inspector()).findByRole('heading', { name: 'Pocket 1' })
    await choose(user, 'Shape', /Shape 1/)
    await waitFor(() =>
      expect(part().operations[0]).toMatchObject({ shape: { kind: 'named', shapeId: 'shape1' } }),
    )
    const place = within(inspector()).getByRole('button', { name: 'Place as drawn' })
    expect(place).toBeEnabled()
    const before = d.history.undoable.length
    await user.click(place)
    await waitFor(() =>
      expect(part().operations[0]).toMatchObject({
        shape: {
          anchor: { u: 'min', v: 'min' },
          center: [{ source: '12.346 mm' }, { source: '7.5 mm' }],
        },
      }),
    )
    expect(d.history.undoable).toHaveLength(before + 1)
    await waitFor(() => expect(place).toBeDisabled())
    expect(place).toHaveAttribute('title', 'Already where it was drawn.')
    // a mirrored shape has no own position
    await user.click(within(inspector()).getByRole('switch', { name: 'Mirror (flip x)' }))
    await waitFor(() =>
      expect(place).toHaveAttribute(
        'title',
        'Only an unrotated, unmirrored shape at scale 1 has its own position.',
      ),
    )
    expect(place).toBeDisabled()
    await d.dispatch('history.undo', {}, src)
    await d.dispatch('history.undo', {}, src)
    expect(part().operations[0]).not.toHaveProperty('shape.anchor.u', 'min')
  })

  it('cuts an open named path on the line only', async () => {
    const { user, d, part, partId, bridge } = await renderOps()
    await d.dispatch(
      'design.shape.add',
      {
        partId,
        items: [
          {
            kind: 'path',
            start: ['0', '0'],
            closed: false,
            segments: [
              { kind: 'line', to: ['30', '0'] },
              { kind: 'line', to: ['30', '20'] },
            ],
          },
        ],
      },
      src,
    )
    await user.click(await within(navigator()).findByRole('button', { name: 'Add profile' }))
    await within(inspector()).findByRole('heading', { name: 'Profile 1' })
    const before = bridge.calls.length
    await choose(user, 'Shape', /Shape 1/)
    // picked while the side is Outside: the side turns On in the same update (one undo step),
    // with a notice
    await waitFor(() =>
      expect(part().operations[0]).toMatchObject({
        side: 'on',
        shape: { kind: 'named', shapeId: 'shape1' },
      }),
    )
    const updates = bridge.calls.slice(before).filter((c) => c.name === 'design.profile.update')
    expect(updates).toHaveLength(1)
    expect(updates[0]!.args).toMatchObject({ side: 'on', shape: { kind: 'named' } })
    expect(
      await screen.findByText('Side set to On line: an open path is cut on the line.'),
    ).toBeVisible()
    expect(within(inspector()).getByRole('radio', { name: 'On line' })).toBeChecked()
    // a through cut says so with the Cut group's Through switch (DF116); off = a blind depth
    const through = within(inspector()).getByRole('switch', { name: 'Through' })
    expect(through).toBeChecked()
    expect(within(inspector()).queryByLabelText('Depth', { selector: 'input' })).toBeNull()
    await user.click(through)
    await waitFor(() =>
      expect(
        bridge.calls.filter((c) => c.name === 'design.profile.update').at(-1)!.args,
      ).toMatchObject({
        depth: expect.any(String),
      }),
    )
    expect(await within(inspector()).findByLabelText('Depth', { selector: 'input' })).toBeVisible()
  })

  it('turns count-spaced tabs into positions and back', async () => {
    const { user, part, bridge } = await renderOps()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add profile' }))
    await within(inspector()).findByRole('heading', { name: 'Profile 1' })
    // "Add tab" sits behind the Tabs group's More row (DF110 S3)
    await user.click(within(inspector()).getByRole('button', { name: 'More (Tab positions)' }))
    const add = await within(inspector()).findByRole('button', { name: 'Add tab' })
    await user.click(add)
    await waitFor(() => {
      const op = part().operations[0]!
      expect(op.kind === 'profile' && op.tabs.positions?.length).toBeGreaterThan(0)
    })
    expect(
      bridge.calls.filter((c) => c.name === 'design.profile.update').at(-1)!.args,
    ).toMatchObject({ tabs: { positions: expect.any(Array) } })
    expect(await within(inspector()).findByText('Positions entered by you.')).toBeVisible()
    expect(within(inspector()).getByLabelText('Tab 1', { selector: 'input' })).toBeVisible()
    await expectNoAxeViolations(inspector())
    await user.click(within(inspector()).getByRole('button', { name: 'Space evenly' }))
    await waitFor(() => {
      const op = part().operations[0]!
      expect(op.kind === 'profile' && op.tabs.positions).toBeUndefined()
    })
    expect(within(inspector()).getByLabelText('Tab count', { selector: 'input' })).toBeVisible()
  })

  it('announces a marker moved by keys politely (U2)', async () => {
    const { user } = await renderOps()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add profile' }))
    await within(inspector()).findByRole('heading', { name: 'Profile 1' })
    // "Add tab" sits behind the Tabs group's More row (DF110 S3)
    await user.click(within(inspector()).getByRole('button', { name: 'More (Tab positions)' }))
    await user.click(await within(inspector()).findByRole('button', { name: 'Add tab' }))
    await waitFor(() => expect(scene.tabs?.markers.length).toBeGreaterThan(0))
    const before = scene.tabs!.markers[0]!.label
    act(() => scene.tabs!.onNudge(0, 10))
    const region = await screen.findByText(/^Tab 1, .* from the start$/)
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region.textContent).not.toBe(before)
  })

  it('a typed tab position ends an open key run of the markers first (X2)', async () => {
    const { user, part, bridge } = await renderOps()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add profile' }))
    await within(inspector()).findByRole('heading', { name: 'Profile 1' })
    // "Add tab" sits behind the Tabs group's More row (DF110 S3)
    await user.click(within(inspector()).getByRole('button', { name: 'More (Tab positions)' }))
    await user.click(await within(inspector()).findByRole('button', { name: 'Add tab' }))
    await waitFor(() => {
      const op = part().operations[0]!
      expect(op.kind === 'profile' && op.tabs.positions?.length).toBeGreaterThan(1)
    })
    const op = part().operations[0]!
    if (op.kind !== 'profile') throw new Error('expected a profile')
    const run = op.tabs.positions!.map((q) => q.source)
    run[run.length - 1] = '55 mm'
    // a key run still applying moved the last tab: typing tab 1 waits for it and keeps its move
    let release: () => void = () => undefined
    const settled = new Promise<void>((r) => (release = r))
    const settle = vi.fn(async () => {
      await settled
      return run
    })
    const unregister = registerTabKeyRun(op.id, settle)
    const before = bridge.calls.length
    const field = within(inspector()).getByLabelText('Tab 1', { selector: 'input' })
    await user.clear(field)
    await user.type(field, '12{Enter}')
    await waitFor(() => expect(settle).toHaveBeenCalledTimes(1))
    expect(bridge.calls.slice(before).filter((c) => c.name === 'design.profile.update')).toEqual([])
    release()
    await waitFor(() => {
      const o = part().operations[0]!
      expect(o.kind === 'profile' && o.tabs.positions?.map((q) => q.source)).toEqual([
        '12',
        ...run.slice(1),
      ])
    })
    unregister()
  })

  it('imports an SVG from the Shapes dialog and shows its report', async () => {
    const { user, part, bridge } = await renderOps()
    bridge.setFileChoice({ svg: SVG })
    const tools = screen.getByRole('toolbar', { name: 'Part setup' })
    act(() => within(tools).getByRole('button', { name: 'Shapes' }).click())
    const shapes = await screen.findByRole('dialog', { name: 'Shapes' })
    // no shapes yet: the explanation, then "Add shape" and "Import SVG…" (DF49)
    expect(within(shapes).getByText(/import an SVG drawing/)).toBeVisible()
    // "Choose one to edit it." only once there is one (DF48)
    expect(shapes).toHaveAccessibleDescription('Outlines that pockets and profiles can cut.')
    await expectNoAxeViolations(shapes)
    await user.click(within(shapes).getByRole('button', { name: 'Import SVG…' }))
    const options = await screen.findByRole('dialog', { name: 'Import SVG' })
    // the options name the file (DF48), the full path as tooltip
    expect(within(options).getByText('enclosure-sections.svg')).toBeVisible()
    expect(within(options).getByTitle(SVG)).toBeInTheDocument()
    await expectNoAxeViolations(options)
    await user.click(within(options).getByRole('button', { name: 'Import' }))
    const report = await screen.findByRole('dialog', { name: /^Imported/ })
    expect(bridge.calls.filter((c) => c.name === 'design.shape.import')).toHaveLength(1)
    expect((part().shapes ?? []).length).toBeGreaterThan(0)
    // element counts in words (DF48: "2 path")
    expect(within(report).getByText('2 paths')).toBeVisible()
    // the options and report stack over the Shapes dialog; Close leaves it open
    expect(shapes).toBeInTheDocument()
    await user.click(within(report).getByRole('button', { name: 'Close' }))
    // rows: the kind's icon and a read-out "Path · 250 × 178"-like (DF48)
    expect(
      within(shapes).getByRole('button', { name: /^outline,\s?Path · 249\.5 × 177\.1$/ }),
    ).toBeVisible()
    expect(shapes).toHaveAccessibleDescription(
      'Outlines that pockets and profiles can cut. Choose one to edit it.',
    )
    // choosing a row closes the dialog and opens the Shape Editor window on it (DF94)
    await user.click(within(shapes).getByRole('button', { name: /^outline/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(bridge.shapeEditorOpens).toEqual([{ partId: part().id, shapeId: 'shape1' }])
    expect(screen.queryByRole('region', { name: 'Shape Editor' })).toBeNull()
  })

  it('"Import SVG…" in a profile\'s shape picker uses the first shape, one undo step (DF49)', async () => {
    const { user, d, part, bridge } = await renderOps()
    bridge.setFileChoice({ svg: SVG })
    await user.click(await within(navigator()).findByRole('button', { name: 'Add profile' }))
    await within(inspector()).findByRole('heading', { name: 'Profile 1' })
    const before = d.history.undoable.length
    await choose(user, 'Shape', 'Import SVG…')
    const options = await screen.findByRole('dialog', { name: 'Import SVG' })
    await user.click(within(options).getByRole('button', { name: 'Import' }))
    const report = await screen.findByRole('dialog', { name: 'Imported 2 shapes' })
    expect(within(report).getByText('Profile 1 now cuts outline.')).toBeVisible()
    await expectNoAxeViolations(report)
    expect(part().operations[0]).toMatchObject({ shape: { kind: 'named', shapeId: 'shape1' } })
    expect(part().shapes?.map((s) => s.name)).toEqual(['outline', 'cavity'])
    // the import and its use are one undo step, named by the import
    expect(d.history.undoable).toHaveLength(before + 1)
    expect(d.history.undoable.at(-1)?.title).toBe('Import SVG')
    await user.click(within(report).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(within(inspector()).getByRole('combobox', { name: 'Shape' })).toHaveTextContent(
      'outline',
    )
    await d.dispatch('history.undo', {}, src)
    expect(part().shapes ?? []).toHaveLength(0)
    expect(part().operations[0]).toMatchObject({ shape: { kind: 'rectangle' } })
  })

  it('"Import SVG…" in the Shape Editor imports new shapes and opens the first (DF49)', async () => {
    // the Shape Editor window (DF94) on Shape 1
    const { user, d, part, partId, bridge } = await renderOps('shapes')
    bridge.setFileChoice({ svg: SVG })
    await d.dispatch(
      'design.shape.add',
      { partId, items: [{ kind: 'circle', center: ['0', '0'], diameter: '20' }] },
      src,
    )
    act(() => bridge.emitShapeEditorTarget({ partId, shapeId: 'shape1' }))
    await within(inspector()).findByRole('heading', { name: 'Shape 1' })
    await user.click(within(inspector()).getByRole('button', { name: 'Import SVG…' }))
    const options = await screen.findByRole('dialog', { name: 'Import SVG' })
    await user.click(within(options).getByRole('button', { name: 'Import' }))
    const report = await screen.findByRole('dialog', { name: 'Imported 2 shapes' })
    // new shapes; the edited one is unchanged
    expect(part().shapes?.map((s) => s.name)).toEqual(['Shape 1', 'outline', 'cavity'])
    expect(part().shapes?.[0]?.items).toHaveLength(1)
    await user.click(within(report).getByRole('button', { name: 'Edit outline' }))
    expect(await within(inspector()).findByRole('heading', { name: 'outline' })).toBeVisible()
    // later access: the inspector of the window that imported reopens the report
    await user.click(within(inspector()).getByRole('button', { name: 'Import report' }))
    expect(await screen.findByRole('dialog', { name: /^Imported/ })).toBeInTheDocument()
  })
})
