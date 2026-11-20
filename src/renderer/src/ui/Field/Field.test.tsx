import { screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Checkbox } from '../Checkbox/Checkbox'
import { FieldIcon } from '../icons/field/FieldIcon'
import { Field, type FieldMessage } from './Field'
import { FieldAdjustButton, FieldInput } from './FieldInput'

const soft: FieldMessage = {
  id: 'stepdown.above',
  severity: 'soft',
  text: 'Above the suggested 1.20 mm',
  fix: { label: 'Use 1.20', onApply: () => {} },
}
const note: FieldMessage = { id: 'rec', severity: 'note', text: 'Recommended 0.60–1.20 mm' }
const agent: FieldMessage = { id: 'agent', severity: 'info', text: 'Changed by agent 2 min ago' }

describe('Field', () => {
  it('labels a plain input child and draws the illustration decoratively', () => {
    renderUi(
      <Field label="Depth" illustration={<FieldIcon name="depth" />}>
        <input defaultValue="3.00" />
      </Field>,
    )
    const input = screen.getByRole('textbox', { name: 'Depth' })
    expect(input).toHaveValue('3.00')
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(document.querySelector('svg[data-icon="depth"]')).toHaveAttribute('aria-hidden', 'true')
  })

  it('describes the control by the echo and the status, and marks errors aria-invalid', () => {
    renderUi(
      <Field
        label="Depth"
        echo="= 3.5 mm"
        messages={[{ id: 'parse', severity: 'error', text: 'Two decimal points' }]}
      >
        <FieldInput defaultValue="3..5" unit="mm" />
      </Field>,
    )
    const input = screen.getByRole('textbox', { name: 'Depth' })
    expect(input).toHaveAccessibleDescription('= 3.5 mm Two decimal points')
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('keeps the child’s own aria-describedby', () => {
    renderUi(
      <>
        <p id="hint">From the part</p>
        <Field label="Width" echo="= 1.588 mm">
          <input aria-describedby="hint" />
        </Field>
      </>,
    )
    expect(screen.getByRole('textbox', { name: 'Width' })).toHaveAccessibleDescription(
      'From the part = 1.588 mm',
    )
  })

  it('shows the highest severity first and collapses the rest into "n more"', async () => {
    const { user } = renderUi(
      <Field
        label="Stepdown"
        messages={[
          note,
          { id: 'hard', severity: 'hard', text: 'Smaller than the tool can cut' },
          agent,
        ]}
      >
        <input />
      </Field>,
    )
    expect(screen.getByRole('textbox', { name: 'Stepdown' })).toHaveAccessibleDescription(
      'Smaller than the tool can cut',
    )
    expect(screen.queryByText('Recommended 0.60–1.20 mm')).not.toBeVisible()
    const more = screen.getByRole('button', { name: '2 more' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    await user.click(more)
    expect(screen.getByRole('button', { name: 'Fewer' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Recommended 0.60–1.20 mm')).toBeVisible()
    expect(screen.getByText('Changed by agent 2 min ago')).toBeVisible()
  })

  it('applies a fix with its button', async () => {
    const onApply = vi.fn()
    const { user } = renderUi(
      <Field
        label="Corner R"
        messages={[{ ...soft, severity: 'hard', fix: { label: 'Use 3.00', onApply } }]}
      >
        <input />
      </Field>,
    )
    await user.click(screen.getByRole('button', { name: 'Use 3.00' }))
    expect(onApply).toHaveBeenCalledOnce()
    // hard warnings cannot be dismissed
    expect(screen.queryByRole('button', { name: 'Dismiss warning' })).toBeNull()
  })

  it('dismisses a soft warning to "1 dismissed · Show" and restores it, keeping focus in place', async () => {
    const { user } = renderUi(
      <Field label="Stepdown" messages={[soft, note]}>
        <input />
      </Field>,
    )
    await user.click(screen.getByRole('button', { name: 'Dismiss warning' }))
    expect(screen.queryByText('Above the suggested 1.20 mm')).toBeNull()
    const show = screen.getByRole('button', { name: '1 dismissed · Show' })
    expect(show).toHaveFocus()
    // the next message moves up; the control is now described by it
    expect(screen.getByRole('textbox', { name: 'Stepdown' })).toHaveAccessibleDescription(
      'Recommended 0.60–1.20 mm',
    )
    await user.click(show)
    expect(screen.getByText('Above the suggested 1.20 mm')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Dismiss warning' })).toHaveFocus()
    expect(screen.queryByRole('button', { name: /dismissed/ })).toBeNull()
  })

  it('toggles the lock (aria-pressed)', async () => {
    function Locked(): React.JSX.Element {
      const [locked, setLocked] = useState(false)
      return (
        <Field label="Feed" lock={{ locked, onLockedChange: setLocked }}>
          <input />
        </Field>
      )
    }
    const { user } = renderUi(<Locked />)
    const lock = screen.getByRole('button', { name: 'Lock value' })
    expect(lock).toHaveAttribute('aria-pressed', 'false')
    await user.click(lock)
    expect(lock).toHaveAttribute('aria-pressed', 'true')
  })

  it('passes readOnly to a value control', () => {
    renderUi(
      <Field
        label="Feed"
        readOnly
        messages={[{ id: 'ro', severity: 'note', text: 'Finalized plans are read-only' }]}
      >
        <FieldInput defaultValue="900" unit="mm/min" />
      </Field>,
    )
    expect(screen.getByRole('textbox', { name: 'Feed' })).toHaveAttribute('readonly')
  })

  it('names the pencil inside the input', () => {
    renderUi(
      <Field label="Width">
        <FieldInput defaultValue="12.00" adjust={<FieldAdjustButton label="Adjust Width" fix />} />
      </Field>,
    )
    expect(screen.getByRole('button', { name: 'Adjust Width' })).toHaveAttribute('data-fix')
  })

  it('has no axe violations in its states', async () => {
    renderUi(
      <div>
        <Field
          label="Stepdown"
          illustration={<FieldIcon name="stepdown" />}
          lock={{ locked: false, onLockedChange: () => {} }}
          messages={[soft, note, agent]}
        >
          <FieldInput
            defaultValue="1.50"
            unit="mm"
            adjust={<FieldAdjustButton label="Adjust Stepdown" fix />}
          />
        </Field>
        <Field
          label="Depth"
          messages={[{ id: 'e', severity: 'error', text: 'Two decimal points' }]}
        >
          <FieldInput defaultValue="3..5" unit="mm" />
        </Field>
        <Field label="Tabs" kind="toggle" illustration={<FieldIcon name="tabs" />}>
          <Checkbox label="Leave 4 tabs" defaultChecked />
        </Field>
      </div>,
    )
    await expectNoAxeViolations()
  })
})
