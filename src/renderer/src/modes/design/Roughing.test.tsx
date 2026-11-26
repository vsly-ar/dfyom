// Roughing passes in the Design UI (hardening DF122, slice R2) against the fake bridge bound to a
// real design runtime: the Pocket inspector's Roughing accordion (closed "Off" while off; the
// switch is one `design.pocket.update { roughing }`; on, the roughing tool and the two margins,
// "Auto · 0.2 mm" for the default wall, a margin edit keeps the other one), the navigator's pocket
// row with its roughing row nested, the roughing pocket's short inspector (read-only margins,
// "Edit in Pocket 1"), `dfm.roughingNoGain` under the Roughing tool, and the Pattern inspector's
// same accordion; axe on each. The canvas is stubbed.
// Doc: docs/modes/roughing.md#ui, docs/modes/roughing.md#implementation-r2
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import type { PartDTO } from '../../../../core/design/part.dto'
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
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

const ui = { kind: 'ui', id: 'test' } as const
const partId = (d: Dispatcher) => Object.keys(d.doc.parts)[0]!
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: string): Uint8Array } }
  }
).process
const port = loadRegion2dSync(
  fs.getBuiltinModule('node:fs').readFileSync('vendor/cavalier-contours/cavalier_contours.wasm'),
).expect('the vendored 2D module loads')
const insp = () => screen.getByRole('complementary', { name: 'Inspector' })
const nav = () => screen.getByRole('navigation', { name: 'Navigator' })

const POCKET = {
  shape: {
    kind: 'rectangle',
    center: ['50', '30'],
    length: '60',
    width: '40',
    cornerRadius: '1.5',
  },
  depth: '6',
}

/** A 100 × 60 × 10 birch ply part; `prepare` runs on the dispatcher before the app binds. */
async function renderPart(prepare: (d: Dispatcher, partId: string) => Promise<void>) {
  const bridge = createFakeBridge()
  const d = await designDispatcher('Panel', 'mm', { region2d: port })
  const stock = await d.dispatch(
    'library.stock.add',
    {
      values: {
        name: 'Ply',
        shape: 'block',
        length: '100',
        width: '60',
        thickness: '10',
        material: { name: 'Birch ply', class: 'sheetGood' },
      },
    },
    ui,
  )
  await d.dispatch(
    'design.part.add',
    { name: 'Panel', stockLibraryItemId: (stock.unwrap().value as { id: string }).id },
    ui,
  )
  await prepare(d, partId(d))
  bridge.bind(d, 'p1', { file: '/p/panel.dfyom' })
  const r = renderUi(
    <ShellProvider shell={createShell(bridge, { region2d: Promise.resolve(Ok(port)) })}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const part = () => Object.values(d.doc.parts)[0] as PartDTO
  return { ...r, d, bridge, part }
}

const run = async (d: Dispatcher, name: string, args: object) => {
  const r = await d.dispatch(name, args, ui)
  if (r.isErr()) throw new Error(JSON.stringify(r.unwrapErr()))
}

const flat = (diameter: string) => ({ kind: 'generalized', type: 'flatEndMill', diameter })

describe('roughing in the Design UI (DF122 R2)', () => {
  it('Pocket inspector: the Roughing accordion turns roughing on and sets the margins', async () => {
    const { user, bridge, part } = await renderPart((d, id) =>
      run(d, 'design.pocket.add', { partId: id, ...POCKET }),
    )
    await user.click(await within(nav()).findByRole('button', { name: /^Pocket 1/ }))
    await within(insp()).findByRole('heading', { name: 'Pocket 1' })
    // closed while off, its summary "Off", right after Tool
    const header = within(insp()).getByRole('button', { name: /^Roughing/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(header).toHaveTextContent('Off')
    const titles = within(insp())
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent ?? '')
    const toolAt = titles.findIndex((x) => x.startsWith('Tool'))
    expect(titles[toolAt + 1]).toMatch(/^Roughing/)
    await expectNoAxeViolations()

    await user.click(header)
    await user.click(within(insp()).getByRole('switch', { name: 'Roughing' }))
    await waitFor(() =>
      expect(part().operations.map((o) => o.id)).toEqual(['pocket1_roughing', 'pocket1']),
    )
    expect(bridge.calls.find((c) => c.name === 'design.pocket.update')?.args).toMatchObject({
      operationId: 'pocket1',
      roughing: true,
    })
    // on: the roughing tool and the margins, the wall default the finishing allowance
    const wall = await within(insp()).findByLabelText('Leave on walls', { selector: 'input' })
    expect(wall).toHaveAttribute('placeholder', 'Auto · 0.2 mm')
    const floor = within(insp()).getByLabelText('Leave on floor', { selector: 'input' })
    expect(floor).toHaveAttribute('placeholder', '0')
    expect(within(insp()).getByRole('combobox', { name: 'Roughing tool' })).toBeInTheDocument()
    await expectNoAxeViolations()

    await user.type(floor, '1{Enter}')
    await waitFor(() =>
      expect(part().operations.find((o) => o.id === 'pocket1')).toMatchObject({
        roughingPass: { floor: { source: '1' } },
      }),
    )
    // a wall edit keeps the floor (an object replaces both margins)
    await user.type(
      within(insp()).getByLabelText('Leave on walls', { selector: 'input' }),
      '0.5{Enter}',
    )
    await waitFor(() =>
      expect(part().operations.find((o) => o.id === 'pocket1')).toMatchObject({
        roughingPass: { wall: { source: '0.5' }, floor: { source: '1' } },
      }),
    )
    // closed, the summary tells the margins
    await user.click(within(insp()).getByRole('button', { name: /^Roughing/ }))
    expect(within(insp()).getByRole('button', { name: /^Roughing/ })).toHaveTextContent(
      /walls 0\.5 · floor 1/,
    )
    await user.click(within(insp()).getByRole('button', { name: /^Roughing/ }))

    // off again: one update, the roughing pocket goes
    await user.click(within(insp()).getByRole('switch', { name: 'Roughing' }))
    await waitFor(() => expect(part().operations.map((o) => o.id)).toEqual(['pocket1']))
  })

  it('navigator: the roughing row nests under its pocket; its short inspector links back', async () => {
    const { user } = await renderPart(async (d, id) => {
      await run(d, 'design.pocket.add', { partId: id, ...POCKET, roughing: { wall: '0.4' } })
      await run(d, 'design.operation.tool.set', {
        partId: id,
        operationId: 'pocket1_roughing',
        tool: flat('8'),
      })
    })
    const row = await within(nav()).findByRole('button', { name: /^Pocket 1, with roughing/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    // one top-level row for the pair (it moves and removes as one)
    const list = within(nav()).getByRole('list', { name: 'Operations in design order' })
    expect(list.querySelectorAll(':scope > li')).toHaveLength(1)
    await user.click(within(row).getByTitle('Expand Pocket 1'))
    const rough = await within(nav()).findByRole('button', {
      name: /^Pocket 1 · roughing, edited through Pocket 1/,
    })
    expect(rough).toHaveTextContent('roughing')
    expect(rough).toHaveTextContent('Ø 8 mm')
    await expectNoAxeViolations()

    await user.click(rough)
    await within(insp()).findByRole('heading', { name: 'Pocket 1 · roughing' })
    expect(within(insp()).getByText(/Edited through/)).toBeInTheDocument()
    const wall = within(insp()).getByLabelText('Leave on walls', { selector: 'input' })
    expect(wall).toHaveValue('0.4')
    expect(wall).toHaveAttribute('readonly')
    expect(within(insp()).getByRole('combobox', { name: 'Roughing tool' })).toBeInTheDocument()
    await expectNoAxeViolations()
    await user.click(within(insp()).getByRole('button', { name: 'Edit in Pocket 1' }))
    await within(insp()).findByRole('heading', { name: 'Pocket 1' })
    // on, the accordion is open with the tool in its summary
    expect(within(insp()).getByRole('button', { name: /^Roughing/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('a roughing tool not larger than the pocket’s warns under the Roughing tool', async () => {
    const { user } = await renderPart(async (d, id) => {
      await run(d, 'design.pocket.add', { partId: id, ...POCKET, roughing: true })
      for (const operationId of ['pocket1', 'pocket1_roughing'])
        await run(d, 'design.operation.tool.set', { partId: id, operationId, tool: flat('3') })
    })
    await user.click(await within(nav()).findByRole('button', { name: /^Pocket 1, with roughing/ }))
    await within(insp()).findByRole('heading', { name: 'Pocket 1' })
    const group = within(insp()).getByRole('region', { name: 'Roughing' })
    expect(
      await within(group).findByText(
        /is not larger than the pocket’s|is not larger than the pocket's/,
      ),
    ).toBeInTheDocument()
    // the navigator's pocket row rolls the finding up
    expect(
      within(nav()).getByRole('button', { name: /^Pocket 1, with roughing/ }),
    ).toHaveTextContent('1')
    await expectNoAxeViolations()
  })

  it('Pattern inspector: the same accordion, the margins go to the pattern', async () => {
    const { user, part } = await renderPart((d, id) =>
      run(d, 'design.pattern.add', {
        partId: id,
        lattice: 'square',
        cell: { kind: 'circle', diameter: '12' },
      }),
    )
    await user.click(await within(nav()).findByRole('button', { name: /^Pattern 1, / }))
    await within(insp()).findByRole('heading', { name: 'Pattern 1' })
    const header = within(insp()).getByRole('button', { name: /^Roughing/ })
    expect(header).toHaveTextContent('Off')
    await user.click(header)
    await user.click(within(insp()).getByRole('switch', { name: 'Roughing' }))
    await waitFor(() => expect(part().features![0]!['roughing']).toBe(true))
    await user.type(
      await within(insp()).findByLabelText('Leave on walls', { selector: 'input' }),
      '0.3{Enter}',
    )
    await waitFor(() =>
      expect(part().features![0]!['roughing']).toMatchObject({ wall: { source: '0.3' } }),
    )
    expect(within(insp()).getByRole('combobox', { name: 'Roughing tool' })).toBeInTheDocument()
    await expectNoAxeViolations()
  })
})
