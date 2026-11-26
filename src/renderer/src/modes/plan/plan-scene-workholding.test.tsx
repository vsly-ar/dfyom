// The plan scene's workholding while something is selected (design review R8, D75;
// docs/conventions/ui.md#workholding): with the setup selected every toe clamp is drawn and
// draggable (X2-6); with an operation selected every item is a ghost and no clamp takes the
// pointer; an open clamp stays drawn and draggable while the others are ghosts. R9: tape is a thin
// layer under the stock. Against the fake bridge bound to a real project runtime.
// Doc: docs/modes/workholding.md#toe-clamp-drag-x2-6
import { act, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { renderUi } from '../../test/render'
import type { RunScene } from '../../viewport'
import { pickableClamps } from '../../viewport/WorkholdingLayer'
import { usePlanScene } from './usePlanScene'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

const probe: { scene: RunScene | null } = { scene: null }
function SceneProbe(): null {
  const scene = usePlanScene('plan')
  useEffect(() => {
    probe.scene = scene
  }, [scene])
  return null
}

const clamp = (edge: string) => ({ kind: 'toeClamp', edge, top: '20' })

describe('plan scene workholding and the selection (R8, R9)', () => {
  it('ghosts every item but the open one while an operation or an item is selected', async () => {
    const s = await planSetup()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const setup = s.plan(planId).setups[0]!
    await s.run('plan.workholding.set', {
      planId,
      setupId: setup.id,
      items: [clamp('vMin'), clamp('vMax'), { kind: 'surface', type: 'tape' }],
    })
    const bridge = createFakeBridge()
    bridge.bind(s.d)
    const shell = createShell(bridge)
    shell.ui.getState().setMode('plan')
    renderUi(
      <ShellProvider shell={shell}>
        <App />
        <SceneProbe />
      </ShellProvider>,
    )
    const select = (id: string | null) => act(() => shell.ui.getState().select('plan', id))
    select(setup.id)
    await waitFor(() => expect(probe.scene?.workholding?.clamps?.handles).toHaveLength(2))
    const wh = () => probe.scene!.workholding!
    // the setup selected: drawn and draggable as before
    expect(wh().ghost).toBeUndefined()
    expect(pickableClamps(wh()).map((h) => h.itemId)).toEqual(['wh1', 'wh2'])
    // R9: the tape under the stock
    expect(wh().surface).toMatchObject({ zMax: expect.any(Number) })
    expect(wh().surface!.zMax - wh().surface!.zMin).toBe(1)
    // an operation selected: every item a ghost, no clamp takes the pointer
    select(setup.operations[0]!.id)
    await waitFor(() => expect(wh().ghost).toBe(true))
    expect(pickableClamps(wh())).toEqual([])
    // the setup again, then a clamp opened (the inspector row or a press on it)
    select(setup.id)
    await waitFor(() => expect(wh().ghost).toBeUndefined())
    act(() => wh().clamps!.onSelect('wh2'))
    await waitFor(() => expect(wh().selected).toBe('wh2'))
    expect(wh().ghost).toBe(true)
    expect(pickableClamps(wh()).map((h) => h.itemId)).toEqual(['wh2'])
  })
})
