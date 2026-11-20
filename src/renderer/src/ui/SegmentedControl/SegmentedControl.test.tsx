import { screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { SegmentedControl } from './SegmentedControl'

const OPTIONS = [
  { value: 'climb', label: 'Climb' },
  { value: 'conventional', label: 'Conventional' },
  { value: 'mixed', label: 'Mixed' },
] as const
type Dir = (typeof OPTIONS)[number]['value']

function Controlled({ onChange }: { onChange?: (v: Dir) => void }): React.JSX.Element {
  const [value, setValue] = useState<Dir>('climb')
  return (
    <SegmentedControl
      label="Cut direction"
      options={OPTIONS}
      value={value}
      onValueChange={(v) => {
        setValue(v)
        onChange?.(v)
      }}
    />
  )
}

describe('SegmentedControl', () => {
  it('is a named radio group with the value checked', () => {
    renderUi(<Controlled />)
    expect(screen.getByRole('radiogroup', { name: 'Cut direction' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Climb' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Conventional' })).not.toBeChecked()
  })

  it('selects by click', async () => {
    const onChange = vi.fn()
    const { user } = renderUi(<Controlled onChange={onChange} />)
    await user.click(screen.getByRole('radio', { name: 'Conventional' }))
    expect(onChange).toHaveBeenCalledWith('conventional')
    expect(screen.getByRole('radio', { name: 'Conventional' })).toBeChecked()
  })

  it('is one tab stop; arrow keys move focus (wrapping), Space selects', async () => {
    const { user } = renderUi(<Controlled />)
    await user.tab()
    expect(screen.getByRole('radio', { name: 'Climb' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Conventional' })).toHaveFocus()
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Climb' })).toHaveFocus()
    await user.keyboard('{ArrowLeft} ')
    expect(screen.getByRole('radio', { name: 'Mixed' })).toBeChecked()
    await user.tab()
    expect(document.body).toHaveFocus()
  })

  it('never deselects: clicking the selected option keeps it', async () => {
    const onChange = vi.fn()
    const { user } = renderUi(<Controlled onChange={onChange} />)
    await user.click(screen.getByRole('radio', { name: 'Climb' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: 'Climb' })).toBeChecked()
  })

  it('has no axe violations', async () => {
    renderUi(<Controlled />)
    await expectNoAxeViolations()
  })
})
