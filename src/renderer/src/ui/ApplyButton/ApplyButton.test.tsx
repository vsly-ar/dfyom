import { act, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { setReducedMotion } from '../../test/media'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { UiProvider } from '../UiProvider/UiProvider'
import { ApplyButton, type ApplyButtonState } from './ApplyButton'

const props = (state: ApplyButtonState, onApply = vi.fn()) => ({
  state,
  list: 'Pocket 1: depth, corner radius · Drilling 2 added',
  shortcut: '⌘↵',
  keyShortcuts: 'Meta+Enter',
  onApply,
})

const wrap = (ui: React.JSX.Element) => <UiProvider>{ui}</UiProvider>

const live = () => document.querySelector('[aria-live="polite"]')

describe('ApplyButton', () => {
  it('is hidden (inert, out of the a11y tree) while nothing is pending', async () => {
    renderUi(<ApplyButton {...props({ kind: 'clean' })} />)
    expect(screen.queryByRole('button')).toBeNull()
    await expectNoAxeViolations()
  })

  it('shows "Apply N" with its name, shortcut and a tooltip that explains Apply', async () => {
    const onApply = vi.fn()
    const { user } = renderUi(<ApplyButton {...props({ kind: 'pending', count: 3 }, onApply)} />)
    const button = screen.getByRole('button', { name: 'Apply 3 changes' })
    expect(button).toHaveTextContent('Apply3')
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter')
    // keyboard focus opens the tooltip at once: concept first, then the list
    await user.tab()
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Apply changes')
    expect(tip).toHaveTextContent('3 changes not applied yet.')
    expect(tip).toHaveTextContent(/chooses tools, updates draft plans and regenerates toolpaths/)
    expect(tip).toHaveTextContent('Press Enter in a field, or ⌘↵, to apply.')
    expect(tip).toHaveTextContent('Pocket 1: depth, corner radius · Drilling 2 added')
    await expectNoAxeViolations()
    await user.click(button)
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it('shows the auto-apply wait as a draining bar and in its tooltip (DF28)', async () => {
    const due = { at: Date.now() + 10_000, durationMs: 10_000 }
    const { user } = renderUi(
      <ApplyButton {...props({ kind: 'pending', count: 2 })} autoApply={due} />,
    )
    const button = screen.getByRole('button', { name: 'Apply 2 changes' })
    expect(button).toHaveAttribute('data-auto-apply')
    const bar = button.querySelector('[class*="countdown"]')
    expect(bar).toHaveAttribute('aria-hidden', 'true')
    expect(bar).not.toHaveAttribute('data-static')
    await user.tab()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Applies by itself after 10 s without another edit (Settings).',
    )
    await expectNoAxeViolations()
  })

  it('keeps the auto-apply bar still under reduced motion and shows none when not pending', () => {
    setReducedMotion(true)
    const due = { at: Date.now() + 5000, durationMs: 5000 }
    const { rerender } = renderUi(
      <ApplyButton {...props({ kind: 'pending', count: 1 })} autoApply={due} />,
    )
    expect(document.querySelector('[class*="countdown"]')).toHaveAttribute('data-static')
    rerender(wrap(<ApplyButton {...props({ kind: 'clean' })} autoApply={due} />))
    expect(document.querySelector('[data-auto-apply]')).toBeNull()
    setReducedMotion(false)
  })

  it('shows "Applying…" with the progress ring only after --delay-indicator', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = renderUi(
        <ApplyButton {...props({ kind: 'applying', count: 0, progress: 0.5 })} />,
      )
      // fast work never flickers: nothing yet
      expect(screen.queryByRole('button')).toBeNull()
      act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(screen.getByRole('button', { name: 'Applying…' })).toBeInTheDocument()
      expect(screen.getByRole('progressbar', { name: 'Apply progress' })).toHaveAttribute(
        'aria-valuenow',
        '50',
      )
      // edits made meanwhile show their count beside the ring
      rerender(wrap(<ApplyButton {...props({ kind: 'applying', count: 2, progress: null })} />))
      expect(screen.getByRole('button', { name: 'Applying… Apply 2 changes' })).toBeInTheDocument()
      expect(screen.getByRole('progressbar', { name: 'Apply progress' })).not.toHaveAttribute(
        'aria-valuenow',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('the indeterminate ring is static under reduced motion', () => {
    setReducedMotion(true)
    renderUi(<ApplyButton {...props({ kind: 'applying', count: 0, progress: null })} delayMs={0} />)
    return screen.findByRole('progressbar', { name: 'Apply progress' }).then((ring) => {
      expect(ring).not.toHaveAttribute('data-indeterminate')
    })
  })

  it('shows "Apply failed" with the error in its tooltip; a click retries', async () => {
    const onApply = vi.fn()
    const { user } = renderUi(
      <ApplyButton
        {...props(
          {
            kind: 'failed',
            count: 1,
            error: { code: 'internal.unexpected', message: 'boom', issues: [], frames: [] },
          },
          onApply,
        )}
      />,
    )
    const button = screen.getByRole('button', { name: 'Apply failed' })
    await user.tab()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Click to try again.')
    await user.click(button)
    expect(onApply).toHaveBeenCalled()
  })

  it('says "Applied by agent" after another source applied', () => {
    renderUi(<ApplyButton {...props({ kind: 'appliedBy', by: 'agent' })} />)
    expect(screen.getByRole('button', { name: 'Applied by agent' })).toHaveTextContent(
      'Applied by agent',
    )
  })

  it('announces the count after a pause and "Changes applied" at once', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = renderUi(
        <ApplyButton {...props({ kind: 'pending', count: 2 })} liveDelayMs={1000} />,
      )
      expect(live()).toHaveTextContent('')
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(live()).toHaveTextContent('2 changes not applied')
      rerender(
        wrap(<ApplyButton {...props({ kind: 'clean', applied: true })} liveDelayMs={1000} />),
      )
      act(() => {
        vi.advanceTimersByTime(0)
      })
      expect(live()).toHaveTextContent('Changes applied')
      // nothing pending without an Apply (undo): no "applied"
      rerender(wrap(<ApplyButton {...props({ kind: 'pending', count: 1 })} liveDelayMs={1000} />))
      rerender(wrap(<ApplyButton {...props({ kind: 'clean' })} liveDelayMs={1000} />))
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(live()).toHaveTextContent('Changes applied')
    } finally {
      vi.useRealTimers()
    }
  })
})
