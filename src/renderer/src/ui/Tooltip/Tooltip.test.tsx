import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderUi } from '../../test/render'
import { UiProvider } from '../UiProvider/UiProvider'
import { Tooltip } from './Tooltip'

describe('Tooltip', () => {
  it('opens on keyboard focus at once and describes its trigger', async () => {
    const { user } = renderUi(
      <Tooltip content="Undo Add pocket (Pocket 2)" shortcut="⌘Z">
        <button type="button">Undo</button>
      </Tooltip>,
    )
    await user.tab()
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Undo Add pocket (Pocket 2)⌘Z')
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveAccessibleDescription(
      /Undo Add pocket/,
    )
  })

  it('opens on hover only after --delay-tooltip (450 ms)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
      render(
        <UiProvider>
          <Tooltip content="Fit">
            <button type="button">F</button>
          </Tooltip>
        </UiProvider>,
      )
      await user.hover(screen.getByRole('button', { name: 'F' }))
      act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(screen.queryByRole('tooltip')).toBeNull()
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(screen.getByRole('tooltip')).toHaveTextContent('Fit')
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes with Escape', async () => {
    const { user } = renderUi(
      <Tooltip content="Fit">
        <button type="button">F</button>
      </Tooltip>,
    )
    await user.tab()
    await screen.findByRole('tooltip')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
