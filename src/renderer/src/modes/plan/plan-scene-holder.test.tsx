// The plan scene's holder ghost (hardening DF132 H5) against the fake bridge bound to a real
// project runtime: tool-holder.md's user case (a 25 mm toe clamp 9 mm from a 6 mm deep pocket, an
// ER11 holder). With the tool's 25 mm stickout the ghost stands at the holder collision's first
// hit, colliding; with the 36 mm the read-out names, at the stickout reason's move, neutral. None
// with nothing or the setup selected, and none on a machine without a holder; H6: a tool's own
// holder draws its nut on a machine without one.
// Doc: docs/modes/tool-holder.md#implementation-h5
import { act, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Ok } from '../../../../shared/result'
import { expectOk } from '../../../../shared/testing/result'
import { createInProcessWorkers } from '../../../../core/commands/jobs'
import { uiSource } from '../../../../core/commands/testing'
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
import { libraryInput, machineValues } from '../../../../core/library/library.fixture'
import { flat6, planSetup } from '../../../../core/plan/plan.fixture'
import { createToolpathCache } from '../../../../core/toolpath/cache'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { renderUi } from '../../test/render'
import type { RunScene } from '../../viewport'
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

/** A 25 mm tall toe clamp on the left edge: pad X−18–10, Y36–64 (holder-case.test.ts). */
const CLAMP = {
  kind: 'toeClamp',
  edge: 'uMin',
  at: '50',
  width: '28',
  grip: '10',
  reach: '18',
  top: '25',
}

async function holderScene(holder: object | undefined, toolHolder?: object) {
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
      name: 'Hardwood',
      shape: 'block' as const,
      length: '250',
      width: '100',
      thickness: '40',
      material: { name: 'Oak', class: 'hardwood' as const },
    },
  })
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: {
      kind: 'rectangle',
      center: ['35', '50'],
      length: '38',
      width: '40',
      cornerRadius: '4',
    },
    depth: '6',
    floorRadius: '0',
  })
  await s.run('project.apply', {})
  const { kind: _, ...m } = machineValues()
  const machineId =
    holder === undefined
      ? s.machineId
      : (
          (await s.run('library.machine.add', {
            values: { ...libraryInput({ ...m, name: 'Shapeoko ER11' }), holder },
          })) as { id: string }
        ).id
  const planId = await s.create({ machineLibraryItemId: machineId })
  const setup = s.plan(planId).setups[0]!
  const op = setup.operations[0]!
  // DF132 H6: the Flat 6 with its own holder (the override)
  const toolId =
    toolHolder === undefined
      ? s.tools.flat6
      : (
          (await s.run('library.tool.add', {
            values: {
              ...libraryInput({ ...flat6(), name: 'Flat 6, own holder' }),
              holder: toolHolder,
            },
          })) as { id: string }
        ).id
  await s.run('plan.tool.assign', { planId, planOperationId: op.id, toolLibraryItemId: toolId })
  await s.run('plan.workholding.set', { planId, setupId: setup.id, items: [CLAMP] })
  const generate = async () => {
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, uiSource()))
      .value as { jobId: string }
    expectOk(await s.d.job(jobId).unwrap().result)
  }
  await generate()
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
  return { s, planId, setupId: setup.id, opId: op.id, select, generate }
}

describe('plan scene holder ghost (DF132 H5)', () => {
  it('at the holder collision, red; at the reason move once the stickout clears it', async () => {
    const { s, planId, setupId, opId, select, generate } = await holderScene({ preset: 'er11' })
    select(opId)
    await waitFor(() => expect(probe.scene?.holder).toBeDefined())
    const hit = probe.scene!.holder!
    expect(hit.colliding).toBe(true)
    // the tip at the collision's first hit beside the clamp, the nut 25 mm above it
    expect(hit.tip[2]).toBeLessThan(0)
    expect(hit.parts.map((p) => [p.part, p.radius, p.zFrom])).toEqual([
      ['tool', 3, 0],
      ['nut', 9.5, 25],
      ['body', 26, 37],
    ])
    expect(hit.label).toBe('Stickout 25 mm · needs 36 mm')
    // the setup selected, or nothing: no ghost
    select(setupId)
    await waitFor(() => expect(probe.scene?.holder).toBeUndefined())
    select(null)
    await waitFor(() => expect(probe.scene?.holder).toBeUndefined())

    await act(async () => {
      await s.run('plan.operation.update', { planId, planOperationId: opId, stickout: '36' })
      await generate()
    })
    select(opId)
    await waitFor(() => expect(probe.scene?.holder?.label).toBe('Stickout 36 mm · needs 36 mm'))
    const clear = probe.scene!.holder!
    expect(clear.colliding).toBe(false)
    // the reason's move: the deepest stepdown beside the clamp (25 + 6 + 5 = 36)
    expect(clear.tip[2]).toBeCloseTo(-6, 6)
    expect(clear.tip[0]).toBeGreaterThan(10)
    expect(clear.parts[1]).toEqual({ part: 'nut', radius: 9.5, zFrom: 36, zTo: 48 })
  })

  it("a tool's own holder (H6): the ghost on a machine without one, with the tool's nut", async () => {
    const { opId, select } = await holderScene(undefined, { preset: 'er16' })
    select(opId)
    await waitFor(() => expect(probe.scene?.holder).toBeDefined())
    const ghost = probe.scene!.holder!
    expect(ghost.colliding).toBe(true)
    expect(ghost.parts.map((p) => [p.part, p.radius, p.zFrom])).toEqual([
      ['tool', 3, 0],
      ['nut', 16, 25],
      ['body', 32.5, 43],
    ])
  })

  it('none on a machine without a holder', async () => {
    const { opId, select } = await holderScene(undefined)
    select(opId)
    await waitFor(() => expect(probe.scene?.workholding).toBeDefined())
    expect(probe.scene?.holder).toBeUndefined()
  })
})
