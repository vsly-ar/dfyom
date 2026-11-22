import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { WarningList, type WarningListLabels } from './WarningList'

const labels: WarningListLabels = {
  list: 'Warnings',
  dismiss: 'Dismiss',
  dismissed: (n) => `${n} dismissed`,
  show: 'Show',
  hide: 'Hide',
  tier: { soft: 'Note', hard: 'Warning', error: 'Error' },
}

describe('WarningList', () => {
  it('shows hard and soft warnings with their tier, subject and fix', async () => {
    const onApply = vi.fn()
    const onSelect = vi.fn()
    const { user } = renderUi(
      <WarningList
        labels={labels}
        items={[
          {
            id: 'a',
            tier: 'hard',
            subject: 'Pocket 1',
            onSelect,
            text: 'No tool can make this corner.',
            fix: { label: 'Use ≥ 3.2 mm', onApply },
          },
          { id: 'b', tier: 'soft', text: 'Needs pecking.' },
          { id: 'c', tier: 'error', text: 'No tool assigned.' },
        ]}
      />,
    )
    const list = screen.getByRole('list', { name: 'Warnings' })
    expect(list).toHaveTextContent('Warning: Pocket 1No tool can make this corner.')
    await user.click(screen.getByRole('button', { name: 'Use ≥ 3.2 mm' }))
    expect(onApply).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Pocket 1' }))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(list).toHaveTextContent('Error: No tool assigned.')
    // only soft warnings can be dismissed
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1)
    await expectNoAxeViolations()
  })

  it('collapses dismissed soft warnings to "n dismissed · Show"', async () => {
    const { user } = renderUi(
      <WarningList
        labels={labels}
        items={[{ id: 'b', tier: 'soft', text: 'Needs pecking.' }]}
        empty="None"
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Needs pecking.')).not.toBeInTheDocument()
    expect(screen.getByText(/1 dismissed/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show' }))
    expect(screen.getByText('Needs pecking.')).toBeInTheDocument()
  })

  it('marks warnings Apply may change, and the whole list as outdated until Apply', async () => {
    renderUi(
      <WarningList
        labels={labels}
        items={[
          {
            id: 'a',
            tier: 'soft',
            text: 'No tool can make this corner.',
            pendingApply: 'May change on Apply: the tool is chosen again.',
          },
        ]}
        empty="None"
        outdated="Outdated until Apply."
      />,
    )
    expect(screen.getByText('Outdated until Apply.')).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Warnings' })
    expect(list).toHaveTextContent('May change on Apply: the tool is chosen again.')
    expect(list.querySelector('[data-pending]')).not.toBeNull()
    await expectNoAxeViolations()
  })
})
