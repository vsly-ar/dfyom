import { act, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { Panel, PanelGroup, PanelHeader, PanelResizeHandle, usePanelRef } from './Panel'

function Shell({
  onCollapsedChange,
  handleRef,
}: {
  onCollapsedChange?: (c: boolean) => void
  handleRef?: (h: ReturnType<typeof usePanelRef>) => void
}): React.JSX.Element {
  const ref = usePanelRef()
  handleRef?.(ref)
  return (
    <PanelGroup id="test">
      <Panel
        id="left"
        defaultSize="25"
        minSize="10"
        collapsible
        panelRef={ref}
        {...(onCollapsedChange ? { onCollapsedChange } : {})}
      >
        <nav aria-label="Navigator">
          <PanelHeader title="Operations" meta="5" />
        </nav>
      </Panel>
      <PanelResizeHandle label="Resize navigator" />
      <Panel id="centre">
        <main aria-label="Viewport">scene</main>
      </Panel>
    </PanelGroup>
  )
}

describe('Panel', () => {
  it('lays out regions with a named, focusable resize handle', () => {
    renderUi(<Shell />)
    expect(screen.getByRole('navigation', { name: 'Navigator' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Operations', level: 2 })).toBeInTheDocument()
    const handle = screen.getByRole('separator', { name: 'Resize navigator' })
    expect(handle).toHaveAttribute('tabindex', '0')
  })

  it('collapses and expands through its handle and reports it', () => {
    const onCollapsedChange = vi.fn()
    let ref: ReturnType<typeof usePanelRef> | undefined
    renderUi(<Shell onCollapsedChange={onCollapsedChange} handleRef={(r) => (ref = r)} />)
    act(() => ref?.current?.collapse())
    expect(ref?.current?.isCollapsed()).toBe(true)
    act(() => ref?.current?.expand())
    expect(ref?.current?.isCollapsed()).toBe(false)
  })

  it('has no axe violations', async () => {
    renderUi(<Shell />)
    await expectNoAxeViolations()
  })
})
