// Run with an already-cut operation (hardening DF137, TG #454; DF135 C1): the program leaves the
// cut operation out, so Run's scene draws exactly what Plan draws with "Show cut toolpaths" off
// (no toolpath of the cut pocket), the pre-flight's tools, "Resume at" and the guard's tool numbers
// skip it. Against the fake bridge bound to a real project runtime.
// Doc: docs/modes/cut-state.md#run-df137
import { act, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Ok } from '../../../../shared/result'
import { expectOk } from '../../../../shared/testing/result'
import { uiSource } from '../../../../core/commands/testing'
import { createInProcessWorkers } from '../../../../core/commands/jobs'
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
import { createToolpathCache } from '../../../../core/toolpath/cache'
import { loadPlan } from '../../../../core/plan/plan'
import { planSetup } from '../../../../core/plan/plan.fixture'
import type { Toolpath } from '../../../../core/toolpath/model'
import { closedStatus } from '../../../../core/run/service'
import type { CallReply } from '../../../../shared/preload-api'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { renderUi } from '../../test/render'
import { toolpathLines, type RunScene } from '../../viewport'
import { usePlanScene } from '../plan/usePlanScene'
import { planRunInfo, resumePoints } from './plan-info'
import { guardTool } from './run-workholding'
import { useRunScene } from './useRunScene'

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

const probe: { plan: RunScene | null; run: RunScene | null } = { plan: null, run: null }
function SceneProbe(): null {
  const plan = usePlanScene('plan')
  const run = useRunScene('run')
  useEffect(() => {
    probe.plan = plan
    probe.run = run
  }, [plan, run])
  return null
}

const ok = (value: unknown = {}): CallReply => ({ ok: true, value, revision: 0 })

describe('Run with an already-cut operation (DF137)', () => {
  it('draws no toolpath of the cut pocket: the same lines as Plan; tools, resume points and the guard skip it', async () => {
    const region2d = nodeRegion2d()
    const s = await planSetup({
      services: {
        region2d,
        toolpaths: createToolpathCache(),
        workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
      },
    })
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    // feeds for the drills (no calculator data), as the run commands' test
    const ops = s.plan(planId).setups.at(-1)!.operations
    for (const op of ops.filter((o) => o.tool === ops[1]!.tool))
      await s.run('plan.operation.update', {
        planId,
        planOperationId: op.id,
        overrides: { spindleSpeed: '3000', feedRate: '150', plungeRate: '150' },
      })
    // the user marked the pocket already cut in Design; the draft plan follows
    await s.run('design.part.update', { partId: s.partId, alreadyCut: ['pocket1'] })
    await s.run('project.apply', {})
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, uiSource()))
      .value as { jobId: string }
    expectOk(await s.d.job(jobId).unwrap().result)
    const plan = s.plan(planId)
    const setup = plan.setups[0]!
    const pocket = setup.operations.find((o) => o.designOperationIds.includes('pocket1'))!
    const read = (id: string) =>
      (s.query('plan.toolpath.get', { planId, planOperationId: id }) as { toolpath: Toolpath })
        .toolpath
    const all = toolpathLines(setup.operations.map((o) => read(o.id)))
    const pocketOnly = toolpathLines([read(pocket.id)])

    // pure: the run info, "Resume at" and the guard's tool numbers leave the cut pocket out
    const info = planRunInfo(plan)
    expect([...info.cut]).toEqual([pocket.id])
    expect(info.operations).toContain(pocket.id)
    // TG #456: the pre-flight's tool list is the program's tool sequence, the pocket's tool only
    // where an uncut operation uses it
    const nameOf = (id: string | undefined) =>
      (plan.snapshots.find((x) => x.id === id)?.values as { name?: string } | undefined)?.name
    const sequence: string[] = []
    for (const op of setup.operations) {
      const name = nameOf(op.tool)
      if (op.id !== pocket.id && name !== undefined && sequence.at(-1) !== name) sequence.push(name)
    }
    expect(info.tools).toEqual(sequence)
    expect(info.tools[0]).toBe(nameOf(setup.operations.find((o) => o.id !== pocket.id)!.tool))
    const points = resumePoints(plan, undefined)
    expect(points.map((p) => p.planOperationId)).not.toContain(pocket.id)
    // numbered by first use in the program, as its tool changes are
    const numbers = new Map<string, number>()
    for (const p of points) if (!numbers.has(p.toolName)) numbers.set(p.toolName, numbers.size + 1)
    expect(points.map((p) => p.tool)).toEqual(points.map((p) => numbers.get(p.toolName)))
    expect(points[0]!.tool).toBe(1)
    const loaded = loadPlan(s.d.doc, planId, 'test').unwrap()
    const first = setup.operations.find((o) => o.id === points[0]!.planOperationId)!
    expect(guardTool(loaded, setup, 1)?.tool).toBe(loaded.tools.get(first.tool!))

    const bridge = createFakeBridge()
    bridge.bind(s.d)
    bridge.handle('run.status.get', () => ok(closedStatus()))
    const shell = createShell(bridge)
    shell.ui.getState().setMode('plan')
    renderUi(
      <ShellProvider shell={shell}>
        <App />
        <SceneProbe />
      </ShellProvider>,
    )
    // Plan, "Show cut toolpaths" off: the pocket's toolpath is hidden
    await waitFor(() => expect(probe.plan?.lines?.segments).toBeGreaterThan(0))
    const planned = probe.plan!.lines!
    expect(planned.segments).toBeLessThan(all.segments)
    act(() => shell.ui.getState().setMode('run'))
    await waitFor(() => expect(probe.run?.lines?.segments).toBeGreaterThan(0))
    const run = probe.run!.lines!
    // the run scene draws the program's moves: no pocket, exactly Plan's lines
    // (the pocket's segments and at most the one joining it to the next toolpath)
    expect(run.segments).toBeLessThanOrEqual(all.segments - pocketOnly.segments + 1)
    expect(run.segments).toBe(planned.segments)
    expect([...run.positions]).toEqual([...planned.positions])
  })
})
