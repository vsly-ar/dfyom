import { act, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { InspectorGroup } from './InspectorGroup'
import {
  InspectorMemoryProvider,
  inspectorMemory,
  revealInInspector,
  SESSION_INSPECTOR_MEMORY,
} from './memory'

const field = (label: string) => (
  <label>
    {label}
    <input />
  </label>
)

describe('InspectorGroup', () => {
  it('is a region named by its title with an h3 heading; later groups draw a rule', () => {
    renderUi(
      <div>
        <InspectorGroup title="Shape">{field('Length')}</InspectorGroup>
        <InspectorGroup title="Depth" meta="2 errors">
          {field('Depth')}
        </InspectorGroup>
        <InspectorGroup title="Tool" level={4} heading="Tool · Flat 6">
          {field('Tool')}
        </InspectorGroup>
      </div>,
    )
    const shape = screen.getByRole('region', { name: 'Shape' })
    expect(within(shape).getByRole('heading', { level: 3, name: 'Shape' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Depth' })).toHaveTextContent('2 errors')
    // the name stays the title when the heading shows more
    const tool = screen.getByRole('region', { name: 'Tool' })
    expect(within(tool).getByRole('heading', { level: 4 })).toHaveTextContent('Tool · Flat 6')
  })

  it('an (i) tip describes the group', () => {
    renderUi(
      <InspectorGroup title="Plan copy" info="Follows the design while the plan is a draft.">
        {field('Depth')}
      </InspectorGroup>,
    )
    expect(screen.getByRole('region', { name: 'Plan copy' })).toHaveAccessibleDescription(
      'Follows the design while the plan is a draft.',
    )
    expect(screen.getByTestId('group-info')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('InspectorGroup collapsible (accordion)', () => {
  it('closed: a summary line, the body hidden but mounted; Enter and Space toggle it', async () => {
    const { user } = renderUi(
      <InspectorGroup title="Corners" collapsible summary="r 3 mm · floor 0">
        {field('Corner radius')}
      </InspectorGroup>,
    )
    const toggle = screen.getByRole('button', { name: /^Corners/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('Corners· r 3 mm · floor 0')
    expect(screen.getByLabelText('Corner radius')).not.toBeVisible()
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toHaveAttribute('hidden')
    await user.tab()
    expect(toggle).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Corner radius')).toBeVisible()
    // open: no summary (the fields say it)
    expect(toggle).toHaveTextContent(/^Corners$/)
    await user.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expectNoAxeViolations()
  })

  it('a problem inside shows its severity in the closed header', () => {
    renderUi(
      <InspectorGroup title="Slot" collapsible severity="error">
        {field('Slot width')}
      </InspectorGroup>,
    )
    expect(
      within(screen.getByRole('button', { name: /^Slot/ })).getByRole('img', {
        name: 'has errors',
      }),
    ).toBeInTheDocument()
  })

  it('remembers its open state by key, across mounts (another selection)', async () => {
    const { user, unmount } = renderUi(
      <InspectorGroup title="Defaults" collapsible rememberKey="hole.defaults">
        {field('Head sink')}
      </InspectorGroup>,
    )
    await user.click(screen.getByRole('button', { name: 'Defaults' }))
    expect(SESSION_INSPECTOR_MEMORY.group('hole.defaults')).toBe(true)
    unmount()
    renderUi(
      <InspectorGroup title="Defaults" collapsible rememberKey="hole.defaults">
        {field('Head sink')}
      </InspectorGroup>,
    )
    expect(screen.getByRole('button', { name: 'Defaults' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('keeps its state in the memory it is given (the shell: the app settings)', async () => {
    const groups: Record<string, boolean> = { 'pocket.corners': true }
    const setGroup = vi.fn((key: string, open: boolean) => {
      groups[key] = open
    })
    const memory = inspectorMemory({
      groups: () => ({ ...groups }),
      tabs: () => ({}),
      setGroup,
      setTab: () => {},
      subscribe: () => () => {},
    })
    const { user } = renderUi(
      <InspectorMemoryProvider memory={memory}>
        <InspectorGroup title="Corners" collapsible rememberKey="pocket.corners">
          {field('Corner radius')}
        </InspectorGroup>
      </InspectorMemoryProvider>,
    )
    const toggle = screen.getByRole('button', { name: 'Corners' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(toggle)
    expect(setGroup).toHaveBeenCalledWith('pocket.corners', false)
  })

  it('defaultOpen starts open; forceOpen shows it open while true (Save focuses a field)', () => {
    const { rerender, unmount } = renderUi(
      <InspectorGroup title="Details" collapsible forceOpen>
        {field('Coating')}
      </InspectorGroup>,
    )
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true')
    rerender(
      <InspectorGroup title="Details" collapsible forceOpen={false}>
        {field('Coating')}
      </InspectorGroup>,
    )
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    unmount()
    renderUi(
      <InspectorGroup title="Tabs" collapsible defaultOpen>
        {field('Tab count')}
      </InspectorGroup>,
    )
    expect(screen.getByLabelText('Tab count')).toBeVisible()
  })

  it('opens itself when a field inside is revealed (a message targets it), so it can take focus', () => {
    renderUi(
      <InspectorGroup title="Defaults" collapsible>
        {field('Head sink')}
      </InspectorGroup>,
    )
    const input = screen.getByLabelText('Head sink')
    act(() => revealInInspector(input))
    expect(screen.getByRole('button', { name: 'Defaults' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    input.focus()
    expect(input).toHaveFocus()
  })

  it('controlled: follows open and reports toggles', async () => {
    const onOpenChange = vi.fn()
    const { user } = renderUi(
      <InspectorGroup title="Dowel settings" collapsible open={false} onOpenChange={onOpenChange}>
        {field('Dowel Ø')}
      </InspectorGroup>,
    )
    await user.click(screen.getByText('Dowel settings'))
    expect(onOpenChange).toHaveBeenCalledWith(true)
    // the caller keeps it closed
    expect(screen.getByRole('button', { name: 'Dowel settings' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })
})

describe('InspectorGroup.More', () => {
  it('a quiet button names the rare fields; it expands in place and is remembered', async () => {
    const { user, unmount } = renderUi(
      <InspectorGroup title="Shape">
        {field('Length')}
        <InspectorGroup.More fields={['Anchor', 'Rotation']} rememberKey="pocket.shape.more">
          {field('Rotation')}
        </InspectorGroup.More>
      </InspectorGroup>,
    )
    const more = screen.getByRole('button', { name: 'More (Anchor, Rotation)' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByLabelText('Rotation')).not.toBeVisible()
    more.focus()
    await user.keyboard('{Enter}')
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Rotation')).toBeVisible()
    await expectNoAxeViolations()
    unmount()
    renderUi(
      <InspectorGroup.More fields={['Anchor', 'Rotation']} rememberKey="pocket.shape.more">
        {field('Rotation')}
      </InspectorGroup.More>,
    )
    expect(screen.getByLabelText('Rotation')).toBeVisible()
  })

  it('a revealed field opens it and the accordion around it', () => {
    renderUi(
      <InspectorGroup title="Layout" collapsible>
        <InspectorGroup.More fields={['Origin U']}>{field('Origin U')}</InspectorGroup.More>
      </InspectorGroup>,
    )
    act(() => revealInInspector(screen.getByLabelText('Origin U')))
    expect(screen.getByLabelText('Origin U')).toBeVisible()
  })
})
