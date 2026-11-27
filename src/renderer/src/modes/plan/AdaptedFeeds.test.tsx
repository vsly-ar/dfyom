// The "Adapted for <machine>" line of the plan inspector's feeds group (hardening DF139 A3): none,
// one and three adapted fields, the limit in each part's tooltip, inch units, and axe.
// Doc: docs/architecture/feeds-speeds.md#recommended-presets-on-the-plan-machine-hardening-df139
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { AdaptedFeeds, type AdaptedFeed } from './AdaptedFeeds'

const limits = { minSpeed: 8000, maxSpeed: 24_000, maxFeedXY: 1100, maxFeedZ: 1500, power: 500 }
const three: AdaptedFeed[] = [
  { field: 'feedRate', from: 1402, to: 1100, reason: 'maxFeedRate' },
  { field: 'plungeRate', from: 2286, to: 1500, reason: 'maxFeedRateZ' },
  { field: 'stepdown', from: 0.51, to: 0.38, reason: 'power' },
]

describe('AdaptedFeeds', () => {
  it('renders nothing without adapted fields', () => {
    renderUi(<AdaptedFeeds machine="Shapeoko 4" fields={[]} limits={limits} units="mm" />)
    expect(screen.queryByTestId('adapted-feeds')).toBeNull()
  })

  it('one field: the machine, stored → used value and the reason', () => {
    renderUi(
      <AdaptedFeeds machine="Shapeoko 4" fields={three.slice(0, 1)} limits={limits} units="mm" />,
    )
    expect(screen.getByTestId('adapted-feeds')).toHaveTextContent(
      'Adapted for Shapeoko 4: feed 1402 → 1100 mm/min (X/Y max feed)',
    )
  })

  it('three fields, joined; each part names its limit in a tooltip on keyboard focus', async () => {
    const { user } = renderUi(
      <AdaptedFeeds machine="Shapeoko 4" fields={three} limits={limits} units="mm" />,
    )
    expect(screen.getByTestId('adapted-feeds')).toHaveTextContent(
      'Adapted for Shapeoko 4: feed 1402 → 1100 mm/min (X/Y max feed) · plunge 2286 → 1500 mm/min (Z max feed) · stepdown 0.51 → 0.38 mm (spindle power)',
    )
    await user.tab()
    expect(screen.getByText('feed 1402 → 1100 mm/min (X/Y max feed)')).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/^X\/Y max feed 1100 mm\/min\.$/)
    await user.tab()
    await user.tab()
    expect(screen.getByText('stepdown 0.51 → 0.38 mm (spindle power)')).toHaveAccessibleDescription(
      /more power than the 500 W spindle gives at this speed/,
    )
  })

  it('a speed clamped to the spindle range, in inch units', () => {
    renderUi(
      <AdaptedFeeds
        machine={undefined}
        fields={[
          { field: 'spindleSpeed', from: 30560, to: 24000, reason: 'spindleRange' },
          { field: 'feedRate', from: 1270, to: 997.3, reason: 'spindleRange' },
        ]}
        limits={limits}
        units="inch"
      />,
    )
    expect(screen.getByTestId('adapted-feeds')).toHaveTextContent(
      'Adapted for the machine: speed 30560 → 24000 rpm (spindle range) · feed 50 → 39.26 in/min (spindle range)',
    )
  })

  it('has no axe violations', async () => {
    renderUi(<AdaptedFeeds machine="Shapeoko 4" fields={three} limits={limits} units="mm" />)
    await expectNoAxeViolations()
  })
})
