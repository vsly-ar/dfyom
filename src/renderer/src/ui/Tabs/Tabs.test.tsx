import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Tabs } from './Tabs'

const ITEMS = [
  { value: 'shape', label: 'Shape', content: <p>Shape fields</p> },
  { value: 'depth', label: 'Depth', content: <p>Depth fields</p> },
  { value: 'tabs', label: 'Tabs', content: <p>Tab fields</p>, disabled: true },
] as const

describe('Tabs', () => {
  it('shows the first section in a named tab list', () => {
    renderUi(<Tabs label="Pocket sections" items={ITEMS} />)
    expect(screen.getByRole('tablist', { name: 'Pocket sections' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Shape' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Shape' })).toHaveTextContent('Shape fields')
  })

  it('switches by click and arrow keys, skipping disabled tabs', async () => {
    const onChange = vi.fn()
    const { user } = renderUi(<Tabs label="Sections" items={ITEMS} onValueChange={onChange} />)
    await user.click(screen.getByRole('tab', { name: 'Depth' }))
    expect(onChange).toHaveBeenLastCalledWith('depth')
    expect(screen.getByRole('tabpanel', { name: 'Depth' })).toHaveTextContent('Depth fields')
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'Shape' })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'Depth' })).toHaveAttribute('aria-selected', 'true')
  })

  it('follows a controlled value', () => {
    renderUi(<Tabs label="Sections" items={ITEMS} value="depth" />)
    expect(screen.getByRole('tab', { name: 'Depth' })).toHaveAttribute('aria-selected', 'true')
  })

  it('has no axe violations', async () => {
    renderUi(<Tabs label="Sections" items={ITEMS} />)
    await expectNoAxeViolations()
  })
})
