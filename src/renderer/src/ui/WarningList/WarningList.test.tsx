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
  tier: { soft: 'Note', hard: 'Warning' },
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
            fix: { label: 'Apply ≥ 3.2 mm', onApply },
          },
          { id: 'b', tier: 'soft', text: 'Needs pecking.' },
        ]}
      />,
    )
    const list = screen.getByRole('list', { name: 'Warnings' })
    expect(list).toHaveTextContent('Warning: Pocket 1No tool can make this corner.')
    await user.click(screen.getByRole('button', { name: 'Apply ≥ 3.2 mm' }))
    expect(onApply).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Pocket 1' }))
    expect(onSelect).toHaveBeenCalledOnce()
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
})
