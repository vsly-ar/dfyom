// QuantityInput inside a modal Dialog (design review R20): the dialog's focus trap sends the focus
// back to the field when it leaves the dialog, and that return must not open the adjust panel
// again (it reopened on every blur, and e2e had to Tab out of the field instead of clicking on).
// Doc: docs/conventions/ui.md#field (adjust panel)
import { act, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { quantityFromSource } from '../../../../core/expression/quantity'
import type { Quantity } from '../../../../core/quantity/quantity'
import { None } from '../../../../shared/result'
import { renderUi } from '../../test/render'
import { Dialog } from '../Dialog/Dialog'
import { QuantityInput } from './QuantityInput'

const q = (source: string): Quantity =>
  quantityFromSource(
    source,
    { kind: 'length', defaultUnit: 'mm' },
    { resolve: () => None },
  ).unwrap()

function Host(): React.JSX.Element {
  const [value, setValue] = useState<Quantity>(q('3'))
  return (
    <>
      <button type="button">Outside</button>
      <Dialog title="Offset Shape 1" description="A new shape at this distance." open>
        <QuantityInput
          label="Distance"
          kind="length"
          defaultUnit="mm"
          stepKind="xy"
          value={value}
          onCommit={setValue}
        />
        <button type="button">Inward</button>
      </Dialog>
    </>
  )
}

const panel = () => screen.queryByRole('dialog', { name: 'Adjust Distance' })

describe('QuantityInput in a modal dialog (R20)', () => {
  it('a focus the trap brings back does not reopen the adjust panel; a click on the field does', async () => {
    const { user } = renderUi(<Host />)
    const input = screen.getByRole('combobox', { name: 'Distance' })
    await user.click(input)
    expect(panel()).not.toBeNull()
    // the focus leaves the dialog (a click on the window's frame, another layer): the trap
    // returns it to the field at once
    act(() => screen.getByRole('button', { name: 'Outside', hidden: true }).focus())
    expect(input).toHaveFocus()
    await waitFor(() => expect(panel()).toBeNull())
    // the field's own click opens it again
    await user.click(input)
    expect(panel()).not.toBeNull()
  })

  it('a blur with no target that comes straight back (the trap) leaves the panel closed', async () => {
    const { user } = renderUi(<Host />)
    const input = screen.getByRole('combobox', { name: 'Distance' })
    await user.click(input)
    expect(panel()).not.toBeNull()
    act(() => {
      input.blur()
      input.focus()
    })
    expect(input).toHaveFocus()
    expect(panel()).toBeNull()
  })

  it('Tab to another control in the dialog and back opens it as before', async () => {
    const { user } = renderUi(<Host />)
    const input = screen.getByRole('combobox', { name: 'Distance' })
    await user.click(input)
    await user.keyboard('{Escape}')
    expect(panel()).toBeNull()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Inward' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(input).toHaveFocus()
    expect(panel()).not.toBeNull()
  })
})
