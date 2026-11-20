import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Popover } from './Popover'

describe('Popover', () => {
  it('opens from its trigger as a named dialog and returns focus on Escape', async () => {
    const { user } = renderUi(
      <Popover
        label="Adjust Width"
        title="Adjust Width"
        content={<button type="button">Increase</button>}
      >
        <button type="button">Width</button>
      </Popover>,
    )
    const trigger = screen.getByRole('button', { name: 'Width' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Adjust Width' })).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('has no axe violations while open', async () => {
    renderUi(
      <Popover label="Pick a tool" defaultOpen content={<p>T1 · Ø6 flat end mill</p>}>
        <button type="button">Tool</button>
      </Popover>,
    )
    await screen.findByRole('dialog', { name: 'Pick a tool' })
    await expectNoAxeViolations()
  })
})
