import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { StopControl } from './StopControl'

describe('StopControl', () => {
  it('is a labelled button that stops at once, without confirmation', async () => {
    const onStop = vi.fn()
    const { user } = renderUi(<StopControl onStop={onStop} />)
    const stop = screen.getByRole('button', { name: 'Stop' })
    expect(stop).toBeEnabled()
    await user.click(stop)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await expectNoAxeViolations()
  })

  it('is reachable by keyboard', async () => {
    const onStop = vi.fn()
    const { user } = renderUi(<StopControl onStop={onStop} />)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('with nothing to stop: aria-disabled, says why, clicks do nothing (DF35)', async () => {
    const onStop = vi.fn()
    const { user } = renderUi(
      <StopControl onStop={onStop} disabledReason="Nothing to stop: the machine is not moving." />,
    )
    const stop = screen.getByRole('button', { name: 'Stop' })
    expect(stop).toHaveAttribute('aria-disabled', 'true')
    expect(stop).toHaveAccessibleDescription('Nothing to stop: the machine is not moving.')
    await user.click(stop)
    expect(onStop).not.toHaveBeenCalled()
    // focusable, so keyboard and screen-reader users hear the reason
    expect(stop).not.toHaveAttribute('disabled')
    expect(stop).toHaveFocus()
    await expectNoAxeViolations()
  })
})
