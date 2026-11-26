// Dogfood TG #369 (DF115–DF117) on the user's clamp: a pocket from the bottom ("M5 long hole" on
// "Pocket for M5", itself on the bottom facing's floor), the top faced. DF115: a Depth pick takes
// the surface the cut goes down to (the far side = Through; a level = a formula from `on`), and
// replaces the field's value. DF116: the Through switch in the Depth group. DF117: a refused value
// stays in its field marked "Not applied", across selecting another operation, until Revert.
// The viewport canvas is stubbed; picks go through the UI store's pick request as the viewport's do.
// Doc: docs/conventions/ui.md#depth-pick-df115, #quantity-and-expression-input; docs/modes/design.md#pocket
import { act, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import type { PartDTO } from '../../../../core/design/part.dto'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { expectOk } from '../../../../shared/testing/result'
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

const UI = { kind: 'ui', id: 'test' } as const

/** The user's clamp (clamps_40.dfyom, cut down): stock 80 × 40.35 × 10.11, faced both sides. */
async function renderClamp(extra?: (d: Dispatcher, partId: string) => Promise<void>) {
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
    depth: '0.3 mm',
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
  await extra?.(d, partId)
  bridge.bind(d, 'p1', { file: '/p/clamp.dfyom' })
  const shell = createShell(bridge)
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const part = (): PartDTO => Object.values(d.doc.parts)[0]!
  const op = (name: string) => part().operations.find((o) => o.name === name)!
  const select = async (name: string) => {
    await r.user.click(within(navigator()).getByRole('button', { name: new RegExp(`^${name}`) }))
    await within(inspector()).findByRole('heading', { name })
  }
  return { ...r, d, shell, part, op, select }
}

const navigator = () => screen.getByRole('navigation', { name: 'Navigator' })
const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
const field = (label: string) =>
  within(inspector()).getByLabelText(label, { selector: 'input' }) as HTMLInputElement

describe('DF115 depth pick, DF116 Through, DF117 not applied (TG #369)', () => {
  it('picking the top faced surface for a bottom-side pocket cuts it through (DF115, DF116)', async () => {
    const { user, shell, op, select } = await renderClamp()
    await select('M5 long hole')
    const depth = field('Depth')
    depth.focus()
    await user.keyboard('{Alt>}p{/Alt}')
    const pick = shell.ui.getState().pick!
    // what to pick lights up: the far side of the part only (nothing lies between here and it)
    expect(pick.eligible).toEqual(new Set(['stock.top', 'facing1.floor']))
    expect(screen.getByText(/Pick a surface for Depth \(cut down to it\)/)).toBeVisible()
    act(() => {
      pick.onPick('facing1.floor')
      shell.ui.getState().setPick(null)
    })
    await waitFor(() => expect(op('M5 long hole')).toMatchObject({ through: true }))
    // the blind depth is kept for when Through goes off again; the field hides meanwhile
    expect(op('M5 long hole')).toMatchObject({ depth: { source: '7.8 mm' } })
    const through = within(inspector()).getByRole('switch', { name: 'Through' })
    await waitFor(() => expect(through).toBeChecked())
    expect(within(inspector()).queryByLabelText('Depth', { selector: 'input' })).toBeNull()
    expect(await screen.findByText('M5 long hole: cut through to Facing top floor.')).toBeVisible()
    await user.click(through)
    await waitFor(() => expect(op('M5 long hole')).not.toHaveProperty('through'))
    expect(field('Depth')).toHaveValue('7.8 mm')
    await expectNoAxeViolations()
  })

  it('a level becomes a depth formula from the own on, replacing the value (DF115)', async () => {
    const { user, shell, op, select } = await renderClamp(async (d, partId) => {
      // from the top: a shallow pocket, then one on the top facing that goes down to its floor
      for (const [name, depth] of [
        ['Shallow', '3 mm'],
        ['Deeper', '1 mm'],
      ] as const)
        expectOk(
          await d.dispatch(
            'design.pocket.add',
            {
              partId,
              name,
              on: 'facing1.floor',
              shape: { kind: 'rectangle', center: ['60 mm', '20 mm'], length: '10', width: '10' },
              depth,
            },
            UI,
          ),
        )
    })
    await select('Deeper')
    const depth = field('Depth')
    depth.focus()
    await user.keyboard('{Alt>}p{/Alt}')
    const pick = shell.ui.getState().pick!
    // levels below the top facing's floor and the far side (the bottom facing's floor, the
    // bottom); the bottom pocket's floor faces the other way and is a level too
    expect(pick.eligible).toEqual(
      new Set(['pocket3.floor', 'pocket1.floor', 'stock.bottom', 'facing2.floor']),
    )
    act(() => {
      pick.onPick('pocket3.floor')
      shell.ui.getState().setPick(null)
    })
    expect(depth).toHaveValue('facing1.floor.z - pocket3.floor.z')
    depth.focus()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(op('Deeper')).toMatchObject({
        depth: { source: 'facing1.floor.z - pocket3.floor.z', exact: { num: '3', den: '1' } },
      }),
    )
  })

  it("keeps a refused Length as not applied, across selecting another operation (DF117, the user's steps)", async () => {
    const { user, op, select } = await renderClamp()
    await select('Pocket for M5')
    // 1. corner radius 5.5: applied
    const radius = field('Corner radius')
    await user.clear(radius)
    await user.type(radius, '5.5{Enter}', { skipClick: true })
    await waitFor(() =>
      expect(op('Pocket for M5')).toMatchObject({ shape: { cornerRadius: { source: '5.5' } } }),
    )
    // 2. Length below 2 × the corner radius: refused, the error at the Corner radius
    const length = field('Length (u)')
    await user.clear(length)
    await user.type(length, '10{Enter}', { skipClick: true })
    await waitFor(() => expect(radius).toHaveAttribute('aria-invalid', 'true'))
    expect(op('Pocket for M5')).toMatchObject({ shape: { length: { source: '11.3 mm' } } })
    // 3. the Length shows 10 and says it is not the part's value (no copy of the error)
    expect(length).toHaveValue('10')
    expect(length).not.toHaveAttribute('aria-invalid')
    expect(length.closest('[data-pending]')).not.toBeNull()
    expect(within(inspector()).getByText('Not applied: the part still uses 11.3 mm')).toBeVisible()
    await expectNoAxeViolations()
    // 4. another operation and back: the same draft, marker and error, not the old value
    await select('M5 long hole')
    await select('Pocket for M5')
    const again = field('Length (u)')
    expect(again).toHaveValue('10')
    expect(again.closest('[data-pending]')).not.toBeNull()
    expect(field('Corner radius')).toHaveAttribute('aria-invalid', 'true')
    // Revert: back to the applied value, the marker and the error go
    await user.click(within(inspector()).getByRole('button', { name: 'Revert' }))
    expect(field('Length (u)')).toHaveValue('11.3 mm')
    expect(field('Length (u)').closest('[data-pending]')).toBeNull()
    expect(field('Corner radius')).not.toHaveAttribute('aria-invalid')
  })

  it('a refused value sent again once the cause is fixed is applied and the marker goes (DF117)', async () => {
    const { user, op, select } = await renderClamp()
    await select('Pocket for M5')
    const length = field('Length (u)')
    await user.clear(length)
    await user.type(length, '10{Enter}', { skipClick: true })
    await waitFor(() => expect(length.closest('[data-pending]')).not.toBeNull())
    const radius = field('Corner radius')
    await user.clear(radius)
    await user.type(radius, '4{Enter}', { skipClick: true })
    await waitFor(() =>
      expect(op('Pocket for M5')).toMatchObject({ shape: { cornerRadius: { source: '4' } } }),
    )
    // the Length is still not applied until it is sent again
    expect(length.closest('[data-pending]')).not.toBeNull()
    length.focus()
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(op('Pocket for M5')).toMatchObject({ shape: { length: { source: '10' } } }),
    )
    await waitFor(() => expect(length.closest('[data-pending]')).toBeNull())
  })
})
