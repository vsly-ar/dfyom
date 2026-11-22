// The hole inspector (v0.4 U2) against the fake bridge bound to a real design runtime: groups and
// the section illustration, the fastener refill with its undo toast, the custom-size note with
// "Use …", the disabled tap drill with its reason, countersink, the Tools group (one tool field
// per owned operation), an invariant error at its field and in the drawing, the focused field's
// amber part and a click on a part focusing its field, axe. The canvas is stubbed.
// Doc: docs/conventions/ui.md#hole-inspector, #section-illustration
import { screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Dispatcher } from '../../../../core/commands/dispatcher'
import type { PartDTO } from '../../../../core/design/part.dto'
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
const partId = (d: Dispatcher) => Object.keys(d.doc.parts)[0]!

async function renderHole(hole: Record<string, unknown> = {}) {
  const bridge = createFakeBridge()
  const d = await designDispatcher()
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
    { name: 'Bracket', stockLibraryItemId: (stock.unwrap().value as { id: string }).id },
    ui,
  )
  ;(
    await d.dispatch('design.hole.add', { partId: partId(d), center: ['20', '20'], ...hole }, ui)
  ).unwrap()
  bridge.bind(d, 'p1', { file: '/p/bracket.dfyom' })
  const r = renderUi(
    <ShellProvider shell={createShell(bridge)}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const navigator = screen.getByRole('navigation', { name: 'Navigator' })
  await r.user.click(await within(navigator).findByRole('button', { name: /^Hole 1, / }))
  await within(insp()).findByRole('heading', { name: 'Hole 1' })
  const hole1 = () =>
    (Object.values(d.doc.parts)[0] as PartDTO).features![0]! as Record<
      string,
      { source: string } | string | undefined
    >
  const field = (label: string) => within(insp()).getByLabelText(label, { selector: 'input' })
  const setField = async (label: string, value: string) => {
    await r.user.clear(field(label))
    await r.user.type(field(label), `${value}{Enter}`)
  }
  const choose = async (label: string, option: string) => {
    await r.user.click(within(insp()).getByRole('combobox', { name: label }))
    const list = await screen.findByRole('listbox')
    await r.user.click(within(list).getByRole('option', { name: option }))
  }
  const radio = (group: string, name: string) =>
    within(within(insp()).getByRole('radiogroup', { name: group })).getByRole('radio', { name })
  return { ...r, d, hole1, field, setField, choose, radio }
}

const insp = () => screen.getByRole('complementary', { name: 'Inspector' })
const src = (v: unknown) => (v as { source: string } | undefined)?.source
const section = () => within(insp()).getByRole('img', { name: /^Section:/ })

describe('hole inspector (U2)', () => {
  it('shows the groups and the section, refills from a fastener and says what it replaced', async () => {
    const { user, hole1, field, setField, choose } = await renderHole()
    for (const g of ['Position', 'Type', 'Fastener', 'Sizes', 'Tools'])
      expect(within(insp()).getByRole('region', { name: g })).toBeInTheDocument()
    expect(within(insp()).getByRole('radio', { name: 'Simple' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(section()).toHaveAccessibleName('Section: Ø 6 mm through.')
    await expectNoAxeViolations()

    // the default 6 mm is not an entered size: no toast
    await choose('Size', 'M3')
    await waitFor(() => expect(src(hole1()['diameter'])).toBe('3.4 mm'))
    expect(hole1()['fastener']).toBe('M3')
    await waitFor(() =>
      expect(section()).toHaveAccessibleName('Section: Ø 3.4 mm through; M3 head on the face.'),
    )
    expect(within(insp()).getByText('ISO 273')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /^Notifications/ })?.textContent ?? '').not.toMatch(
      /Sizes set/,
    )

    // a hand-entered size keeps the fastener, carries the custom note and its fix
    await setField('Diameter', '3.6')
    await waitFor(() => expect(src(hole1()['diameter'])).toBe('3.6'))
    expect(hole1()['fastener']).toBe('M3')
    // the row's read-out marks the custom size
    expect(
      await within(screen.getByRole('navigation', { name: 'Navigator' })).findByRole('button', {
        name: /^Hole 1, M3 simple Ø 3\.6 \(custom\), 1 operation/,
      }),
    ).toBeInTheDocument()
    const use = await within(insp()).findByRole('button', { name: 'Use 3.4 mm' })
    expect(within(insp()).getByText('ISO for M3: 3.4 mm.')).toBeInTheDocument()
    await user.click(use)
    await waitFor(() => expect(src(hole1()['diameter'])).toBe('3.4 mm'))

    // a refill over an entered size: the toast says so, with Undo
    await setField('Diameter', '3.6')
    await waitFor(() => expect(src(hole1()['diameter'])).toBe('3.6'))
    await waitFor(() =>
      expect(within(insp()).getByRole('button', { name: 'Use 3.4 mm' })).toBeInTheDocument(),
    )
    await choose('Size', 'M4')
    await waitFor(() => expect(src(hole1()['diameter'])).toBe('4.5 mm'))
    const undo = await findToastAction('Undo')
    expect(screen.getByText('Sizes set from M4 (1 entered size replaced)')).toBeInTheDocument()
    await user.click(undo)
    await waitFor(() => expect(src(hole1()['diameter'])).toBe('3.6'))
    expect(field('Diameter')).toBeInTheDocument()
  })

  it('counterbore: tap drill disabled with its reason, a tool field per owned operation', async () => {
    const { user, radio, hole1 } = await renderHole({ fastener: 'M3' })
    await user.click(radio('Type', 'Counterbore'))
    await waitFor(() => expect(hole1()['type']).toBe('counterbore'))
    const tap = await waitFor(() => {
      const r = radio('Purpose', 'Tap drill')
      expect(r).toBeDisabled()
      return r
    })
    expect(tap).toBeDisabled()
    expect(
      within(insp()).getByText(
        'A tap drill hole is a simple hole: change the type to Simple first.',
      ),
    ).toBeInTheDocument()
    expect(within(insp()).getByLabelText('Counterbore Ø', { selector: 'input' })).toHaveValue(
      '6.5 mm',
    )
    await waitFor(() =>
      expect(section()).toHaveAccessibleName(
        'Section: Ø 3.4 mm through; counterbore Ø 6.5 mm, 3.2 mm deep; M3 head 0.2 mm below the face.',
      ),
    )
    const tools = within(insp()).getByRole('region', { name: 'Tools' })
    expect(within(tools).getByRole('combobox', { name: 'Counterbore' })).toBeInTheDocument()
    expect(within(tools).getByRole('combobox', { name: 'Drill' })).toBeInTheDocument()
    expect(within(tools).getByRole('button', { name: 'Lock counterbore tool' })).toBeInTheDocument()
    await expectNoAxeViolations()

    // countersink: its own sizes and the owned chamfer's tool
    await user.click(radio('Type', 'Countersink'))
    await waitFor(() => expect(hole1()['type']).toBe('countersink'))
    expect(
      await within(insp()).findByLabelText('Countersink angle', { selector: 'input' }),
    ).toHaveValue('90°')
    expect(within(tools).queryByRole('combobox', { name: 'Counterbore' })).toBeNull()
    await waitFor(() =>
      expect(
        within(within(insp()).getByRole('region', { name: 'Tools' })).getByRole('combobox', {
          name: 'Countersink',
        }),
      ).toBeInTheDocument(),
    )
  })

  it('stepped countersink: method, stepdown, the note, terraces in the section, shared tool (F7)', async () => {
    const { user, radio, hole1, field, setField } = await renderHole({
      fastener: 'M3',
      type: 'countersink',
    })
    expect(radio('Countersink method', 'Chamfer mill')).toHaveAttribute('aria-checked', 'true')
    expect(within(insp()).queryByLabelText('Stepdown', { selector: 'input' })).toBeNull()
    await user.click(radio('Countersink method', 'Stepped'))
    await waitFor(() => expect(hole1()['csMethod']).toBe('stepped'))
    expect(src(hole1()['csStepdown'])).toBe('1 mm')
    expect(await within(insp()).findByLabelText('Stepdown', { selector: 'input' })).toHaveValue(
      '1 mm',
    )
    await waitFor(() =>
      expect(section()).toHaveAccessibleName(
        'Section: Ø 3.4 mm through; countersink Ø 7.12 mm, 90°, stepped in 2 steps of 0.93 mm; M3 head 0.2 mm below the face.',
      ),
    )
    // the info note at the method control
    expect(await within(insp()).findByText(/^Stepped countersink: 2 steps of/)).toBeInTheDocument()
    // the countersink takes the drill's end mill (Apply has not chosen tools yet)
    const tools = within(insp()).getByRole('region', { name: 'Tools' })
    expect(
      within(tools).getByText("Takes the drill's end mill on Apply: one tool, no tool change."),
    ).toBeInTheDocument()
    await expectNoAxeViolations()

    await setField('Stepdown', '0.5')
    await waitFor(() => expect(src(hole1()['csStepdown'])).toBe('0.5'))
    await waitFor(() => expect(section()).toHaveAccessibleName(/stepped in 4 steps of 0\.465 mm/))
    // focusing the stepdown highlights the first terrace's height
    await user.click(field('Stepdown'))
    await waitFor(() =>
      expect(section().querySelector('[data-part="csStepdown"]')).toHaveAttribute(
        'data-state',
        'active',
      ),
    )

    // back to a chamfer mill: the stepdown goes with the method
    await user.click(radio('Countersink method', 'Chamfer mill'))
    await waitFor(() => expect(hole1()['csMethod']).toBeUndefined())
    expect(hole1()['csStepdown']).toBeUndefined()
    await waitFor(() =>
      expect(within(insp()).queryByLabelText('Stepdown', { selector: 'input' })).toBeNull(),
    )
    expect(within(tools).queryByText(/tool change/)).toBeNull()
  })

  it('a tap drill hole becoming a counterbore turns into a clearance hole', async () => {
    const { user, radio, hole1 } = await renderHole({ fastener: 'M3', purpose: 'tapDrill' })
    expect(within(insp()).queryByRole('radiogroup', { name: 'Fit' })).toBeNull()
    await user.click(radio('Type', 'Counterbore'))
    await waitFor(() => expect(hole1()['type']).toBe('counterbore'))
    expect(hole1()['purpose']).toBe('clearance')
    expect(src(hole1()['diameter'])).toBe('3.4 mm')
  })

  it('shows an invariant error at its field and in the drawing; focus and clicks follow the parts', async () => {
    const { user, setField, field, hole1 } = await renderHole({
      fastener: 'M3',
      type: 'counterbore',
    })
    // the focused field's measured part is amber
    await user.click(field('Counterbore depth'))
    const cbDepth = () => section().querySelector('[data-part="cbDepth"]')!
    await waitFor(() => expect(cbDepth()).toHaveAttribute('data-state', 'active'))
    expect(section().querySelector('[data-part="diameter"]')).not.toHaveAttribute('data-state')

    await setField('Counterbore Ø', '2')
    expect(
      await within(insp()).findByText('Must be greater than the hole diameter'),
    ).toBeInTheDocument()
    expect(src(hole1()['cbDiameter'])).toBe('6.5 mm')
    await waitFor(() =>
      expect(section().querySelector('[data-part="cbDiameter"]')).toHaveAttribute(
        'data-state',
        'invalid',
      ),
    )

    // a click on a part focuses its field
    const hit = section().querySelector('[data-part="diameter"] path:last-child')!
    await user.click(hit)
    expect(field('Diameter')).toHaveFocus()
  })
})
