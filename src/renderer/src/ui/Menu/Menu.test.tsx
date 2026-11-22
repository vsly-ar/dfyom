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

  it('groups items under labels; a disabled item with a reason stays focusable and does nothing', async () => {
    const hole = vi.fn()
    const clones = vi.fn()
    const { user } = renderUi(
      <Menu
        items={[
          { group: 'Operations', items: [{ label: 'Add facing', onSelect: () => {} }] },
          {
            group: 'Features',
            items: [
              { label: 'Add hole', onSelect: hole },
              {
                label: 'Make Clones…',
                onSelect: clones,
                disabledReason: 'Select a hole to clone.',
              },
            ],
          },
        ]}
      >
        <Button>Add</Button>
      </Menu>,
    )
    await user.tab()
    await user.keyboard('{Enter}')
    const features = screen.getByRole('group', { name: 'Features' })
    expect(screen.getByRole('group', { name: 'Operations' })).toBeInTheDocument()
    const make = screen.getByRole('menuitem', { name: 'Make Clones…' })
    expect(features).toContainElement(make)
    expect(make).toHaveAttribute('aria-disabled', 'true')
    expect(make).toHaveAccessibleDescription('Select a hole to clone.')
    // reachable by arrows (aria-disabled, not skipped), choosing it keeps the menu open
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(make).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(clones).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await expectNoAxeViolations()
    await user.keyboard('{ArrowUp}{Enter}')
    expect(hole).toHaveBeenCalledOnce()
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
