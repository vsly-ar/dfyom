// The overrides section's sliders (hardening DF85). Spec: docs/modes/run-machine.md#overrides-m6
import { act, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { closedStatus, type RunStatus } from '../../../../core/run/service'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { OVERRIDE_DEBOUNCE_MS, OverridesSection } from './OverridesSection'
import type { OverrideChange } from './run-store'

function statusWith(over: Partial<RunStatus> = {}): RunStatus {
  return {
    ...closedStatus(),
    connection: { state: 'open', target: 'virtual', timeScale: 1 },
    state: 'Run',
    homed: true,
    overrides: { feed: 100, rapid: 100, spindle: 100 },
    job: {
      jobId: 'run-1',
      phase: 'streaming',
      line: 10,
      startedAt: '2026-11-24T10:00:00.000Z',
      elapsedSeconds: 1,
      programmed: { feed: 3000, spindle: 18000 },
    },
    ...over,
  }
}

const group = (name: string) => within(screen.getByRole('group', { name }))

describe('OverridesSection (DF85)', () => {
  it('shows the resulting F and S; a slider steps 1 % with the arrows and sends the target', async () => {
    const onChange = vi.fn<(c: OverrideChange) => Promise<void>>(async () => {})
    const { user } = renderUi(
      <OverridesSection status={statusWith()} onChange={onChange} units="mm" />,
    )
    expect(group('Feed').getByText('F 3000 mm/min')).toBeInTheDocument()
    expect(group('Spindle').getByText('S 18000 rpm')).toBeInTheDocument()
    const feed = group('Feed').getByRole('slider', { name: 'Feed override' })
    expect(feed).toHaveAttribute('aria-valuenow', '100')
    expect(feed).toHaveAttribute('aria-valuetext', '100 %, F 3000 mm/min')
    expect(feed).toHaveAttribute('aria-valuemin', '10')
    expect(feed).toHaveAttribute('aria-valuemax', '200')
    act(() => feed.focus())
    await user.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith({ feed: 101 })
    // ±10 % stay GRBL's coarse steps
    await user.click(group('Feed').getByRole('button', { name: 'Increase feed override by 10 %' }))
    expect(onChange).toHaveBeenLastCalledWith({ feed: '+10' })
  })

  it('caps the slider at the machine maximum for the programmed F and S and says why', async () => {
    const onChange = vi.fn(async () => {})
    const { user } = renderUi(
      <OverridesSection
        status={statusWith({ overrides: { feed: 160, rapid: 100, spindle: 130 } })}
        onChange={onChange}
        machine={{ maxFeed: 5000, maxSpindle: 24000, spindleControl: 'gcode' }}
      />,
    )
    expect(
      group('Feed').getByText("Up to 166 %: the machine's max feed is 5000 mm/min."),
    ).toBeInTheDocument()
    expect(
      group('Spindle').getByText("Up to 133 %: the machine's max spindle speed is 24000 rpm."),
    ).toBeInTheDocument()
    const feed = group('Feed').getByRole('slider', { name: 'Feed override' })
    expect(feed).toHaveAccessibleDescription(/Up to 166 %/)
    act(() => feed.focus())
    await user.keyboard('{End}')
    expect(onChange).toHaveBeenLastCalledWith({ feed: 166 })
    // +10 % past the cap goes to the cap; at the cap it is disabled
    await user.click(group('Feed').getByRole('button', { name: 'Increase feed override by 10 %' }))
    expect(onChange).toHaveBeenLastCalledWith({ feed: 166 })
    expect(
      group('Spindle').getByRole('button', { name: 'Increase spindle override by 10 %' }),
    ).toBeEnabled()
    await expectNoAxeViolations()
  })

  it('disables the spindle with the reason on a manual spindle or in laser mode', async () => {
    const onChange = vi.fn(async () => {})
    const view = renderUi(
      <OverridesSection
        status={statusWith()}
        onChange={onChange}
        machine={{ spindleControl: 'manual' }}
      />,
    )
    const spindle = group('Spindle')
    expect(spindle.getByRole('slider', { name: 'Spindle override' })).toHaveAttribute(
      'data-disabled',
    )
    expect(
      spindle.getByText('The spindle speed is set by hand on this machine: no spindle override.'),
    ).toBeInTheDocument()
    expect(
      spindle.getByRole('button', { name: 'Decrease spindle override by 10 %' }),
    ).toBeDisabled()
    await expectNoAxeViolations()
    view.rerender(<OverridesSection status={statusWith({ laserMode: true })} onChange={onChange} />)
    expect(
      group('Spindle').getByText('Laser mode is on ($32=1): no spindle override.'),
    ).toBeInTheDocument()
    // the feed works without a run: no resulting F, the controller's range only
    view.rerender(
      <OverridesSection status={statusWith({ job: undefined } as never)} onChange={onChange} />,
    )
    expect(group('Feed').queryByText(/mm\/min/)).toBeNull()
  })

  it('debounces a drag and keeps one target in flight, then sends the latest', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let release: () => void = () => {}
      const onChange = vi.fn(
        () =>
          new Promise<void>((r) => {
            release = r
          }),
      )
      const { user } = renderUi(<OverridesSection status={statusWith()} onChange={onChange} />)
      const feed = group('Feed').getByRole('slider', { name: 'Feed override' })
      act(() => feed.focus())
      await user.keyboard('{ArrowRight}')
      expect(onChange).toHaveBeenCalledTimes(1)
      // while the first is in flight the next presses wait; only the latest goes
      await user.keyboard('{ArrowRight}{ArrowRight}')
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(feed).toHaveAttribute('aria-valuenow', '103')
      await act(async () => release())
      expect(onChange).toHaveBeenCalledTimes(2)
      expect(onChange).toHaveBeenLastCalledWith({ feed: 103 })
      await act(async () => release())
      await act(async () => vi.advanceTimersByTimeAsync(OVERRIDE_DEBOUNCE_MS))
      expect(onChange).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
