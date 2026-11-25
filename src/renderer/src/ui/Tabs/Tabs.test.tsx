import { act, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { revealInInspector } from '../InspectorGroup/memory'
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

// Inspector tabs (DF110, docs/conventions/inspector-layout.md#tabs)
const PLAN_ITEMS = [
  {
    value: 'cut',
    label: 'Cut',
    content: (
      <label>
        Stickout
        <input />
      </label>
    ),
  },
  {
    value: 'feeds',
    label: 'Feeds',
    severity: 'error' as const,
    content: (
      <label>
        Feed rate
        <input />
      </label>
    ),
  },
]

describe('Tabs in an inspector', () => {
  it('keeps inactive panels mounted but hidden (field state survives)', async () => {
    const { user } = renderUi(<Tabs label="Operation" items={PLAN_ITEMS} />)
    const feed = screen.getByLabelText('Feed rate')
    expect(feed).not.toBeVisible()
    await user.click(screen.getByRole('tab', { name: /^Feeds/ }))
    await user.type(feed, '1200')
    await user.click(screen.getByRole('tab', { name: 'Cut' }))
    expect(screen.getByLabelText('Feed rate')).toHaveValue('1200')
    expect(screen.getByLabelText('Feed rate')).not.toBeVisible()
    expect(screen.getByLabelText('Stickout')).toBeVisible()
  })

  it('a tab with a problem shows a dot and says so to screen readers', () => {
    renderUi(<Tabs label="Operation" items={PLAN_ITEMS} />)
    expect(screen.getByRole('tab', { name: 'Feeds, has errors' })).toBeInTheDocument()
  })

  it('remembers the selected tab by key, across mounts', async () => {
    const { user, unmount } = renderUi(
      <Tabs label="Operation" items={PLAN_ITEMS} rememberKey="plan.op" />,
    )
    await user.click(screen.getByRole('tab', { name: /^Feeds/ }))
    unmount()
    renderUi(<Tabs label="Operation" items={PLAN_ITEMS} rememberKey="plan.op" sticky />)
    expect(screen.getByRole('tab', { name: /^Feeds/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tablist')).toHaveAttribute('data-sticky')
  })

  it('a field revealed in a hidden panel selects its tab first', () => {
    renderUi(<Tabs label="Operation" items={PLAN_ITEMS} />)
    act(() => revealInInspector(screen.getByLabelText('Feed rate')))
    expect(screen.getByRole('tab', { name: /^Feeds/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Feed rate')).toBeVisible()
  })
})
