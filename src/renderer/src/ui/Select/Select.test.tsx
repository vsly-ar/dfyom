import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Field } from '../Field/Field'
import { Select } from './Select'

const TOOLS = [
  { value: 't1', label: 'T1 · Ø6 flat end mill 2F' },
  { value: 't2', label: 'T2 · Ø3 drill' },
] as const

describe('Select', () => {
  it('is a combobox labelled by its Field and shows the value', () => {
    renderUi(
      <Field label="Tool">
        <Select options={TOOLS} defaultValue="t1" />
      </Field>,
    )
    const combo = screen.getByRole('combobox', { name: 'Tool' })
    expect(combo).toHaveTextContent('T1 · Ø6 flat end mill 2F')
  })

  it('chooses an option by keyboard', async () => {
    const onChange = vi.fn()
    const { user } = renderUi(
      <Select aria-label="Tool" options={TOOLS} defaultValue="t1" onValueChange={onChange} />,
    )
    await user.tab()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledWith('t2')
    expect(screen.getByRole('combobox', { name: 'Tool' })).toHaveTextContent('T2 · Ø3 drill')
  })

  it('has no axe violations', async () => {
    renderUi(<Select aria-label="Strategy" options={TOOLS} placeholder="Choose…" />)
    await expectNoAxeViolations()
  })
})
