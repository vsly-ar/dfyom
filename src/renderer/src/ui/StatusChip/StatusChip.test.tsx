import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { StatusChip } from './StatusChip'

describe('StatusChip', () => {
  it('shows its text with a decorative tone icon (colour never alone)', () => {
    const { container } = renderUi(<StatusChip tone="warning">Stale: tool changed</StatusChip>)
    const chip = screen.getByText('Stale: tool changed')
    expect(chip).toHaveAttribute('data-tone', 'warning')
    const icon = container.querySelector('svg')
    expect(icon).toHaveAttribute('aria-hidden', 'true')
  })

  it('has no icon for the neutral tone', () => {
    const { container } = renderUi(<StatusChip>3 operations</StatusChip>)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('has no axe violations', async () => {
    renderUi(
      <>
        <StatusChip tone="success">Up to date</StatusChip>
        <StatusChip tone="busy">Updating…</StatusChip>
        <StatusChip tone="danger">Evaluation failed</StatusChip>
      </>,
    )
    await expectNoAxeViolations()
  })
})
