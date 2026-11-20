import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Button } from '../Button/Button'
import { ConfirmDialog } from './ConfirmDialog'

const props = {
  title: 'Remove plan “Roughing”?',
  description: 'Its toolpaths and export settings are deleted. This cannot be undone.',
  confirmLabel: 'Remove plan',
}

describe('ConfirmDialog', () => {
  it('is an alert dialog naming the item, with Cancel focused first', async () => {
    const { user } = renderUi(
      <ConfirmDialog {...props} onConfirm={() => {}} trigger={<Button>Remove…</Button>} />,
    )
    await user.click(screen.getByRole('button', { name: 'Remove…' }))
    const dialog = screen.getByRole('alertdialog', { name: props.title })
    expect(dialog).toHaveAccessibleDescription(props.description)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Remove plan' })).toHaveAttribute(
      'data-variant',
      'danger',
    )
  })

  it('confirms only through the named action', async () => {
    const onConfirm = vi.fn()
    const { user } = renderUi(<ConfirmDialog {...props} defaultOpen onConfirm={onConfirm} />)
    await user.keyboard('{Escape}')
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('calls onConfirm and closes', async () => {
    const onConfirm = vi.fn()
    const { user } = renderUi(<ConfirmDialog {...props} defaultOpen onConfirm={onConfirm} />)
    await user.click(screen.getByRole('button', { name: 'Remove plan' }))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('has no axe violations while open', async () => {
    renderUi(<ConfirmDialog {...props} defaultOpen onConfirm={() => {}} />)
    await screen.findByRole('alertdialog')
    await expectNoAxeViolations()
  })
})
