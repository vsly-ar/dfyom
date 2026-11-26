// The Round switch of a rectangle's corner radius (DF120 R2) against the fake bridge bound to a
// real design runtime: the switch under Corner radius in the pocket, profile and pattern cell
// inspectors, the read-only derived radius while on, a too-large radius or a narrowing size edit
// applied as Round with the undo toast, Undo, switching off keeping the radius; axe. The Shape
// Editor's switch is tested in Shape.test.tsx. The canvas is stubbed.
// Doc: docs/modes/hole-slots-and-round-corners.md#implementation-r2
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

const ui = { kind: 'ui', id: 'test' } as const
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
const input = (label: string) => within(insp()).getByLabelText(label, { selector: 'input' })
const roundSwitch = () => within(insp()).getByRole('switch', { name: 'Round' })

async function render(seed?: (d: Dispatcher, partId: string) => Promise<unknown>) {
  const bridge = createFakeBridge()
  const d = await designDispatcher('Clamp', 'mm', { region2d: port })
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
    ui,
  )
  await d.dispatch(
    'design.part.add',
    { name: 'Clamp', stockLibraryItemId: (stock.unwrap().value as { id: string }).id },
    ui,
  )
  await seed?.(d, Object.keys(d.doc.parts)[0]!)
  bridge.bind(d, 'p1', { file: '/p/clamp.dfyom' })
  const r = renderUi(
    <ShellProvider shell={createShell(bridge, { region2d: Promise.resolve(Ok(port)) })}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const part = (): PartDTO => Object.values(d.doc.parts)[0]!
  return { ...r, d, part }
}

/** Types into a field without a pointer click (jsdom boxes are empty, Design.test.tsx). */
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

type RectShape = { round?: true; width: { source: string }; cornerRadius: { source: string } }
const shapeOf = (part: PartDTO) => (part.operations[0] as unknown as { shape: RectShape }).shape

describe('Round corners (DF120 R2)', () => {
  it('pocket: a narrowing width turns Round on with a toast; Undo, too-large radius, off and on', async () => {
    const { user, part } = await render()
    await user.click(await within(nav()).findByRole('button', { name: 'Add pocket' }))
    const corners = await within(insp()).findByRole('region', { name: /^Corners/ })
    // the switch sits under Corner radius in the Corners group, off
    expect(within(corners).getByRole('switch', { name: 'Round' })).not.toBeChecked()
    expect(input('Corner radius')).not.toHaveAttribute('readonly')
    const radius = shapeOf(part()).cornerRadius.source

    // the user's case: a 5.5 mm slot with the default 3 mm radius
    await retype(user, input('Width (Y)'), '5.5{Enter}')
    await waitFor(() => expect(shapeOf(part()).round).toBe(true))
    expect(
      await screen.findByText(
        `R ${radius} does not fit the new width (half is 2.75 mm): set to Round.`,
      ),
    ).toBeInTheDocument()
    await waitFor(() => expect(roundSwitch()).toBeChecked())
    expect(input('Corner radius')).toHaveAttribute('readonly')
    expect(input('Corner radius')).toHaveValue('2.75 mm')
    await expectNoAxeViolations()

    // Undo (the toast's, the same undo step as the edit) restores the width and the radius
    await user.click(await findToastAction('Undo'))
    await waitFor(() => expect(shapeOf(part()).round).toBeUndefined())
    expect(shapeOf(part()).cornerRadius.source).toBe(radius)
    await waitFor(() => expect(roundSwitch()).not.toBeChecked())

    // a radius above half the narrowest side applies as Round, with the core's message
    await retype(user, input('Width (Y)'), '5.5{Enter}')
    await waitFor(() => expect(shapeOf(part()).round).toBe(true))
    await user.click(roundSwitch())
    await waitFor(() => expect(shapeOf(part()).round).toBeUndefined())
    // switching off keeps the current radius
    expect(shapeOf(part()).cornerRadius.source).toBe('2.75 mm')
    await retype(user, input('Corner radius'), '3{Enter}')
    await waitFor(() => expect(shapeOf(part()).round).toBe(true))
    expect(
      await screen.findByText('3 mm is more than half the width (2.75 mm): set to Round.'),
    ).toBeInTheDocument()
    // the summary of the closed accordion says Round
    await user.click(within(insp()).getByRole('button', { name: /^Corners/ }))
    expect(within(insp()).getByRole('button', { name: /^Corners/ })).toHaveTextContent(
      'r 2.75 mm (Round)',
    )
    await user.click(within(insp()).getByRole('button', { name: /^Corners/ }))
    // a size edit follows while on
    await retype(user, input('Width (Y)'), '8{Enter}')
    await waitFor(() => expect(shapeOf(part()).cornerRadius.source).toBe('4 mm'))
  })

  it('profile: the switch under Corner radius in the Shape group', async () => {
    const { user, part } = await render()
    await user.click(await within(nav()).findByRole('button', { name: 'Add profile' }))
    await within(insp()).findByRole('heading', { name: /Profile/ })
    await user.click(roundSwitch())
    await waitFor(() => expect(shapeOf(part()).round).toBe(true))
    expect(input('Corner radius')).toHaveAttribute('readonly')
    await user.click(roundSwitch())
    await waitFor(() => expect(shapeOf(part()).round).toBeUndefined())
    expect(input('Corner radius')).not.toHaveAttribute('readonly')
    // other refusals stay "not applied" drafts at the field (DF117): a negative radius
    const before = shapeOf(part()).cornerRadius.source
    await retype(user, input('Corner radius'), '-1{Enter}')
    await waitFor(() => expect(input('Corner radius')).toHaveAttribute('aria-invalid', 'true'))
    expect(input('Corner radius')).toHaveValue('-1')
    expect(shapeOf(part()).cornerRadius.source).toBe(before)
    expect(shapeOf(part()).round).toBeUndefined()
  })

  it('pattern cell: Round on a rectangle cell, a too-large radius applies as Round', async () => {
    const { user, part } = await render((d, partId) =>
      d.dispatch(
        'design.pattern.add',
        {
          partId,
          lattice: 'square',
          cell: { kind: 'rectangle', length: '10', width: '6', cornerRadius: '1' },
        },
        ui,
      ),
    )
    const cell = () =>
      part().features![0]!['cell'] as { round?: true; cornerRadius: { source: string } }
    await user.click(await within(nav()).findByRole('button', { name: /^Pattern 1, / }))
    await within(insp()).findByRole('heading', { name: 'Pattern 1' })
    expect(roundSwitch()).not.toBeChecked()
    await retype(user, input('Corner radius'), '4{Enter}')
    await waitFor(() => expect(cell().round).toBe(true))
    expect(
      await screen.findByText('4 mm is more than half the width (3 mm): set to Round.'),
    ).toBeInTheDocument()
    await waitFor(() => expect(roundSwitch()).toBeChecked())
    expect(input('Corner radius')).toHaveAttribute('readonly')
    await expectNoAxeViolations()
    await user.click(roundSwitch())
    await waitFor(() => expect(cell().round).toBeUndefined())
    expect(cell().cornerRadius.source).toBe('3 mm')
  })
})
