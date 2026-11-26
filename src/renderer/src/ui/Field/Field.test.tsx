import { Icon } from '../icons/Icon'
import { screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Checkbox } from '../Checkbox/Checkbox'
import { FieldIcon } from '../icons/field/FieldIcon'
import { Field, type FieldMessage } from './Field'
import { FieldInput } from './FieldInput'

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

  it('shows the highest severity first, two in full, and collapses from the third (R19)', async () => {
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
      'Smaller than the tool can cut Changed by agent 2 min ago',
    )
    expect(screen.getByText('Changed by agent 2 min ago')).toBeVisible()
    expect(screen.queryByText('Recommended 0.60–1.20 mm')).not.toBeVisible()
    const more = screen.getByRole('button', { name: '1 more' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    await user.click(more)
    expect(screen.getByRole('button', { name: 'Fewer' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Recommended 0.60–1.20 mm')).toBeVisible()
  })

  it('shows two messages in full, without a disclosure (R19)', () => {
    renderUi(
      <Field
        label="Stepdown"
        messages={[{ id: 'hard', severity: 'error', text: 'Must be greater than 0' }, note]}
      >
        <input />
      </Field>,
    )
    expect(screen.getByText('Must be greater than 0')).toBeVisible()
    expect(screen.getByText('Recommended 0.60–1.20 mm')).toBeVisible()
    expect(screen.queryByRole('button', { name: /more$/ })).toBeNull()
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

  it('shows an alternative action after the fix (DF42)', async () => {
    const fix = vi.fn()
    const other = vi.fn()
    const { user } = renderUi(
      <Field
        label="Tool"
        messages={[
          {
            id: 'dfm.toolNotInLibrary',
            severity: 'info',
            text: 'Plan needs a 6 mm flat end mill: add one to the library.',
            fix: { label: 'Use Flat 6.22 (6.22 mm)', onApply: fix },
            alternative: { label: 'Add to library', onApply: other, icon: <Icon name="add" /> },
          },
        ]}
      >
        <input />
      </Field>,
    )
    const buttons = screen.getAllByRole('button').map((b) => b.textContent)
    expect(buttons).toEqual(['Use Flat 6.22 (6.22 mm)', 'Add to library'])
    await user.click(screen.getByRole('button', { name: 'Add to library' }))
    expect(other).toHaveBeenCalledOnce()
    expect(fix).not.toHaveBeenCalled()
    await expectNoAxeViolations()
  })

  it('draws a check on a warning’s fix unless the fix brings its own icon', () => {
    renderUi(
      <>
        <Field label="Corner R" messages={[soft]}>
          <input />
        </Field>
        <Field
          label="Tool"
          messages={[
            {
              ...soft,
              fix: { label: 'Add to library', onApply: () => {}, icon: <Icon name="add" /> },
            },
          ]}
        >
          <input />
        </Field>
      </>,
    )
    const icon = (name: string) => screen.getByRole('button', { name }).querySelector('svg')
    expect(icon('Use 1.20')).toHaveAttribute('data-icon', 'check')
    expect(icon('Add to library')).toHaveAttribute('data-icon', 'add')
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

  it('toggles the lock (aria-pressed) under a constant name', async () => {
    function Locked(): React.JSX.Element {
      const [locked, setLocked] = useState(false)
      return (
        <Field label="Feed" lock={{ locked, onLockedChange: setLocked }}>
          <input />
        </Field>
      )
    }
    const { user } = renderUi(<Locked />)
    const lock = screen.getByRole('button', { name: 'Lock Feed' })
    expect(lock).toHaveAttribute('aria-pressed', 'false')
    await user.click(lock)
    expect(screen.getByRole('button', { name: 'Lock Feed' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('hides the lock without the lock prop', () => {
    renderUi(
      <Field label="Corner R">
        <input />
      </Field>,
    )
    expect(screen.queryByRole('button', { name: /lock/i })).toBeNull()
  })

  it('a lock with a disabled reason is aria-disabled, focusable, and shows the reason', async () => {
    const onLockedChange = vi.fn()
    const reason = "24000 rpm is above this machine's 18000 rpm."
    const { user } = renderUi(
      <Field label="Spindle speed" lock={{ locked: false, onLockedChange, disabledReason: reason }}>
        <input />
      </Field>,
    )
    const lock = screen.getByRole('button', { name: 'Lock Spindle speed' })
    expect(lock).toHaveAttribute('aria-disabled', 'true')
    expect(lock).not.toBeDisabled()
    expect(lock).toHaveAccessibleDescription(reason)
    expect(screen.getByText(reason)).toBeVisible()
    await user.tab() // the lock comes before the input
    expect(lock).toHaveFocus()
    await user.click(lock)
    await user.keyboard('{Enter}')
    expect(onLockedChange).not.toHaveBeenCalled()
    await expectNoAxeViolations()
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

  it('draws nothing but the text and unit in the input box (no pencil since DF9)', () => {
    renderUi(
      <Field label="Width">
        <FieldInput defaultValue="12.00" unit="mm" />
      </Field>,
    )
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders a popup after the support area', () => {
    renderUi(
      <Field
        label="Width"
        messages={[note]}
        popup={<div role="dialog" aria-label="Adjust Width" />}
      >
        <FieldInput defaultValue="12.00" />
      </Field>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Adjust Width' })
    expect(dialog.previousElementSibling).toHaveTextContent(String(note.text))
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
          <FieldInput defaultValue="1.50" unit="mm" />
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

// docs/conventions/inspector-layout.md#info-tips-df105
describe('Field: (i) info tip and provenance tag', () => {
  const INFO = 'Measured from the stock top.'
  const tip = () => screen.queryByRole('tooltip')

  function setup() {
    return renderUi(
      <div>
        <input aria-label="Before" />
        <Field label="Depth" info={INFO} tag={{ text: 'Preset', title: 'From preset “Ply”.' }}>
          <FieldInput defaultValue="3.00" unit="mm" />
        </Field>
      </div>,
    )
  }

  it('puts the info and the provenance in the description, not under the field', async () => {
    setup()
    const input = screen.getByRole('textbox', { name: 'Depth' })
    expect(input).toHaveAccessibleDescription(`${INFO} From preset “Ply”.`)
    expect(screen.getByText(INFO)).not.toBeVisible()
    expect(document.querySelector('[data-text="Preset"]')).toBeInTheDocument()
    await expectNoAxeViolations()
  })

  it('opens the tip on keyboard focus only, and closes it when typing starts', async () => {
    const { user } = setup()
    const input = screen.getByRole('textbox', { name: 'Depth' })
    await user.click(input)
    expect(tip()).toBeNull()
    await user.click(screen.getByRole('textbox', { name: 'Before' }))
    await user.tab()
    expect(input).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(INFO)
    await user.keyboard('4')
    await waitFor(() => expect(tip()).toBeNull())
  })

  it('a press on (i) neither focuses the control nor is a Tab stop', async () => {
    const { user } = setup()
    const input = screen.getByRole('textbox', { name: 'Depth' })
    await user.click(screen.getByTestId('field-info'))
    expect(input).not.toHaveFocus()
    await user.click(screen.getByRole('textbox', { name: 'Before' }))
    await user.tab()
    expect(input).toHaveFocus()
  })

  it('shows the tip on hover of (i)', async () => {
    const { user } = setup()
    await user.hover(screen.getByTestId('field-info'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(INFO)
  })
})
