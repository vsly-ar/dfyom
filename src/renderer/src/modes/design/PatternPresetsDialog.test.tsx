// The pattern's Presets dialog (hardening DF107): preview cards in one radio group, the current
// preset marked and focused, arrows and Home/End move, Enter or a click applies once and closes,
// Escape or the footer's Close (P10) closes without applying; the polar preview's ring guides (P10).
// Doc: docs/modes/patterns.md#presets-dialog-and-more-presets-df107
import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import { PATTERN_PRESETS } from '../../../../core/design/pattern/presets'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { PatternPresetsDialog, PRESET_COLUMNS, type CurrentHeatsink } from './PatternPresetsDialog'

const mm = (n: number, kind = 'length') => ({
  kind,
  source: `${n}`,
  defaultUnit: kind === 'angle' ? 'deg' : 'mm',
  exact: { num: `${n * 10}`, den: '10' },
})

/** The Honeycomb preset as stored (10 mm across flats, R 1, 30°, hex, gap 2). */
const honeycomb = {
  id: 'pattern1',
  kind: 'pattern',
  name: 'Pattern 1',
  cell: {
    kind: 'polygon',
    sides: mm(6, 'scalar'),
    diameter: mm(10),
    across: 'flats',
    cornerRadius: mm(1),
    rotation: mm(30, 'angle'),
  },
  lattice: 'hex',
  spacing: { gap: mm(2) },
} as unknown as FeatureDTO

describe('PatternPresetsDialog (DF107)', () => {
  it('shows every preset as a card with a preview, name, description and key numbers', async () => {
    const { user } = renderUi(<PatternPresetsDialog feature={honeycomb} onApply={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Presets…' }))
    const dialog = screen.getByRole('dialog', { name: 'Pattern presets' })
    const cards = screen.getAllByRole('radio')
    expect(cards).toHaveLength(PATTERN_PRESETS.length)
    for (const c of cards) expect(c.querySelector('svg path')?.getAttribute('d')).toMatch(/^M/)
    const hc = screen.getByRole('radio', { name: 'Honeycomb' })
    expect(hc).toHaveTextContent('hexagon 10 mm across flats · hex · gap 2 mm')
    expect(hc).toHaveAccessibleDescription(/Rounded hexagons/)
    await expectNoAxeViolations(dialog)
  })

  it('marks the current preset and focuses it; arrows, Home and End move the focus', async () => {
    const { user } = renderUi(<PatternPresetsDialog feature={honeycomb} onApply={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Presets…' }))
    const cards = screen.getAllByRole('radio')
    const hc = screen.getByRole('radio', { name: 'Honeycomb' })
    expect(hc).toHaveAttribute('aria-checked', 'true')
    expect(hc).toHaveTextContent('Current')
    expect(cards.filter((c) => c.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    expect(hc).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(cards[2]).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(cards[2 + PRESET_COLUMNS]).toHaveFocus()
    await user.keyboard('{ArrowUp}{ArrowLeft}')
    expect(cards[1]).toHaveFocus()
    await user.keyboard('{End}')
    expect(cards.at(-1)).toHaveFocus()
    await user.keyboard('{Home}')
    expect(cards[0]).toHaveFocus()
    // only the focused card is in the tab order (one radio group)
    expect(cards.filter((c) => c.tabIndex === 0)).toEqual([cards[0]])
  })

  it('Enter applies the focused preset once and closes; Escape closes without applying', async () => {
    const onApply = vi.fn()
    const { user } = renderUi(<PatternPresetsDialog feature={honeycomb} onApply={onApply} />)
    const trigger = screen.getByRole('button', { name: 'Presets…' })
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onApply).not.toHaveBeenCalled()
    await user.click(trigger)
    await user.keyboard('{ArrowRight}{Enter}')
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply.mock.calls[0]![0].id).toBe(PATTERN_PRESETS[2]!.id)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('P10: the footer Close button closes without applying, focus back on Presets…', async () => {
    const onApply = vi.fn()
    const { user } = renderUi(<PatternPresetsDialog feature={honeycomb} onApply={onApply} />)
    const trigger = screen.getByRole('button', { name: 'Presets…' })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Pattern presets' })
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onApply).not.toHaveBeenCalled()
    expect(trigger).toHaveFocus()
  })

  it('P10: the polar preview draws ring guides; the row lattices none', async () => {
    const { user } = renderUi(<PatternPresetsDialog feature={honeycomb} onApply={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Presets…' }))
    const grille = screen.getByRole('radio', { name: 'Speaker grille' })
    expect(grille.querySelectorAll('circle[data-ring]').length).toBeGreaterThanOrEqual(3)
    expect(grille.querySelector('mask path')?.getAttribute('d')).toMatch(/^M/)
    const hc = screen.getByRole('radio', { name: 'Honeycomb' })
    expect(hc.querySelectorAll('circle[data-ring]')).toHaveLength(0)
  })

  it('a click applies that preset', async () => {
    const onApply = vi.fn()
    const { user } = renderUi(<PatternPresetsDialog feature={honeycomb} onApply={onApply} />)
    await user.click(screen.getByRole('button', { name: 'Presets…' }))
    await user.click(screen.getByRole('radio', { name: 'Speaker grille' }))
    expect(onApply).toHaveBeenCalledWith(PATTERN_PRESETS.find((x) => x.id === 'speakerGrille'))
  })

  describe('Heatsink group (pattern-presets.md H1, H2)', () => {
    const tools = [
      { id: 'flat1', name: 'Flat 1', diameter: 1, fluteLength: 4 },
      { id: 'flat2', name: 'Flat 2 x 12', diameter: 2, fluteLength: 12 },
      { id: 'flat3', name: 'Flat 3', diameter: 3, fluteLength: 12 },
    ]
    /** Not a preset (gap 7): the dialog opens on the last group used. */
    const custom = { ...honeycomb, spacing: { gap: mm(7) } } as unknown as FeatureDTO
    const setup = (over: { current?: CurrentHeatsink; lastGroup?: 'heatsink' } = {}) => {
      const apply = vi.fn()
      const onGroup = vi.fn()
      const r = renderUi(
        <PatternPresetsDialog
          feature={over.lastGroup === undefined ? honeycomb : custom}
          onApply={() => {}}
          heatsink={{
            face: { across: 40, along: 40, thickness: 14 },
            units: 'mm',
            current: over.current,
            tools,
            lastGroup: over.lastGroup,
            onGroup,
            apply,
          }}
        />,
      )
      return { ...r, apply, onGroup }
    }

    it('opens the step from the card; read-out, slot note, tool ≤ slot; Escape goes back', async () => {
      const { user, onGroup } = setup()
      await user.click(screen.getByRole('button', { name: 'Presets…' }))
      // the current preset (Honeycomb) is decorative: the dialog opens there
      expect(document.querySelectorAll('[data-preset]')).toHaveLength(PATTERN_PRESETS.length)
      await user.click(screen.getByRole('radio', { name: 'Heatsink' }))
      expect(onGroup).toHaveBeenCalledWith('heatsink')
      const card = screen.getByRole('radio', { name: 'Straight fins' })
      expect(card).toHaveTextContent('fins 1.5 mm · slots 2 mm · 10 mm high')
      await user.click(card)
      const dialog = screen.getByRole('dialog', { name: 'Pattern presets' })
      expect(dialog.querySelector('[data-heatsink-readout]')).toHaveTextContent(
        '11 slots · 12 fins 1.5 mm · 10 mm high (1:6.7) · base 4 mm · walls 1.5 mm',
      )
      expect(dialog).toHaveTextContent('Slot = tool: one pass per level.')
      expect(within(dialog).getByRole('combobox', { name: 'Tool' })).toHaveTextContent(
        'Flat 2 x 12',
      )
      await expectNoAxeViolations(dialog)
      await user.keyboard('{Escape}')
      expect(screen.getByRole('radio', { name: 'Straight fins' })).toBeInTheDocument()
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('Apply sends the fields and the tool once and closes; 1 mm fins warn tall', async () => {
      const { user, apply } = setup({ lastGroup: 'heatsink' })
      await user.click(screen.getByRole('button', { name: 'Presets…' }))
      await user.click(screen.getByRole('radio', { name: 'Straight fins' }))
      const fin = screen.getByRole('combobox', { name: 'Fin thickness' })
      await user.clear(fin)
      await user.type(fin, '1{Enter}')
      const dialog = screen.getByRole('dialog', { name: 'Pattern presets' })
      expect(dialog).toHaveTextContent('1:10')
      expect(dialog).toHaveTextContent('Fins taller than 8 × their thickness')
      await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(apply).toHaveBeenCalledTimes(1)
      const [args, tool] = apply.mock.calls[0]!
      expect(tool).toBe('flat2')
      expect(args).toMatchObject({
        spacing: { gap: '1 mm' },
        margin: ['1.5 mm', '0 mm'],
        depth: '10 mm',
      })
    })

    it('opens on Heatsink when the pattern is straight fins; the step starts from its sizes', async () => {
      const { user } = setup({
        current: { id: 'straightFins', values: { fin: 2, slot: 2, height: 9, wall: 1.5 } },
      })
      await user.click(screen.getByRole('button', { name: 'Presets…' }))
      const card = screen.getByRole('radio', { name: 'Straight fins' })
      expect(card).toHaveAttribute('aria-checked', 'true')
      await user.click(card)
      const dialog = screen.getByRole('dialog', { name: 'Pattern presets' })
      expect(dialog.querySelector('[data-heatsink-readout]')).toHaveTextContent(
        /^9 slots · 10 fins 2 mm · 9 mm high \(1:4\.5\)/,
      )
    })

    it('H2: four heatsink cards; a pin card opens its step with the worked example', async () => {
      const { user } = setup({ lastGroup: 'heatsink' })
      await user.click(screen.getByRole('button', { name: 'Presets…' }))
      const names = [...document.querySelectorAll('[data-preset]')].map(
        (c) => c.querySelector('[class*=presetName]')?.textContent,
      )
      expect(names.map((n) => n?.replace('Current', ''))).toEqual([
        'Straight fins',
        'Square pin fins',
        'Round pin fins',
        'Staggered pin fins',
      ])
      const square = screen.getByRole('radio', { name: 'Square pin fins' })
      expect(square).toHaveTextContent('pins 3 mm · channels 2.5 mm · 8 mm high')
      expect(square.querySelector('svg path')?.getAttribute('d')).toMatch(/^M/)
      await user.click(square)
      const dialog = screen.getByRole('dialog', { name: 'Pattern presets' })
      expect(dialog.querySelector('[data-heatsink-step="squarePins"]')).not.toBeNull()
      expect(dialog.querySelector('[data-heatsink-readout]')).toHaveTextContent(
        '49 pins 3 mm · 8 mm high (1:2.7) · base 6 mm · channels 2.5 mm · border 2 mm',
      )
      expect(dialog).toHaveTextContent('Finishing pass round every pin.')
      expect(within(dialog).getByRole('combobox', { name: 'Tool' })).toHaveTextContent(
        'Flat 2 x 12',
      )
      await expectNoAxeViolations(dialog)
      // Back, then the staggered card: 46 round pins
      await user.keyboard('{Escape}')
      await user.click(screen.getByRole('radio', { name: 'Staggered pin fins' }))
      expect(dialog.querySelector('[data-heatsink-readout]')).toHaveTextContent(
        /^46 pins Ø 3 mm · 8 mm high/,
      )
      expect(within(dialog).getByRole('combobox', { name: 'Pin diameter' })).toBeInTheDocument()
    })

    it('H2: a channel as wide as the tool gets the Ø + 0.5 suggestion; Apply sends inverted pins', async () => {
      const { user, apply } = setup({ lastGroup: 'heatsink' })
      await user.click(screen.getByRole('button', { name: 'Presets…' }))
      await user.click(screen.getByRole('radio', { name: 'Round pin fins' }))
      const dialog = screen.getByRole('dialog', { name: 'Pattern presets' })
      const channel = within(dialog).getByRole('combobox', { name: 'Channel' })
      await user.clear(channel)
      await user.type(channel, '2{Enter}')
      expect(dialog).toHaveTextContent('Channel = tool: each channel is cut twice')
      await user.click(within(dialog).getByRole('button', { name: 'Use 2.5 mm' }))
      expect(dialog).toHaveTextContent('Finishing pass round every pin.')
      const pin = within(dialog).getByRole('combobox', { name: 'Pin diameter' })
      await user.clear(pin)
      await user.type(pin, '0.9{Enter}')
      expect(dialog).toHaveTextContent('Pins taller than 8 × their size')
      await user.clear(pin)
      await user.type(pin, '3{Enter}')
      await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
      expect(apply).toHaveBeenCalledTimes(1)
      const [args, tool] = apply.mock.calls[0]!
      expect(tool).toBe('flat2')
      expect(args).toMatchObject({
        cell: { kind: 'circle', diameter: '3 mm' },
        lattice: 'square',
        spacing: { gap: '2.5 mm' },
        margin: '0 mm',
        invert: true,
        depth: '8 mm',
      })
    })

    it('H2: opens on the current pin card with the pattern sizes', async () => {
      const { user } = setup({
        current: { id: 'squarePins', values: { pin: 4, channel: 3, height: 6 } },
      })
      await user.click(screen.getByRole('button', { name: 'Presets…' }))
      const card = screen.getByRole('radio', { name: 'Square pin fins' })
      expect(card).toHaveAttribute('aria-checked', 'true')
      await user.click(card)
      const dialog = screen.getByRole('dialog', { name: 'Pattern presets' })
      // 40 mm: 6 pins of 4 with 3 between (39 mm), the origin half a pitch off, border 0.5
      expect(dialog.querySelector('[data-heatsink-readout]')).toHaveTextContent(
        '36 pins 4 mm · 6 mm high (1:1.5) · base 8 mm · channels 3 mm · border 0.5 mm',
      )
    })
  })
})
