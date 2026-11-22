import { Icon } from '../icons/Icon'
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('states the next step with a heading, one sentence and one primary action', async () => {
    const onClick = vi.fn()
    const { user } = renderUi(
      <EmptyState
        title="Design a part first"
        description="Plans are made from a part. Add a part in Design."
        action={{ label: 'Go to Design', icon: <Icon name="arrow-right" />, onClick }}
      />,
    )
    expect(
      screen.getByRole('heading', { name: 'Design a part first', level: 3 }),
    ).toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Go to Design' })
    expect(button).toHaveAttribute('data-variant', 'primary')
    await user.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('has no axe violations', async () => {
    renderUi(<EmptyState title="Create a plan to run" description="Runs start from a plan." />)
    await expectNoAxeViolations()
  })
})
