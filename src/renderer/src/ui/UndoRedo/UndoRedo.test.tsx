import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Toolbar } from '../Toolbar/Toolbar'
import { UndoRedo, type UndoRedoProps } from './UndoRedo'

function renderIn(props: UndoRedoProps) {
  return renderUi(
    <Toolbar label="Main">
      <UndoRedo {...props} />
    </Toolbar>,
  )
}

describe('UndoRedo', () => {
  it('names the step it would undo or redo', async () => {
    const onUndo = vi.fn()
    const onRedo = vi.fn()
    const { user } = renderIn({
      undo: 'Add pocket – by agent',
      redo: 'Remove drilling',
      onUndo,
      onRedo,
      undoShortcut: '⌘Z',
    })
    await user.click(screen.getByRole('button', { name: 'Undo Add pocket – by agent' }))
    expect(onUndo).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Redo Remove drilling' }))
    expect(onRedo).toHaveBeenCalledOnce()
  })

  it('is disabled with nothing to undo or redo', () => {
    renderIn({ undo: null, redo: null, onUndo: vi.fn(), onRedo: vi.fn() })
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled()
  })

  it('has no axe violations', async () => {
    renderIn({ undo: 'Add pocket', redo: null, onUndo: vi.fn(), onRedo: vi.fn() })
    await expectNoAxeViolations()
  })
})
