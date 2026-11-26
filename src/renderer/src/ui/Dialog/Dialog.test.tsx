import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Button } from '../Button/Button'
import { Dialog, DialogClose } from './Dialog'
import { dialogCollision } from './modal-stack'

describe('Dialog', () => {
  it('opens from its trigger, is named and described, and returns focus when closed', async () => {
    const { user } = renderUi(
      <Dialog
        title="Export gCode"
        description="Writes the plan for GRBL."
        trigger={<Button>Export…</Button>}
        footer={
          <DialogClose>
            <Button>Cancel</Button>
          </DialogClose>
        }
      />,
    )
    const trigger = screen.getByRole('button', { name: 'Export…' })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Export gCode' })
    expect(dialog).toHaveAccessibleDescription('Writes the plan for GRBL.')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('traps focus and closes with Escape', async () => {
    const { user } = renderUi(
      <Dialog title="Tool change" defaultOpen footer={<Button>Continue</Button>}>
        <p>Change to tool 2.</p>
      </Dialog>,
    )
    const cont = screen.getByRole('button', { name: 'Continue' })
    await user.tab()
    expect(cont).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('has no axe violations while open', async () => {
    renderUi(
      <Dialog
        title="Export gCode"
        description="Writes the plan."
        defaultOpen
        footer={<Button>Close</Button>}
      />,
    )
    await screen.findByRole('dialog')
    await expectNoAxeViolations()
  })
})

describe('a context menu in a modal dialog (design review R21)', () => {
  it('is kept above the dialog footer, free up to the window edge elsewhere', () => {
    renderUi(
      <Dialog
        title="Shapes"
        open
        footer={
          <DialogClose>
            <Button>Done</Button>
          </DialogClose>
        }
      >
        <button type="button">Shape 1</button>
      </Dialog>,
    )
    const row = screen.getByRole('button', { name: 'Shape 1' })
    const dialog = screen.getByRole('dialog', { name: 'Shapes' })
    const footer = dialog.querySelector('[data-dialog-footer]')!
    expect(footer).toContainElement(screen.getByRole('button', { name: 'Done' }))
    footer.getBoundingClientRect = () => ({ height: 44 }) as DOMRect
    // a 420 px dialog centred in a 1024 × 768 window: bound below by the footer, elsewhere by the
    // window's edge less 8 px
    dialog.getBoundingClientRect = () =>
      ({ top: 300, left: 302, right: 722, bottom: 480, height: 180, width: 420 }) as DOMRect
    expect(window.innerWidth).toBe(1024)
    expect(dialogCollision(row)).toEqual({
      boundary: dialog,
      padding: { top: -292, right: -294, bottom: 52, left: -294 },
    })
  })

  it('is free outside a modal dialog', () => {
    renderUi(<button type="button">Shape 1</button>)
    expect(dialogCollision(screen.getByRole('button', { name: 'Shape 1' }))).toBeUndefined()
  })
})
