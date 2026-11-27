// The plan scene's rest shading (hardening DF122, R3's viewport item): a pocket cut after its
// roughing shades what the roughing left while the pocket or its roughing is selected, at the
// pocket's floor; nothing with no selection or the setup selected. The layer draws the rings
// closed at the level. Against the fake bridge bound to a real project runtime.
// Doc: docs/modes/roughing.md#plan-viewport-rest-shading
import { act, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Ok } from '../../../../shared/result'
import { expectOk } from '../../../../shared/testing/result'
import { createInProcessWorkers } from '../../../../core/commands/jobs'
import { uiSource } from '../../../../core/commands/testing'
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
import { len, libraryInput } from '../../../../core/library/library.fixture'
import { flat6, opsOf, planSetup } from '../../../../core/plan/plan.fixture'
import { createToolpathCache } from '../../../../core/toolpath/cache'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { renderUi } from '../../test/render'
import type { RunScene } from '../../viewport'
import { restOutlines } from '../../viewport/RestLayer'
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

// the vendored 2D module read from the repo root (jsdom has no file: import.meta.url, as ZRef.test)
const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: string): Uint8Array } }
  }
).process.getBuiltinModule('node:fs')
const nodeRegion2d = () =>
  loadRegion2dSync(fs.readFileSync('vendor/cavalier-contours/cavalier_contours.wasm')).expect(
    'the vendored 2D module loads',
  )

const probe: { scene: RunScene | null } = { scene: null }
function SceneProbe(): null {
  const scene = usePlanScene('plan')
  useEffect(() => {
    probe.scene = scene
  }, [scene])
  return null
}

describe('plan scene rest shading (DF122)', () => {
  it('shades the rest while the pocket or its roughing is selected', async () => {
    const region2d = nodeRegion2d()
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({
      part: false,
      services: svc,
      stock: {
        name: 'Lid',
        shape: 'block' as const,
        length: '80',
        width: '50',
        thickness: '12',
        material: { name: 'Walnut', class: 'hardwood' as const },
      },
    })
    for (const [name, d] of [
      ['Flat 3', '3'],
      ['Flat 8', '8'],
    ] as const)
      await s.run('library.tool.add', {
        values: libraryInput({ ...flat6(), name, diameter: len(d), fluteLength: len('15') }),
      })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: {
        kind: 'rectangle',
        center: ['40', '25'],
        length: '60',
        width: '40',
        cornerRadius: '1.5',
      },
      depth: '8',
      roughing: true,
    })
    await s.run('project.apply', {})
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, uiSource()))
      .value as { jobId: string }
    expectOk(await s.d.job(jobId).unwrap().result)
    const plan = s.plan(planId)
    const [roughing, pocket] = opsOf(plan)
    expect(pocket!.designOperationIds).toEqual(['pocket1'])

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
    select(pocket!.id)
    await waitFor(() => expect(probe.scene?.rest).toBeDefined())
    const rest = probe.scene!.rest!
    expect(rest.level).toBeCloseTo(-8, 6)
    expect(rest.patch.length).toBeGreaterThan(0)
    // the roughing selected: the same rest
    select(roughing!.id)
    await waitFor(() => expect(probe.scene?.rest).toEqual(rest))
    // the setup selected, or nothing: no shading
    select(plan.setups[0]!.id)
    await waitFor(() => expect(probe.scene?.rest).toBeUndefined())
    select(pocket!.id)
    await waitFor(() => expect(probe.scene?.rest).toBeDefined())
    select(null)
    await waitFor(() => expect(probe.scene?.rest).toBeUndefined())
    // the layer's outline: every ring closed, at the level (lifted)
    const lines = restOutlines(rest.patch, rest.level)
    expect(lines.length).toBe(rest.patch.reduce((n, p) => n + 1 + p.holes.length, 0))
    for (const l of lines) {
      expect(l[0]).toEqual(l[l.length - 1])
      expect(l.every((q) => q[2] === rest.level)).toBe(true)
    }
  })
})
