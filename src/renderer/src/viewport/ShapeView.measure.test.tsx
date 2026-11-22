// The Shape Editor's measure tool and snap glyph (task U3): M toggles it, two clicks measure
// (snapped to stock corners within the pixel tolerance), the chip shows the distance in project
// units and the live region adds ΔX/ΔY; Esc ends it before leaving the editor.
// Doc: docs/conventions/ui.md#snap-and-measure
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderUi } from '../test/render'
import { fitView, toScreen } from './flat-view'
import { measureBetween } from './MeasureTool'
import { ShapeView, type ShapeViewProps } from './ShapeView'

// jsdom has no layout: the view fits the 100 × 50 stock in the default 800 × 600 px
const view = fitView({ min: [0, 0], max: [100, 50] }, 800, 600)

function setup(over: Partial<ShapeViewProps> = {}) {
  const onExit = vi.fn()
  const props: ShapeViewProps = {
    name: 'Shape 1',
    face: 'Top face',
    drawing: { loops: [], bounds: undefined },
    items: [],
    selected: null,
    segment: null,
    showItems: false,
    onShowItems: () => {},
    isLocked: () => false,
    bad: null,
    units: 'mm',
    onDrag: () => {},
    onExit,
    summary: 'Shape 1.',
    context: {
      placement: { cos: 1, sin: 0, mirror: false, offset: [0, 0] },
      stock: { length: 100, width: 50 },
      axes: ['x', 'y'],
    },
    snap: { grid: 1, on: true, onToggle: () => {} },
    ...over,
  }
  const r = renderUi(<ShapeView {...props} />)
  return { ...r, onExit }
}

/** A click on the measure catcher at screen point `p` (+ an offset in px). */
function clickAt(p: readonly [number, number], dx = 0, dy = 0) {
  const catcher = screen.getByTestId('measure-catcher')
  const at = { clientX: p[0] + dx, clientY: p[1] + dy, button: 0, pointerId: 1 }
  fireEvent.pointerDown(catcher, at)
  fireEvent.pointerUp(catcher, at)
}

describe('measure', () => {
  it('measures between two points in 2D and 3D', () => {
    expect(measureBetween([0, 0], [3, -4])).toEqual({ distance: 5, deltas: [3, -4] })
    expect(measureBetween([1, 1, 1], [1, 3, 1]).distance).toBe(2)
  })

  it('M starts it; two clicks near stock corners snap to them and show the distance', () => {
    const { container } = setup()
    const root = container.querySelector('[data-measuring]') ?? container.firstElementChild!
    fireEvent.keyDown(root, { key: 'm' })
    expect(screen.getByRole('button', { name: /Measure/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Click two points')
    // 3 px off each corner: within the 8 px tolerance, so exactly the corners
    clickAt(toScreen(view, [0, 0]), 3, -2)
    expect(screen.getByRole('status')).toHaveTextContent('second point')
    clickAt(toScreen(view, [100, 50]), -2, 3)
    expect(screen.getByTestId('measure-chip')).toHaveTextContent('111.80 mm')
    expect(screen.getByTestId('measure-dimension')).toBeInTheDocument()
    expect(container).toHaveTextContent('Distance 111.80 mm (ΔX 100.00 mm, ΔY 50.00 mm).')
  })

  it('places freely with Alt held, and in inch projects shows inch', () => {
    const { container } = setup({ units: 'inch' })
    fireEvent.keyDown(container.firstElementChild!, { key: 'M' })
    const catcher = screen.getByTestId('measure-catcher')
    const a = toScreen(view, [0, 0])
    const b = toScreen(view, [25.4, 0])
    for (const p of [a, b]) {
      const at = { clientX: p[0], clientY: p[1], button: 0, pointerId: 1 }
      fireEvent.pointerDown(catcher, at)
      fireEvent.pointerUp(catcher, at)
    }
    expect(screen.getByTestId('measure-chip')).toHaveTextContent('1.000 in')
    // 3 px off the corner: snapped without Alt, free with it
    fireEvent.pointerMove(catcher, { clientX: a[0] + 3, clientY: a[1] })
    expect(screen.getByTestId('snap-glyph')).toBeInTheDocument()
    fireEvent.pointerMove(catcher, { clientX: a[0] + 3, clientY: a[1], altKey: true })
    expect(screen.queryByTestId('snap-glyph')).toBeNull()
  })

  it('shows the snap glyph with its label while hovering a target', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: /Measure/ }))
    const c = toScreen(view, [100, 0])
    fireEvent.pointerMove(screen.getByTestId('measure-catcher'), {
      clientX: c[0] + 2,
      clientY: c[1],
    })
    const glyph = screen.getByTestId('snap-glyph')
    expect(glyph).toHaveAttribute('data-kind', 'corner')
    expect(glyph).toHaveTextContent('Stock corner')
  })

  it('Escape ends the measure first, then leaves the editor', () => {
    const { container, onExit } = setup()
    const root = container.firstElementChild!
    fireEvent.keyDown(root, { key: 'm' })
    fireEvent.keyDown(root, { key: 'Escape' })
    expect(screen.queryByTestId('measure-catcher')).toBeNull()
    expect(onExit).not.toHaveBeenCalled()
    fireEvent.keyDown(root, { key: 'Escape' })
    expect(onExit).toHaveBeenCalledOnce()
  })
})
