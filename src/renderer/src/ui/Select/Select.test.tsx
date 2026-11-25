import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { cssRule } from '../../test/css'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Field } from '../Field/Field'
import { groupOptions, Select } from './Select'

const TOOLS = [
  { value: 't1', label: 'T1 · Ø6 flat end mill 2F' },
  { value: 't2', label: 'T2 · Ø3 drill' },
] as const

describe('Select', () => {
  it('starts an option with a picture at the list edge, never centred (DF100)', () => {
    const css = 'src/renderer/src/ui/Select/Select.module.css'
    // a described option centres its column vertically; with a picture the row turns, so the row
    // must say where it starts
    expect(cssRule(css, '.item[data-described]')).toMatchObject({ 'justify-content': 'center' })
    expect(cssRule(css, '.item[data-icon]')).toMatchObject({
      'flex-direction': 'row',
      'justify-content': 'flex-start',
    })
  })

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

  it('lists options in labelled groups, in order of first use', async () => {
    const options = [
      { value: 'stock.top', label: 'Stock top', group: 'Top' },
      { value: 'stock.side[1]', label: 'Stock right', group: 'Right side' },
      { value: 'pocket1.floor', label: 'Pocket 1 floor', group: 'Top' },
    ]
    expect(groupOptions(options).map((g) => [g.group, g.options.map((o) => o.value)])).toEqual([
      ['Top', ['stock.top', 'pocket1.floor']],
      ['Right side', ['stock.side[1]']],
    ])
    const { user } = renderUi(<Select aria-label="On" options={options} defaultValue="stock.top" />)
    await user.tab()
    await user.keyboard('{Enter}')
    const list = await screen.findByRole('listbox')
    const groups = within(list).getAllByRole('group')
    expect(
      groups.map((g) =>
        within(g)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ),
    ).toEqual([['Stock top', 'Pocket 1 floor'], ['Stock right']])
    expect(within(groups[1]!).getByText('Right side')).toBeInTheDocument()
    await expectNoAxeViolations()
  })

  it('shows an option description in the list only, as its accessible description', async () => {
    const options = [
      { value: 'g', label: '6 mm flat end mill' },
      { value: 't1', label: 'Flat 6 · Ø 6 mm', description: 'Preset for aluminum · largest' },
    ]
    const { user } = renderUi(
      <Select aria-label="Tool" options={options} defaultValue="t1" muted />,
    )
    const combo = screen.getByRole('combobox', { name: 'Tool' })
    expect(combo).toHaveTextContent(/^Flat 6 · Ø 6 mm$/)
    expect(combo).toHaveAttribute('data-muted')
    await user.tab()
    await user.keyboard('{Enter}')
    const option = await screen.findByRole('option', { name: 'Flat 6 · Ø 6 mm' })
    expect(option).toHaveAccessibleDescription('Preset for aluminum · largest')
    await expectNoAxeViolations()
  })

  it('has no axe violations', async () => {
    renderUi(<Select aria-label="Strategy" options={TOOLS} placeholder="Choose…" />)
    await expectNoAxeViolations()
  })
})
