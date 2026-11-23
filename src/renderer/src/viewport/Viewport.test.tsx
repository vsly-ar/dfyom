// WebGL does not run in jsdom: the canvas and the scene are stubbed; the DOM around them
// (region, toolbar, pick banner, keys) is tested here, the scene's logic in the pure modules.
// Doc: docs/conventions/ui.md#testing
import { act, fireEvent, screen, within } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { Vector3 } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations, renderUi } from '../test/render'
import { sampleMesh, SAMPLE_PICK_ELIGIBLE, SAMPLE_STOCK } from './sample-mesh'
import { Viewport } from './Viewport'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']}>{children}</div>
  ),
}))
// camera-controls stand-in: records where view commands send the camera
const controls = vi.hoisted(() => ({
  camera: { aspect: 1, up: null as unknown as { set: (...v: number[]) => void } },
  mouseButtons: { left: 0, middle: 0, right: 0, wheel: 0 },
  distance: 100,
  setLookAt: vi.fn(),
  updateCameraUp: vi.fn(),
  getTarget: (v: { set: (x: number, y: number, z: number) => unknown }) => v.set(0, 0, 0),
  getPosition: (v: { set: (x: number, y: number, z: number) => unknown }) => v.set(100, -100, 100),
}))
vi.mock('./Scene', () => ({
  Scene: ({ controlsRef }: { controlsRef: { current: unknown } }) => {
    controlsRef.current = controls
    return null
  },
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))
vi.mock('./ViewCube', () => ({ ViewCube: () => null }))
// the 3D measure layer raycasts the scene: stubbed, its picks driven through `measurePick`
type Pick = (p: [number, number, number] | null) => void
type OnAxis = (axis: 'x' | 'y' | 'z' | null) => void
const measure = vi.hoisted(() => ({
  pick: null as null | Pick,
  axis: null as null | OnAxis,
}))
vi.mock('./Measure3d', () => ({
  Measure3d: ({ onPick, onAxis }: { onPick: Pick; onAxis: OnAxis }) => {
    measure.pick = onPick
    measure.axis = onAxis
    return <div data-testid="measure-3d" />
  },
}))

const mesh = sampleMesh()

/** Camera position relative to the target of the last view command. */
function lastLook(): [number, number, number] {
  const a = controls.setLookAt.mock.lastCall as number[]
  return [a[0]! - a[3]!, a[1]! - a[4]!, a[2]! - a[5]!]
}

beforeEach(() => {
  controls.setLookAt.mockClear()
  controls.updateCameraUp.mockClear()
  controls.camera.up = new Vector3(0, 0, 1)
})

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

  it('has the view toolbar under the cube: Fit and the Views menu (ui-view-cube.md C1)', () => {
    renderUi(<Viewport mesh={mesh} />)
    const toolbar = screen.getByRole('toolbar', { name: 'View' })
    const names = [...toolbar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['Fit', 'Views', 'Measure'])
    // the summary ends with the current view
    expect(screen.getByRole('region')).toHaveAccessibleDescription(/View: custom\./)
  })

  it('the Views menu offers every view with its shortcut and looks from it', async () => {
    const { user } = renderUi(<Viewport mesh={mesh} stock={SAMPLE_STOCK} />)
    await user.click(screen.getByRole('button', { name: 'Views' }))
    const menu = await screen.findByRole('menu', { name: 'Views' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((i) => i.textContent)).toEqual([
      'Top1',
      'Front2',
      'Right3',
      'Isometric4',
      'BottomShift+1',
      'BackShift+2',
      'LeftShift+3',
    ])
    await expectNoAxeViolations()
    await user.click(within(menu).getByRole('menuitem', { name: /^Back/ }))
    const [x, y, z] = lastLook()
    expect(y).toBeGreaterThan(0)
    expect(Math.abs(x) + Math.abs(z)).toBeLessThan(1e-9)
  })

  it('Shift+1/2/3 look from the bottom, back and left; 1 from the top', () => {
    renderUi(<Viewport mesh={mesh} stock={SAMPLE_STOCK} />)
    const region = screen.getByRole('region')
    fireEvent.keyDown(region, { key: '!', code: 'Digit1', shiftKey: true })
    let [, y, z] = lastLook()
    expect(z).toBeLessThan(0)
    expect(y).toBeLessThan(0) // tilted to the front: −Y up on screen (C3)
    fireEvent.keyDown(region, { key: '#', code: 'Digit3', shiftKey: true })
    expect(lastLook()[0]).toBeLessThan(0)
    fireEvent.keyDown(region, { key: '1', code: 'Digit1' })
    ;[, y, z] = lastLook()
    expect(z).toBeGreaterThan(0)
    expect(y).toBeLessThan(0)
    expect(controls.updateCameraUp).not.toHaveBeenCalled()
  })

  it('in Plan and Run the menu adds the setup view, down the spindle with the rotation', async () => {
    // a right-side setup turned 90°: WCS X along −Z, Y along +Y (horizontal screen up)
    const frame = {
      origin: [100, 0, 0] as const,
      u: [0, 0, -1] as const,
      v: [0, 1, 0] as const,
      n: [1, 0, 0] as const,
    }
    const { user } = renderUi(
      <Viewport
        mesh={mesh}
        stock={SAMPLE_STOCK}
        run={{ lines: null, done: 0, tool: null, frame }}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Views' }))
    const menu = await screen.findByRole('menu', { name: 'Views' })
    await user.click(within(menu).getByRole('menuitem', { name: 'Setup view' }))
    const [x, y, z] = lastLook()
    expect(x).toBeGreaterThan(0)
    expect(Math.abs(y) + Math.abs(z)).toBeLessThan(1e-9)
    expect(controls.updateCameraUp).toHaveBeenCalledTimes(1)
    expect(controls.camera.up).toMatchObject({ x: 0, y: 1, z: 0 })
  })

  it('Escape on the region clears the selection', () => {
    const onSelect = vi.fn()
    renderUi(<Viewport mesh={mesh} selectedOperation="pocket1" onSelect={onSelect} />)
    fireEvent.keyDown(screen.getByRole('region'), { key: 'Escape' })
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('D (Dimension) measures point to point (task U3): banner, live distance; Escape clears, then ends (DF21)', () => {
    const onSelect = vi.fn()
    renderUi(<Viewport mesh={mesh} units="mm" onSelect={onSelect} />)
    const region = screen.getByRole('region')
    fireEvent.keyDown(region, { key: 'd' })
    expect(region).toHaveAttribute('data-measuring')
    expect(screen.getByRole('button', { name: /Measure/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Click two points to measure')
    act(() => measure.pick?.([0, 0, 0]))
    expect(screen.getByRole('status')).toHaveTextContent('Click the second point')
    expect(screen.getByRole('status')).toHaveTextContent('Hold Shift to lock to an axis')
    // Shift locks the line to an axis (DF20): the banner names it
    act(() => measure.axis?.('y'))
    expect(screen.getByRole('status')).toHaveTextContent('Along Y')
    act(() => measure.axis?.(null))
    act(() => measure.pick?.([3, 4, 12]))
    expect(region).toHaveTextContent('Distance 13.00 mm (ΔX 3.00 mm, ΔY 4.00 mm, ΔZ 12.00 mm).')
    expect(screen.getByRole('status')).toHaveTextContent('Click or press Esc to clear')
    // with two points, Escape clears them and keeps the tool (DF21)
    fireEvent.keyDown(region, { key: 'Escape' })
    expect(region).not.toHaveTextContent('Distance 13.00 mm')
    expect(screen.getByTestId('measure-3d')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Click two points to measure')
    // with none, Escape ends the tool
    fireEvent.keyDown(region, { key: 'Escape' })
    expect(screen.queryByTestId('measure-3d')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('with two points set, the next click only clears them, also on empty space (DF21)', () => {
    renderUi(<Viewport mesh={mesh} units="mm" />)
    const region = screen.getByRole('region')
    fireEvent.keyDown(region, { key: 'd' })
    act(() => measure.pick?.([0, 0, 0]))
    act(() => measure.pick?.([3, 4, 0]))
    expect(region).toHaveTextContent('Distance 5.00 mm')
    act(() => measure.pick?.([9, 9, 9]))
    expect(region).not.toHaveTextContent('Distance')
    expect(screen.getByRole('status')).toHaveTextContent('Click two points to measure')
    // a click on nothing with one point keeps it; with two it clears
    act(() => measure.pick?.([0, 0, 0]))
    act(() => measure.pick?.(null))
    expect(screen.getByRole('status')).toHaveTextContent('Click the second point')
    act(() => measure.pick?.([0, 0, 2]))
    act(() => measure.pick?.(null))
    expect(screen.getByRole('status')).toHaveTextContent('Click two points to measure')
  })

  it('a shell-owned measure (DF19): no Measure button here, the prop drives the tool', () => {
    const onMeasuringChange = vi.fn()
    function Host(): React.JSX.Element {
      const [on, setOn] = useState(false)
      return (
        <Viewport
          mesh={mesh}
          measuring={on}
          onMeasuringChange={(next) => {
            onMeasuringChange(next)
            setOn(next)
          }}
        />
      )
    }
    renderUi(<Host />)
    expect(screen.queryByRole('button', { name: /Measure/ })).toBeNull()
    fireEvent.keyDown(screen.getByRole('region'), { key: 'd' })
    expect(onMeasuringChange).toHaveBeenCalledWith(true)
    expect(screen.getByRole('region')).toHaveAttribute('data-measuring')
    fireEvent.keyDown(screen.getByRole('region'), { key: 'Escape' })
    expect(onMeasuringChange).toHaveBeenLastCalledWith(false)
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

  it('announces politely when pick mode ends without a pick (Escape, the toggle again; DF10)', () => {
    const pick = { eligible: SAMPLE_PICK_ELIGIBLE, field: 'Depth' }
    let setPick: (p: typeof pick | null) => void = () => {}
    function Host(): React.JSX.Element {
      const [p, set] = useState<typeof pick | null>(pick)
      setPick = set
      return <Viewport mesh={mesh} pick={p} />
    }
    renderUi(<Host />)
    expect(screen.queryByText('Pick cancelled.')).toBeNull()
    act(() => setPick(null))
    expect(screen.getByText('Pick cancelled.')).toHaveAttribute('aria-live', 'polite')
    // a new pick clears the note, so the next cancel is announced again
    act(() => setPick(pick))
    expect(screen.queryByText('Pick cancelled.')).toBeNull()
  })
})
