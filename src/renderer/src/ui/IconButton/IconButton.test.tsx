import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Icon } from '../icons/Icon'
import { IconButton } from './IconButton'

describe('IconButton', () => {
  it('is named by its label and shows the same text plus the shortcut as a tooltip on focus', async () => {
    const { user } = renderUi(
      <IconButton label="Rectangle" shortcut="R" icon={<Icon name="rect" />} />,
    )
    const button = screen.getByRole('button', { name: 'Rectangle' })
    await user.tab()
    expect(button).toHaveFocus()
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Rectangle')
    expect(tooltip).toHaveTextContent('R')
    expect(button).toHaveAccessibleDescription(/Rectangle/)
  })

  it('exposes the toggle state as aria-pressed only when given', () => {
    renderUi(
      <>
        <IconButton label="Pocket" pressed icon={<Icon name="pocket" />} />
        <IconButton label="Undo" icon={<Icon name="undo" />} />
      </>,
    )
    expect(screen.getByRole('button', { name: 'Pocket', pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo' })).not.toHaveAttribute('aria-pressed')
  })

  it('calls onClick', async () => {
    const onClick = vi.fn()
    const { user } = renderUi(
      <IconButton label="Undo" icon={<Icon name="undo" />} onClick={onClick} />,
    )
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('has no axe violations, tooltip open', async () => {
    const { user } = renderUi(<IconButton label="Fit" shortcut="F" icon={<Icon name="fit" />} />)
    await user.tab()
    await screen.findByRole('tooltip')
    await expectNoAxeViolations()
  })
})
