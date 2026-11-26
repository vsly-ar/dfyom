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
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'

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

async function renderHole(
  hole: Record<string, unknown> = {},
  thickness = '20',
  services: Parameters<typeof designDispatcher>[2] = {},
) {
  const bridge = createFakeBridge()
  const d = await designDispatcher(undefined, undefined, services)
  const stock = await d.dispatch(
    'library.stock.add',
    {
      values: {
        name: 'Block',
        shape: 'block',
        length: '100',
        width: '60',
        thickness,
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
  await r.user.click(await within(navigator).findByRole('button', { name: /^Bolt hole 1, / }))
  await within(insp()).findByRole('heading', { name: 'Bolt hole 1' })
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
// the vendored 2D module read from the repo root (jsdom has no file: import.meta.url), as ZRef.test
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: string): Uint8Array } }
  }
).process.getBuiltinModule('node:fs')
const nodeRegion2d = () =>
  loadRegion2dSync(fs.readFileSync('vendor/cavalier-contours/cavalier_contours.wasm')).expect(
    'the vendored 2D module loads',
  )
const src = (v: unknown) => (v as { source: string } | undefined)?.source
const section = () => within(insp()).getByRole('img', { name: /^Section:/ })

describe('hole inspector (U2)', () => {
  it('shows the groups and the section, refills from a fastener and says what it replaced', async () => {
    const { user, hole1, field, setField, choose } = await renderHole()
    // DF110 S4: Type holds the fastener; Defaults is a closed accordion after Tools
    for (const g of ['Position', 'Type', 'Sizes', 'Tools', 'Defaults'])
      expect(within(insp()).getByRole('region', { name: g })).toBeInTheDocument()
    expect(within(insp()).getByRole('button', { name: /^Defaults/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
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
        name: /^Bolt hole 1, M3 simple Ø 3\.6 \(custom\), 1 operation/,
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

  it('recessed countersink: Recess labels, the cone on the recess floor, the Recess tool (H1)', async () => {
    const { user, radio, hole1, setField } = await renderHole({ fastener: 'M5' })
    await user.click(radio('Type', 'Recessed countersink'))
    await waitFor(() => expect(hole1()['type']).toBe('recessedCountersink'))
    // S1–S6: the recess fields first, then the countersink's, in the Sizes group
    const sizes = within(insp()).getByRole('region', { name: 'Sizes' })
    const order = ['Recess Ø', 'Recess depth', 'Countersink Ø', 'Countersink angle'].map((l) =>
      within(sizes).getByLabelText(l, { selector: 'input' }),
    )
    const shown = within(sizes)
      .getAllByRole('combobox')
      .filter((el) => order.includes(el as HTMLInputElement))
      .map(
        (el) =>
          ['Recess Ø', 'Recess depth', 'Countersink Ø', 'Countersink angle'][
            order.indexOf(el as HTMLInputElement)
          ],
      )
    expect(shown).toEqual(['Recess Ø', 'Recess depth', 'Countersink Ø', 'Countersink angle'])
    expect(within(sizes).getByLabelText('Recess Ø', { selector: 'input' })).toHaveValue('12.6 mm')
    expect(within(sizes).getByLabelText('Recess depth', { selector: 'input' })).toHaveValue('2 mm')
    expect(within(sizes).queryByLabelText('Counterbore Ø', { selector: 'input' })).toBeNull()
    expect(within(insp()).queryByRole('radiogroup', { name: 'Countersink method' })).toBeNull()
    await waitFor(() =>
      expect(section()).toHaveAccessibleName(
        'Section: Ø 5.5 mm through; recess Ø 12.6 mm, 2 mm deep; countersink Ø 11.6 mm, 90°; M5 head 2.2 mm below the face.',
      ),
    )
    const tools = within(insp()).getByRole('region', { name: 'Tools' })
    await waitFor(() =>
      expect(within(tools).getByRole('combobox', { name: 'Recess' })).toBeInTheDocument(),
    )
    expect(within(tools).getByRole('combobox', { name: 'Countersink' })).toBeInTheDocument()
    // the recess may be as wide as the countersink (DF118: its floor is a construction surface)
    await setField('Recess Ø', '11.6')
    await waitFor(() => expect(src(hole1()['cbDiameter'])).toBe('11.6'))
    await expectNoAxeViolations()
  })

  it('slotted: the clamps hole from the inspector (M5, Recessed, Slotted 19.5), Overall, section (H3)', async () => {
    const { user, radio, hole1, setField } = await renderHole({ fastener: 'M5' }, '10', {
      region2d: nodeRegion2d(),
    })
    await user.click(radio('Type', 'Recessed countersink'))
    await waitFor(() => expect(hole1()['type']).toBe('recessedCountersink'))
    const type = within(insp()).getByRole('region', { name: 'Type' })
    const slotted = within(type).getByRole('switch', { name: 'Slotted' })
    expect(slotted).not.toBeChecked()
    expect(within(insp()).queryByLabelText('Slot length', { selector: 'input' })).toBeNull()
    await user.click(slotted)
    // switched on: twice the diameter, rotation 0°
    await waitFor(() => expect(src(hole1()['slotLength'])).toBe('11 mm'))
    expect(slotted).toBeChecked()
    await setField('Slot length', '19.5')
    await waitFor(() => expect(src(hole1()['slotLength'])).toBe('19.5'))
    // Sizes: Diameter, then Slot length, Rotation and the read-only Overall (field order rule 3)
    const sizes = within(insp()).getByRole('region', { name: 'Sizes' })
    const labels = ['Diameter', 'Slot length', 'Rotation', 'Overall', 'Bottom']
    const els = labels.map((l) => within(sizes).getByLabelText(l))
    const order = [...els].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
    expect(order.map((el) => labels[els.indexOf(el)])).toEqual(labels)
    await waitFor(() => expect(within(sizes).getByLabelText('Overall')).toHaveValue('25 mm'))
    expect(within(sizes).getByLabelText('Overall')).toHaveAttribute('readonly')
    await waitFor(() =>
      expect(
        within(insp()).getByRole('img', { name: /^Section along the slot:/ }),
      ).toHaveAccessibleName(
        'Section along the slot: Ø 5.5 mm through, slotted: 19.5 mm travel, 25 mm overall; recess Ø 12.6 mm, 2 mm deep; countersink Ø 11.6 mm, 90°; M5 head 2.2 mm below the face.',
      ),
    )
    // the drill role is the slot's pocket: its tool row says Slot
    const tools = within(insp()).getByRole('region', { name: 'Tools' })
    await waitFor(() =>
      expect(within(tools).getByRole('combobox', { name: 'Slot' })).toBeInTheDocument(),
    )
    await setField('Rotation', '90')
    await waitFor(() => expect(src(hole1()['rotation'])).toBe('90'))
    await expectNoAxeViolations()
    // off: the round hole again, the slot fields gone
    await user.click(within(type).getByRole('switch', { name: 'Slotted' }))
    await waitFor(() => expect(hole1()['slotLength']).toBeUndefined())
    expect(hole1()['rotation']).toBeUndefined()
    expect(within(insp()).queryByLabelText('Slot length', { selector: 'input' })).toBeNull()
  })

  it('slotted: a slot longer than the face is refused at Slot length (H3)', async () => {
    const { user, hole1, setField } = await renderHole({ fastener: 'M5', slotLength: '10' })
    expect(within(insp()).getByRole('switch', { name: 'Slotted' })).toBeChecked()
    await setField('Slot length', '120')
    await waitFor(() =>
      expect(
        within(insp()).getByLabelText('Slot length', { selector: 'input' }),
      ).toHaveAccessibleDescription(/longer than its face/),
    )
    expect(src(hole1()['slotLength'])).toBe('10')
    void user
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

    // the stepdown sits in the closed Defaults accordion (DF110 S4), its summary names it
    const defaults = within(insp()).getByRole('button', { name: /^Defaults/ })
    expect(defaults).toHaveTextContent('stepdown 1 mm')
    await user.click(defaults)
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

  it('a refused type change shows its reason at the type, not at a field not shown yet (X2)', async () => {
    // an M3 counterbore is 3.2 mm deep: it would reach the bottom of a 3 mm board
    const { user, hole1 } = await renderHole({ fastener: 'M3' }, '3')
    await user.click(within(insp()).getByRole('radio', { name: 'Counterbore' }))
    expect(await within(insp()).findByText('Must end above the stock bottom')).toBeInTheDocument()
    expect(hole1()['type']).toBe('simple')
    expect(within(insp()).getByRole('radio', { name: 'Simple' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })
})
