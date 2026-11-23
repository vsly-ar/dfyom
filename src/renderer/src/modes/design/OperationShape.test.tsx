// The operation inspector for shapes (task U2) against the fake bridge bound to a real dispatcher
// with the node 2D port: the shape picker (inline kinds, named shapes with "Used by", one update
// per choice), rotation and mirror, side On set with an open path's pick, the tab positions (Add
// tab turns the count into positions, Space evenly clears them, typing ends a marker key run), and Import SVG from
// the Shapes dialog, the shape picker (uses the first shape, one undo step) and the Shape Editor
// (DF49; file dialog, options, `design.shape.import`, report). The 3D canvas is stubbed.
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

async function renderOps() {
  const bridge: FakeBridge = createFakeBridge()
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
    await expectNoAxeViolations(inspector())

    // back to an inline rectangle sized from the shape's bounding box
    await choose(user, 'Shape', 'Rectangle')
    await waitFor(() =>
      expect(part().operations[0]).toMatchObject({ shape: { kind: 'rectangle' } }),
    )
    expect(within(inspector()).getByRole('button', { name: 'Convert to shape' })).toBeVisible()
  })

  it('"New shape…" adds a shape, places it and opens it as one undo step (U4)', async () => {
    const { user, d, part } = await renderOps()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add pocket' }))
    await within(inspector()).findByRole('heading', { name: 'Pocket 1' })
    const before = d.history.undoable.length
    await choose(user, 'Shape', 'New shape…')
    await waitFor(() =>
      expect(part().operations[0]).toMatchObject({ shape: { kind: 'named', shapeId: 'shape1' } }),
    )
    expect(part().shapes).toHaveLength(1)
    expect(d.history.undoable).toHaveLength(before + 1)
    expect(d.history.undoable.at(-1)?.title).toBe('Add shape')
    await d.dispatch('history.undo', {}, src)
    expect(part().shapes).toBeUndefined()
    expect(part().operations[0]).toMatchObject({ shape: { kind: 'rectangle' } })
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
    // On shows the groove's blind depth, empty = through
    expect(within(inspector()).getByLabelText('Depth', { selector: 'input' })).toHaveAttribute(
      'placeholder',
      'Through',
    )
  })

  it('turns count-spaced tabs into positions and back', async () => {
    const { user, part, bridge } = await renderOps()
    await user.click(await within(navigator()).findByRole('button', { name: 'Add profile' }))
    await within(inspector()).findByRole('heading', { name: 'Profile 1' })
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
    await expectNoAxeViolations(shapes)
    await user.click(within(shapes).getByRole('button', { name: 'Import SVG…' }))
    const options = await screen.findByRole('dialog', { name: 'Import SVG' })
    await user.click(within(options).getByRole('button', { name: 'Import' }))
    const report = await screen.findByRole('dialog', { name: /^Imported/ })
    expect(bridge.calls.filter((c) => c.name === 'design.shape.import')).toHaveLength(1)
    expect((part().shapes ?? []).length).toBeGreaterThan(0)
    // the options and report stack over the Shapes dialog; Edit shape closes both
    expect(shapes).toBeInTheDocument()
    await user.click(within(report).getByRole('button', { name: 'Edit shape' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByRole('region', { name: 'Shape Editor' })).toBeInTheDocument()
    // later access: the shape inspector reopens the report
    await user.click(within(inspector()).getByRole('button', { name: 'Import report' }))
    expect(await screen.findByRole('dialog', { name: /^Imported/ })).toBeInTheDocument()
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
    const { user, d, part, partId, bridge } = await renderOps()
    bridge.setFileChoice({ svg: SVG })
    await d.dispatch(
      'design.shape.add',
      { partId, items: [{ kind: 'circle', center: ['0', '0'], diameter: '20' }] },
      src,
    )
    const tools = screen.getByRole('toolbar', { name: 'Part setup' })
    act(() => within(tools).getByRole('button', { name: 'Shapes' }).click())
    const shapes = await screen.findByRole('dialog', { name: 'Shapes' })
    await user.click(within(shapes).getByRole('button', { name: /^Shape 1/ }))
    await within(inspector()).findByRole('heading', { name: 'Shape 1' })
    await user.click(within(inspector()).getByRole('button', { name: 'Import SVG…' }))
    const options = await screen.findByRole('dialog', { name: 'Import SVG' })
    await user.click(within(options).getByRole('button', { name: 'Import' }))
    const report = await screen.findByRole('dialog', { name: 'Imported 2 shapes' })
    // new shapes; the edited one is unchanged
    expect(part().shapes?.map((s) => s.name)).toEqual(['Shape 1', 'outline', 'cavity'])
    expect(part().shapes?.[0]?.items).toHaveLength(1)
    await user.click(within(report).getByRole('button', { name: 'Edit shape' }))
    expect(await within(inspector()).findByRole('heading', { name: 'outline' })).toBeVisible()
  })
})
