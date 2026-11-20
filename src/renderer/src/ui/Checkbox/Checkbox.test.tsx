import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Checkbox } from './Checkbox'

describe('Checkbox', () => {
  it('is a checkbox named by its label; clicking the label toggles it', async () => {
    const onChange = vi.fn()
    const { user } = renderUi(<Checkbox label="Peck" onCheckedChange={onChange} />)
    const box = screen.getByRole('checkbox', { name: 'Peck' })
    expect(box).not.toBeChecked()
    await user.click(screen.getByText('Peck'))
    expect(onChange).toHaveBeenCalledWith(true)
    expect(box).toBeChecked()
  })

  it('toggles with Space and shows the mixed state', async () => {
    const { user } = renderUi(
      <>
        <Checkbox label="Chip break" />
        <Checkbox label="All operations" checked="indeterminate" />
      </>,
    )
    await user.tab()
    await user.keyboard(' ')
    expect(screen.getByRole('checkbox', { name: 'Chip break' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'All operations' })).toBePartiallyChecked()
  })

  it('has no axe violations', async () => {
    renderUi(<Checkbox label="Peck" defaultChecked />)
    await expectNoAxeViolations()
  })
})
