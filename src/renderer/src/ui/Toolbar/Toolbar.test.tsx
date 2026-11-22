import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Icon } from '../icons/Icon'
import { Toolbar, ToolbarButton, ToolbarSeparator } from './Toolbar'

function Tools({ onUndo }: { onUndo?: () => void }): React.JSX.Element {
  return (
    <Toolbar label="Tools">
      <ToolbarButton label="Select" shortcut="V" pressed icon={<Icon name="select" />} />
      <ToolbarButton label="Rectangle" shortcut="R" pressed={false} icon={<Icon name="rect" />} />
      <ToolbarSeparator />
      <ToolbarButton
        label="Undo"
        shortcut="⌘Z"
        icon={<Icon name="undo" />}
        {...(onUndo ? { onClick: onUndo } : {})}
      />
      <ToolbarButton label="Redo" shortcut="⇧⌘Z" disabled icon={<Icon name="redo" />} />
    </Toolbar>
  )
}

describe('Toolbar', () => {
  it('is a named toolbar of named buttons', () => {
    renderUi(<Tools />)
    expect(screen.getByRole('toolbar', { name: 'Tools' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select', pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()
  })

  it('is one tab stop; arrow keys move between buttons and Enter activates', async () => {
    const onUndo = vi.fn()
    const { user } = renderUi(<Tools onUndo={onUndo} />)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Select' })).toHaveFocus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Undo⌘Z')
    await user.keyboard('{Enter}')
    expect(onUndo).toHaveBeenCalledOnce()
    await user.tab()
    expect(document.body).toHaveFocus()
  })

  it('has no axe violations', async () => {
    renderUi(<Tools />)
    await expectNoAxeViolations()
  })
})
