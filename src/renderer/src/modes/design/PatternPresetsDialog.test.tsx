// The pattern's Presets dialog (hardening DF107): preview cards in one radio group, the current
// preset marked and focused, arrows and Home/End move, Enter or a click applies once and closes,
// Escape or the footer's Close (P10) closes without applying; the polar preview's ring guides (P10).
// Doc: docs/modes/patterns.md#presets-dialog-and-more-presets-df107
import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import { PATTERN_PRESETS } from '../../../../core/design/pattern/presets'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { PatternPresetsDialog, PRESET_COLUMNS } from './PatternPresetsDialog'

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
})
