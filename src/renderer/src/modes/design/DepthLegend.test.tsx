// The depth legend (engraved-patterns.md § Depth legend): a tick per level in use from Deepest
// (left) to Shallowest (right), the two depths under the ends, a band for a continuous fade, and
// a name that reads the depths in use.
// Doc: docs/modes/engraved-patterns.md#depth-legend
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { DepthLegend } from './DepthLegend'

describe('DepthLegend', () => {
  it('ticks at the levels in use, deepest at the left; the depths in its name', async () => {
    const { container } = renderUi(
      <DepthLegend
        min={0.2}
        max={1}
        legend={{ kind: 'ticks', levels: [1, 0.6, 0.35] }}
        units="mm"
      />,
    )
    const legend = screen.getByRole('img', { name: /^Depth legend/ })
    expect(legend).toHaveAccessibleName(
      'Depth legend: dark is deep, 1 mm; light is shallow, 0.2 mm. Depths in use: 1 mm, 0.68 mm, 0.48 mm.',
    )
    const ticks = [...container.querySelectorAll<HTMLElement>('[data-level]')]
    expect(ticks.map((t) => [t.dataset['level'], t.style.left])).toEqual([
      ['1', '0%'],
      ['0.6', '40%'],
      ['0.35', '65%'],
    ])
    expect(legend).toHaveTextContent('1 mm0.2 mm')
    await expectNoAxeViolations(container)
  })

  it('a continuous fade: one band over its range, no ticks', () => {
    const { container } = renderUi(
      <DepthLegend
        min={0.5}
        max={1.5}
        legend={{ kind: 'continuous', min: 0.1, max: 1 }}
        units="mm"
      />,
    )
    expect(container.querySelectorAll('[data-level]')).toHaveLength(0)
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'Depth legend: dark is deep, 1.5 mm; light is shallow, 0.5 mm. The depth fades from 1.5 mm to 0.6 mm.',
    )
  })
})
