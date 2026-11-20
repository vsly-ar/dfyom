import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Button } from '../Button/Button'
import { Dialog, DialogClose } from './Dialog'

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
