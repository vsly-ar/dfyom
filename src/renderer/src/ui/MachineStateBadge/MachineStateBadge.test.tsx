import { act, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { setReducedMotion } from '../../test/media'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { MachineStateBadge, type MachineState } from './MachineStateBadge'

const dot = (): Element | null => document.querySelector('[data-part="orbit-dot"]')

describe('MachineStateBadge', () => {
  it.each([
    ['offline', 'Not connected'],
    ['idle', 'Idle'],
    ['moving', 'Running'],
    ['hold', 'Feed hold'],
    ['action', 'Tool change'],
    ['needsHoming', 'Needs homing'],
    ['alarm', 'Alarm'],
  ] satisfies [MachineState, string][])('%s shows the label "%s" and a shape', (state, label) => {
    renderUi(<MachineStateBadge state={state} />)
    const badge = screen.getByText(label)
    expect(badge).toHaveAttribute('data-state', state)
    expect(badge.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  })

  it('takes a specific label', () => {
    renderUi(<MachineStateBadge state="alarm" label="Alarm 2: soft limit" />)
    expect(screen.getByText('Alarm 2: soft limit')).toBeInTheDocument()
  })

  it('running: draws the circling dot, and only the static outline under reduced motion', () => {
    renderUi(<MachineStateBadge state="moving" />)
    expect(dot()).not.toBeNull()
    act(() => setReducedMotion(true))
    expect(dot()).toBeNull()
    expect(document.querySelector('[data-part="orbit"]')).not.toBeNull()
    expect(screen.getByText('Running')).toHaveAttribute('data-motion', 'reduce')
  })

  it('honours the app setting data-motion="reduce" on the root', async () => {
    document.documentElement.dataset['motion'] = 'reduce'
    try {
      renderUi(<MachineStateBadge state="action" />)
      expect(screen.getByText('Tool change')).toHaveAttribute('data-motion', 'reduce')
      await act(async () => {
        delete document.documentElement.dataset['motion']
        await Promise.resolve()
      })
      expect(screen.getByText('Tool change')).toHaveAttribute('data-motion', 'full')
    } finally {
      delete document.documentElement.dataset['motion']
    }
  })

  it('has no axe violations', async () => {
    renderUi(
      <>
        <MachineStateBadge state="moving" />
        <MachineStateBadge state="hold" />
      </>,
    )
    await expectNoAxeViolations()
  })
})
