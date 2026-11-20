// WebGL does not run in jsdom: the canvas and the scene are stubbed; the DOM around them
// (region, toolbar, pick banner, keys) is tested here, the scene's logic in the pure modules.
// Doc: docs/conventions/ui.md#testing
import { fireEvent, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../test/render'
import { sampleMesh, SAMPLE_PICK_ELIGIBLE, SAMPLE_STOCK } from './sample-mesh'
import { Viewport } from './Viewport'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('./Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

const mesh = sampleMesh()

describe('Viewport', () => {
  it('is a focusable, labelled region with a text summary and the canvas', async () => {
    renderUi(<Viewport mesh={mesh} stock={SAMPLE_STOCK} />)
    const region = screen.getByRole('region', { name: '3D viewport' })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region).toHaveAccessibleDescription(/Part with 3 operations\./)
    expect(screen.getByTestId('viewport-canvas')).toBeInTheDocument()
    await expectNoAxeViolations()
  })

  it('says when there is nothing yet and when the evaluation failed', () => {
    const { unmount } = renderUi(<Viewport mesh={null} />)
    expect(screen.getByRole('region')).toHaveAccessibleDescription(/Nothing to show yet/)
    unmount()
    renderUi(<Viewport mesh={mesh} status="failed" />)
    expect(screen.getByRole('region')).toHaveAccessibleDescription(/evaluation failed/)
  })

  it('has the view toolbar: Top, Front, Right, Isometric, Fit', () => {
    renderUi(<Viewport mesh={mesh} />)
    const toolbar = screen.getByRole('toolbar', { name: 'View' })
    const names = [...toolbar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['Top', 'Front', 'Right', 'Isometric', 'Fit'])
  })

  it('Escape on the region clears the selection', () => {
    const onSelect = vi.fn()
    renderUi(<Viewport mesh={mesh} selectedOperation="pocket1" onSelect={onSelect} />)
    fireEvent.keyDown(screen.getByRole('region'), { key: 'Escape' })
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('pick mode shows the banner and Escape cancels from anywhere', () => {
    const onPickCancel = vi.fn()
    const onSelect = vi.fn()
    renderUi(
      <Viewport
        mesh={mesh}
        pick={{ eligible: SAMPLE_PICK_ELIGIBLE, field: 'On' }}
        onPickCancel={onPickCancel}
        onSelect={onSelect}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Pick a surface for On · Esc to cancel')
    expect(screen.getByRole('region')).toHaveAttribute('data-picking')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onPickCancel).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })
})
