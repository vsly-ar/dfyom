import { act, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderUi } from '../../test/render'
import { Dialog } from '../Dialog/Dialog'
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

  it('stays down when focus returns from the dialog its trigger opened (DF48)', async () => {
    function Opener(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      const opener = useRef<HTMLButtonElement>(null)
      return (
        <>
          <Tooltip content="Shapes">
            <button ref={opener} type="button" onClick={() => setOpen(true)}>
              S
            </button>
          </Tooltip>
          <Dialog
            title="Shapes"
            open={open}
            onOpenChange={setOpen}
            onCloseAutoFocus={(e) => {
              e.preventDefault()
              opener.current?.focus()
            }}
          >
            <button type="button">Inside</button>
          </Dialog>
          <button type="button">Other</button>
        </>
      )
    }
    const { user } = renderUi(<Opener />)
    await user.tab()
    await screen.findByRole('tooltip')
    await user.keyboard('{Enter}')
    await screen.findByRole('dialog', { name: 'Shapes' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // focus is back on the trigger, the tooltip stays down
    expect(screen.getByRole('button', { name: 'S' })).toHaveFocus()
    expect(screen.queryByRole('tooltip')).toBeNull()
    // Tab away and back: keyboard focus shows it again
    await user.tab()
    await user.tab({ shift: true })
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Shapes')
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
