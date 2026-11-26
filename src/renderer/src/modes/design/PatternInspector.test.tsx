// The pattern inspector's layout (DF110 S4) against the fake bridge bound to a real design
// runtime: the rarely used fields behind their group's More row (cell Rotation; Origin and Flip;
// Boundary cells and Invert; Roughing), a More row shown open while a field in it holds a
// non-default value, the Chamfer accordion closed unless on, with its summary; axe. The canvas
// is stubbed.
// Doc: docs/conventions/inspector-layout.md#s4-implementation-notes
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
// the pattern's cells need the 2D module (the vendored wasm, as SplitParts.test.tsx reads it)
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: string): Uint8Array } }
  }
).process
const port = loadRegion2dSync(
  fs.getBuiltinModule('node:fs').readFileSync('vendor/cavalier-contours/cavalier_contours.wasm'),
).expect('the vendored 2D module loads')
const insp = () => screen.getByRole('complementary', { name: 'Inspector' })

async function renderPattern() {
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
  const added = await d.dispatch(
    'design.pattern.add',
    { partId: partId(d), lattice: 'square', cell: { kind: 'circle', diameter: '8' } },
    ui,
  )
  if (added.isErr()) throw new Error(JSON.stringify(added.unwrapErr()))
  bridge.bind(d, 'p1', { file: '/p/panel.dfyom' })
  const r = renderUi(
    <ShellProvider shell={createShell(bridge, { region2d: Promise.resolve(Ok(port)) })}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const navigator = screen.getByRole('navigation', { name: 'Navigator' })
  await r.user.click(await within(navigator).findByRole('button', { name: /^Pattern 1, / }))
  await within(insp()).findByRole('heading', { name: 'Pattern 1' })
  const pattern = () =>
    (Object.values(d.doc.parts)[0] as PartDTO).features![0]! as Record<string, unknown>
  return { ...r, d, pattern }
}

describe('pattern inspector layout (DF110 S4)', () => {
  it('keeps rare fields behind More rows, open while one is set; Chamfer closed unless on', async () => {
    const { user, pattern } = await renderPattern()
    const more = (name: string) => within(insp()).getByRole('button', { name })
    const switchOf = (name: string) => within(insp()).getByRole('switch', { name })
    // closed by default, still mounted
    for (const name of [
      'More (Rotation)',
      'More (Origin, Flip every other cell)',
      'More (Boundary cells, Invert)',
      'More (Roughing)',
    ])
      expect(more(name)).toHaveAttribute('aria-expanded', 'false')
    expect(within(insp()).getByLabelText('Origin U', { selector: 'input' })).not.toBeVisible()
    // Chamfer: a closed accordion, its summary "Off"
    const chamfer = within(insp()).getByRole('button', { name: /^Chamfer/ })
    expect(chamfer).toHaveAttribute('aria-expanded', 'false')
    expect(chamfer).toHaveTextContent('Off')
    await expectNoAxeViolations()

    // Flip on: its More row stays shown open (a More row has no summary to tell)
    await user.click(more('More (Origin, Flip every other cell)'))
    await user.click(switchOf('Flip every other cell'))
    await waitFor(() => expect(pattern()['alternate']).toBe('flip'))
    await user.click(more('More (Origin, Flip every other cell)'))
    expect(more('More (Origin, Flip every other cell)')).toHaveAttribute('aria-expanded', 'true')
    expect(switchOf('Flip every other cell')).toBeVisible()

    // the chamfer on: the accordion opens (remembered apart for on and off)
    await user.click(chamfer)
    await user.click(switchOf('Chamfer every cell'))
    await waitFor(() => expect(pattern()['chamfer']).toBeDefined())
    expect(within(insp()).getByLabelText('Chamfer width', { selector: 'input' })).toBeVisible()
    await user.click(within(insp()).getByRole('button', { name: /^Chamfer/ }))
    expect(within(insp()).getByRole('button', { name: /^Chamfer/ })).toHaveTextContent(/°/)
    await expectNoAxeViolations()
  })
})
