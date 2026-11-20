import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Progress } from './Progress'

describe('Progress', () => {
  it('is a named progressbar with value, max and value text', () => {
    renderUi(<Progress label="Run" value={1884} max={3020} valueText="Line 1 884 of 3 020" />)
    const bar = screen.getByRole('progressbar', { name: 'Run' })
    expect(bar).toHaveAttribute('aria-valuenow', '1884')
    expect(bar).toHaveAttribute('aria-valuemax', '3020')
    expect(bar).toHaveAttribute('aria-valuetext', 'Line 1 884 of 3 020')
  })

  it('is indeterminate without a value', () => {
    renderUi(<Progress label="Toolpath generation" value={null} />)
    const bar = screen.getByRole('progressbar', { name: 'Toolpath generation' })
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(bar).toHaveAttribute('data-state', 'indeterminate')
  })

  it('has no axe violations', async () => {
    renderUi(<Progress label="Run" value={40} />)
    await expectNoAxeViolations()
  })
})
