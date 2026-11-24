import { act, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { JobIndicator, type JobView } from './JobIndicator'

const JOBS: JobView[] = [
  { id: 'j1', label: 'Evaluate part', state: 'running' },
  { id: 'j2', label: 'Generate toolpaths', state: 'paused', progress: { done: 3, total: 4 } },
]

const handlers = () => ({ onPause: vi.fn(), onResume: vi.fn(), onCancel: vi.fn() })

describe('JobIndicator', () => {
  it('appears only after --delay-indicator', () => {
    vi.useFakeTimers()
    try {
      renderUi(<JobIndicator jobs={JOBS.slice(0, 1)} {...handlers()} />)
      expect(screen.queryByRole('button')).toBeNull()
      act(() => {
        vi.advanceTimersByTime(299)
      })
      expect(screen.queryByRole('button')).toBeNull()
      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(screen.getByRole('button', { name: 'Evaluate part' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the count and the newest job, and lists every job with its controls', async () => {
    const h = handlers()
    const { user } = renderUi(<JobIndicator jobs={JOBS} delayMs={0} {...h} />)
    const trigger = await screen.findByRole('button', { name: '2 jobs · Generate toolpaths' })
    await user.click(trigger)
    const list = await screen.findByRole('list', { name: 'Jobs' })
    expect(list.querySelectorAll('li')).toHaveLength(2)
    expect(screen.getByRole('progressbar', { name: 'Generate toolpaths' })).toHaveAttribute(
      'aria-valuenow',
      '3',
    )
    // indeterminate without a total
    expect(screen.getByRole('progressbar', { name: 'Evaluate part' })).not.toHaveAttribute(
      'aria-valuenow',
    )
    await user.click(screen.getByRole('button', { name: 'Pause Evaluate part' }))
    expect(h.onPause).toHaveBeenCalledWith('j1')
    await user.click(screen.getByRole('button', { name: 'Resume Generate toolpaths' }))
    expect(h.onResume).toHaveBeenCalledWith('j2')
    await user.click(screen.getByRole('button', { name: 'Cancel Generate toolpaths' }))
    expect(h.onCancel).toHaveBeenCalledWith('j2')
  })

  it('offers no Pause for a job that refuses it (homing, DF82); Cancel stays', async () => {
    const jobs: JobView[] = [{ id: 'h1', label: 'Home', state: 'running', pausable: false }]
    const { user } = renderUi(<JobIndicator jobs={jobs} delayMs={0} {...handlers()} />)
    await user.click(await screen.findByRole('button', { name: 'Home' }))
    await screen.findByRole('list', { name: 'Jobs' })
    expect(screen.queryByRole('button', { name: 'Pause Home' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel Home' })).toBeInTheDocument()
  })

  it('disappears at once when the jobs end', async () => {
    const { rerender } = renderUi(<JobIndicator jobs={JOBS} delayMs={0} {...handlers()} />)
    expect(await screen.findByRole('button', { name: /2 jobs/ })).toBeInTheDocument()
    rerender(<JobIndicator jobs={[]} delayMs={0} {...handlers()} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('has no axe violations, list open', async () => {
    const { user } = renderUi(<JobIndicator jobs={JOBS} delayMs={0} {...handlers()} />)
    await user.click(await screen.findByRole('button', { name: /2 jobs/ }))
    await screen.findByRole('list', { name: 'Jobs' })
    await expectNoAxeViolations()
  })
})
