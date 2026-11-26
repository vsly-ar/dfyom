// DF118 V3 (user TG #369) on the user's clamp without the rim: the chamfer cuts the recess floor
// ("Pocket for M5 floor") away, and the slot and the chamfer still stand on it. Selecting the slot
// shows the On field's quiet note "Cut away by Chamfer 1" with its (i) tip, and the viewport draws
// the floor as a dashed construction outline; pick mode offers that floor (an outline and a glyph,
// no triangles) and a click on it sets another operation's On. Follow-ups: the edge chamfer (no On
// field) shows the note at its Edge field, and highlighting the floor in the On list raises its
// outline in the viewport.
// The scene is stubbed to record its props; the evaluation (mesh push) and the construction list
// of `design.warning.list` are the core's for this part (construction.test.ts), pushed by the test.
// Doc: docs/modes/construction-surfaces.md#ui, docs/conventions/ui.md#construction-surfaces-df118
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ConstructionSurface } from '../../../../core/geometry/model'
import type { PartDTO } from '../../../../core/design/part.dto'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { expectOk } from '../../../../shared/testing/result'
import { createFakeBridge, designDispatcher } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import type { SceneProps } from '../../viewport/Scene'

const scene: { props: SceneProps | undefined } = { props: undefined }

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']}>{children}</div>
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: (props: SceneProps) => {
    scene.props = props
    return null
  },
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))
vi.mock('../../viewport/ViewCube', () => ({ ViewCube: () => null }))

const UI = { kind: 'ui', id: 'test' } as const

/** The recess floor at its level, as `PartEvaluation.construction` gives it (V1 test). */
const FLOOR: ConstructionSurface = {
  surface: 'pocket1.floor',
  consumedBy: ['pocket2', 'chamfer1'],
  referencedBy: [
    { operationId: 'pocket2', param: 'on' },
    { operationId: 'chamfer1', param: 'on' },
  ],
  patch: {
    direction: '-z',
    z: -2.3,
    loops: [
      [
        [24.35, 6.5],
        [35.65, 6.5],
        [35.65, 37.5],
        [24.35, 37.5],
      ],
    ],
  },
}

async function renderClamp() {
  const bridge = createFakeBridge()
  const d = await designDispatcher()
  const run = async (name: string, args: object) =>
    expectOk(await d.dispatch(name, args, UI)).value as Record<string, unknown>
  const stock = await run('library.stock.add', {
    values: {
      name: 'Aluminium',
      shape: 'block',
      length: '80',
      width: '40.35',
      thickness: '10.11',
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  const { partId } = (await run('design.part.add', {
    name: 'Clamp',
    stockLibraryItemId: stock['id'],
  })) as { partId: string }
  await run('design.facing.add', { partId, name: 'Facing top', depth: '0.3 mm' })
  await run('design.facing.add', {
    partId,
    name: 'Facing bottom',
    on: 'stock.bottom',
    depth: '0.3',
  })
  const rect = (length: string, width: string, cornerRadius: string) => ({
    kind: 'rectangle',
    center: ['30 mm', '22 mm'],
    length,
    width,
    cornerRadius,
  })
  await run('design.pocket.add', {
    partId,
    name: 'Pocket for M5',
    on: 'facing2.floor',
    shape: rect('11.3 mm', '31.0 mm', '5.6 mm'),
    depth: '2 mm',
  })
  await run('design.pocket.add', {
    partId,
    name: 'M5 long hole',
    on: 'pocket1.floor',
    shape: rect('5.5 mm', '25 mm', '2.5 mm'),
    depth: '7.8 mm',
  })
  await run('design.chamfer.add', {
    partId,
    edgeOf: 'pocket2',
    on: 'pocket1.floor',
    width: '3.2',
    angle: '90',
  })
  // a spot drilling elsewhere on the bottom facing: its On is picked onto the recess floor
  await run('design.drilling.add', {
    partId,
    name: 'Spot',
    on: 'facing2.floor',
    center: ['60 mm', '20 mm'],
    diameter: '3 mm',
    bottom: 'flat',
    depth: '1 mm',
  })
  // the core's construction list for this part (V1), with the real parameter warnings
  bridge.handle('design.warning.list', (args) => {
    const r = expectOk(d.query('design.warning.list', args, UI))
    const value = r.value as Record<string, unknown>
    const { patch: _p, ...entry } = FLOOR
    return { ok: true, value: { ...value, construction: [entry] }, revision: r.revision }
  })
  bridge.bind(d, 'p1', { file: '/p/clamp.dfyom' })
  bridge.emitEvaluation({
    key: 'p1',
    partId,
    status: 'done',
    inputHash: 'h1',
    mesh: {
      // one triangle of the bottom facing's floor; the recess floor has none
      positions: new Float32Array([0, 0, -9.81, 10, 0, -9.81, 0, 10, -9.81]),
      indices: new Uint32Array([0, 1, 2]),
      triangleSurface: new Uint32Array([0]),
      surfaces: ['facing2.floor'],
      construction: [FLOOR],
    },
  })
  const shell = createShell(bridge)
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const part = (): PartDTO => Object.values(d.doc.parts)[0]!
  const select = async (name: string) => {
    await r.user.click(within(navigator()).getByRole('button', { name: new RegExp(`^${name}`) }))
    await within(inspector()).findByRole('heading', { name })
  }
  return { ...r, d, shell, part, select }
}

const navigator = () => screen.getByRole('navigation', { name: 'Navigator' })
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })

describe('construction surfaces in the UI (DF118 V3, TG #369)', () => {
  it('the slot: a quiet note at On and the dashed outline of the cut-away floor', async () => {
    const { select } = await renderClamp()
    await select('M5 long hole')
    expect(
      await within(inspector()).findByText('Cut away by Chamfer 1 · still measured from its level'),
    ).toBeVisible()
    // the (i) tip's sentence describes the field
    const on = within(inspector()).getByRole('combobox', { name: /^On/ })
    expect(on).toHaveAccessibleDescription(/A construction surface: later cuts remove it/)
    // the outline, from the evaluation's patch: the recess outline at its level, not pickable
    await waitFor(() => expect(scene.props?.construction).toHaveLength(1))
    const o = scene.props!.construction![0]!
    expect(o).toMatchObject({ surface: 'pocket1.floor', pickable: false, normal: [0, 0, -1] })
    expect(o.loops[0]).toHaveLength(4)
    for (const p of o.loops[0]!) expect(p[2]).toBeCloseTo(-10.11 + 2.3, 6)
    expect(o.at[0]).toBeCloseTo(30, 6)
    expect(screen.getByRole('region', { name: '3D viewport' })).toHaveAccessibleDescription(
      /Pocket for M5 floor, cut away by M5 long hole and Chamfer 1, shown as an outline\./,
    )
    await expectNoAxeViolations()
  })

  it('the On list marks the cut-away floor "(construction)"', async () => {
    const { user, select } = await renderClamp()
    await select('Spot')
    await user.click(within(inspector()).getByRole('combobox', { name: /^On/ }))
    expect(
      await screen.findByRole('option', { name: 'Pocket for M5 floor (construction)' }),
    ).toBeVisible()
    await user.keyboard('{Escape}')
  })

  it('an edge chamfer: the note at its Edge field names the cut-away face', async () => {
    const { select } = await renderClamp()
    await select('Chamfer 1')
    expect(
      await within(inspector()).findByText(
        'Pocket for M5 floor is cut away by M5 long hole · still measured from its level',
      ),
    ).toBeVisible()
    const edge = within(inspector()).getByRole('combobox', { name: /^Edge/ })
    expect(edge).toHaveAccessibleDescription(/A construction surface: later cuts remove it/)
    await expectNoAxeViolations()
  })

  it('highlighting the floor in the On list raises its outline; closing the list drops it', async () => {
    const { user, select } = await renderClamp()
    await select('Spot')
    expect(scene.props?.construction ?? null).toBeNull()
    await user.click(within(inspector()).getByRole('combobox', { name: /^On/ }))
    const option = await screen.findByRole('option', { name: 'Pocket for M5 floor (construction)' })
    await user.hover(option)
    await waitFor(() => expect(scene.props?.construction?.[0]?.surface).toBe('pocket1.floor'))
    // drawn as a read-out (not pickable), hot as under the pointer; the mesh's hover state too
    expect(scene.props!.construction![0]!.pickable).toBe(false)
    expect(scene.props!.hovered).toBe('pocket1.floor')
    expect(scene.props!.surfaceState.hovered).toBe('pocket1.floor')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(scene.props?.construction ?? null).toBeNull())
    expect(scene.props!.hovered).toBeNull()
    expect(scene.props!.surfaceState.hovered).toBeNull()
  })

  it('pick mode offers the cut-away floor as an outline with a glyph; a click sets On', async () => {
    const { user, shell, part, select } = await renderClamp()
    await select('Spot')
    expect(scene.props?.construction ?? null).toBeNull()
    await user.click(within(inspector()).getByRole('button', { name: /Pick the surface/ }))
    const pick = shell.ui.getState().pick!
    expect(pick.eligible.has('pocket1.floor')).toBe(true)
    await waitFor(() => expect(scene.props?.construction?.[0]?.pickable).toBe(true))
    expect(scene.props!.glyphs?.map((g) => g.surface)).toContain('pocket1.floor')
    // a click on the outline's fill, as the construction layer reports it
    const viewport = screen.getByRole('region', { name: '3D viewport' })
    fireEvent.pointerDown(viewport, { clientX: 10, clientY: 10 })
    act(() =>
      scene.props!.onClick({ surface: 'pocket1.floor', operation: 'pocket1' }, {
        nativeEvent: { clientX: 10, clientY: 10, altKey: false },
      } as never),
    )
    await waitFor(() =>
      expect(part().operations.find((o) => o.name === 'Spot')).toMatchObject({
        on: 'pocket1.floor',
      }),
    )
    expect(shell.ui.getState().pick).toBeNull()
  })
})
