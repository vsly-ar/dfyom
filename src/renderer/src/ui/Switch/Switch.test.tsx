import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Switch } from './Switch'

describe('Switch', () => {
  it('is a switch named by its visible label; clicking the label toggles it', async () => {
    const onChange = vi.fn()
    const { user } = renderUi(<Switch label="Show dimensions" onCheckedChange={onChange} />)
    const sw = screen.getByRole('switch', { name: 'Show dimensions' })
    expect(sw).not.toBeChecked()
    await user.click(screen.getByText('Show dimensions'))
    expect(onChange).toHaveBeenCalledWith(true)
    expect(sw).toBeChecked()
  })

  it('takes the label as aria-label when hidden, and toggles with Space', async () => {
    const { user } = renderUi(<Switch label="Finish pass" hideLabel defaultChecked />)
    expect(screen.queryByText('Finish pass')).toBeNull()
    const sw = screen.getByRole('switch', { name: 'Finish pass' })
    expect(sw).toBeChecked()
    await user.tab()
    await user.keyboard(' ')
    expect(sw).not.toBeChecked()
  })

  it('has no axe violations', async () => {
    renderUi(
      <>
        <Switch label="Snap to grid" />
        <Switch label="Tabs" hideLabel />
      </>,
    )
    await expectNoAxeViolations()
  })
})
