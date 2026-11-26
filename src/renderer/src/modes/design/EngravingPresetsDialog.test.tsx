// The engraved pattern's Presets dialog (engraved-patterns.md E3): the 13 presets as cards in three
// groups with their motif drawn (light lines lighter), the current one marked and focused, arrows
// move, Enter or a click applies once and closes, Escape closes without applying.
// Doc: docs/modes/engraved-patterns.md#presets
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ENGRAVING_PRESETS } from '../../../../core/design/engraving/presets'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { EngravingPresetsDialog } from './EngravingPresetsDialog'

describe('EngravingPresetsDialog (E3)', () => {
  it('lists the 13 presets in Tiles, Motifs and Round, each with its lines', async () => {
    const { user } = renderUi(
      <EngravingPresetsDialog current="rosette" units="mm" onApply={() => {}} />,
    )
    await user.click(screen.getByRole('button', { name: 'Presets…' }))
    const dialog = screen.getByRole('dialog', { name: 'Engraving presets' })
    const cards = screen.getAllByRole('radio')
    expect(cards).toHaveLength(13)
    expect(cards.map((c) => c.getAttribute('data-preset'))).toEqual(
      ENGRAVING_PRESETS.map((p) => p.id),
    )
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Tiles',
      'Motifs',
      'Round',
    ])
    for (const c of cards) expect(c.querySelector('svg path')?.getAttribute('d')).toMatch(/^M/)
    // the rosette's light circles are drawn lighter than its deep rings
    const opacities = new Set(
      [...screen.getByRole('radio', { name: 'Rosette' }).querySelectorAll('svg path')].map((p) =>
        p.getAttribute('stroke-opacity'),
      ),
    )
    expect(opacities.size).toBe(2)
    expect(screen.getByRole('radio', { name: 'Waves' })).toHaveTextContent('20 mm × 10 mm')
    await expectNoAxeViolations(dialog)
  })

  it('marks and focuses the current preset; Enter applies the next once', async () => {
    const onApply = vi.fn()
    const { user } = renderUi(
      <EngravingPresetsDialog current="rosette" units="mm" onApply={onApply} />,
    )
    const trigger = screen.getByRole('button', { name: 'Presets…' })
    await user.click(trigger)
    const rosette = screen.getByRole('radio', { name: 'Rosette' })
    expect(rosette).toHaveAttribute('aria-checked', 'true')
    expect(rosette).toHaveTextContent('Current')
    expect(rosette).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(onApply).not.toHaveBeenCalled()
    // P11: the shared shell's footer Close, as the pattern's
    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onApply).not.toHaveBeenCalled()
    await user.click(trigger)
    await user.keyboard('{ArrowRight}{Enter}')
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply.mock.calls[0]![0].id).toBe('sunburst')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a click applies that preset; a shapes motif has none current', async () => {
    const onApply = vi.fn()
    const { user } = renderUi(
      <EngravingPresetsDialog current={undefined} units="mm" onApply={onApply} />,
    )
    await user.click(screen.getByRole('button', { name: 'Presets…' }))
    expect(
      screen.getAllByRole('radio').every((c) => c.getAttribute('aria-checked') === 'false'),
    ).toBe(true)
    await user.click(screen.getByRole('radio', { name: 'Greek key' }))
    expect(onApply.mock.calls[0]![0].id).toBe('greek-key')
  })
})
