import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Button } from '../Button/Button'
import { Menu } from './Menu'

describe('Menu', () => {
  it('opens from its trigger by keyboard, moves with arrows and runs the chosen item', async () => {
    const duplicate = vi.fn()
    const rename = vi.fn()
    const { user } = renderUi(
      <Menu
        items={[
          { label: 'Duplicate', shortcut: '⌘D', onSelect: duplicate },
          { label: 'Rename', shortcut: 'F2', onSelect: rename },
          'separator',
          { label: 'Remove', shortcut: '⌫', danger: true, onSelect: () => {} },
        ]}
      >
        <Button>Actions</Button>
      </Menu>,
    )
    await user.tab()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Duplicate⌘D',
      'RenameF2',
      'Remove⌫',
    ])
    await user.keyboard('{ArrowDown}{Enter}')
    expect(rename).toHaveBeenCalledOnce()
    expect(duplicate).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveFocus()
  })

  it('has no axe violations while open', async () => {
    renderUi(
      <Menu defaultOpen items={[{ label: 'Rename', onSelect: () => {} }]}>
        <Button>Actions</Button>
      </Menu>,
    )
    await screen.findByRole('menu')
    await expectNoAxeViolations()
  })
})
