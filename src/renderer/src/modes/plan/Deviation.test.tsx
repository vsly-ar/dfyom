// The deviation panel (v0.4-llm-first U4) in the Plan inspector without a selection, against the
// fake bridge bound to a real project runtime (the core plan fixture, with a reference imported
// into an in-memory asset store); the comparison job itself (`design.reference.compare`,
// `job.get`, `job.abort`) is answered by the test: no reference, the run with its progress and
// Cancel, the statistics and regions with causes, a region selecting its plan operation, the
// outdated note after an edit, the "within" state; a chosen region marked in the Plan viewport
// (its box in the part frame, the sign) and cleared when the result goes outdated.
// Doc: docs/conventions/ui.md#deviation-panel, docs/modes/deviation.md#implementation-u4,
// docs/modes/deviation.md#region-marker-u4-follow-up
import { act, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createInProcessWorkers, memoryFiles } from '../../../../core/commands/jobs'
import { binaryStl, boxSoup } from '../../../../core/design/stl.testing'
import { loadRegion2dSync } from '../../../../core/geometry/2d/cavalier'
import { planSetup } from '../../../../core/plan/plan.fixture'
import { assetPathOf, type AssetRef } from '../../../../core/project/assets'
import type { ProjectSession } from '../../../../core/project/storage'
import { Ok } from '../../../../shared/result'
import type { CallReply } from '../../../../shared/preload-api'
import { App } from '../../App'
import { createShell, ShellProvider } from '../../shell/ShellContext'
import { createFakeBridge } from '../../test/bridge'
import { expectNoAxeViolations, renderUi } from '../../test/render'
import { planStockSize } from './model'
import type { DeviationResultView } from './plan-store'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children: _c, ...rest }: { children: ReactNode; 'data-testid'?: string }) => (
    <div data-testid={rest['data-testid']} />
  ),
}))
// the Viewport's props, to read the plan scene's region marker and framing request (U4 follow-up)
const scene = vi.hoisted(() => ({ last: {} as Record<string, unknown> }))
vi.mock('../../viewport/Viewport', async (original) => ({
  ...(await original<object>()),
  Viewport: (p: Record<string, unknown>) => {
    scene.last = p
    return null
  },
}))
vi.mock('../../viewport/Scene', () => ({
  Scene: () => null,
  CameraControlsImpl: { ACTION: { NONE: 0, ROTATE: 1, TRUCK: 2, DOLLY: 16 } },
}))

const fs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(p: string): Uint8Array } }
  }
).process.getBuiltinModule('node:fs')
const nodeRegion2d = () =>
  loadRegion2dSync(fs.readFileSync('vendor/cavalier-contours/cavalier_contours.wasm')).expect(
    'the vendored 2D module loads',
  )

const ok = (value: unknown = {}): CallReply => ({ ok: true, value, revision: 0 })

/** A session that copies a box STL into an in-memory work folder (asset store). */
function fakeProject() {
  const files = new Map<string, Uint8Array>()
  const session = {
    importAsset() {
      const sha256 = '1'.padStart(64, '0')
      const path = assetPathOf(sha256, 'stl')
      const bytes = binaryStl(boxSoup(20, 10, 5))
      files.set(`/work/${path}`, bytes)
      return Promise.resolve(Ok({ path, sha256, size: bytes.length } satisfies AssetRef))
    },
    assetFile: (path: string) => Ok(`/work/${path}`),
  } as unknown as ProjectSession
  return { session, workers: createInProcessWorkers({ files: memoryFiles(files) }) }
}

const stats = (max: number) => ({
  cells: 1000,
  mean: 0.012,
  p50: 0.001,
  p95: 0.005,
  p99: 0.04,
  max,
  overcutMax: max,
  undercutMax: 0.3,
  areaOver: 140,
})

function resultOf(planId: string, ops: readonly string[]): DeviationResultView {
  return {
    source: 'plan',
    method: 'heightmap',
    cell: 0.5,
    threshold: 0.1,
    stats: stats(0.8),
    faces: [
      { face: 'stock.top', ...stats(0.8) },
      { face: 'stock.bottom', ...stats(0.3) },
    ],
    excluded: { outsidePart: 20, edgeBand: 12.5 },
    regions: [
      {
        face: 'stock.top',
        bounds: [
          [0, 0],
          [10, 12],
        ],
        area: 120,
        volume: 60,
        maxDev: 0.8,
        sign: 'overcut',
        depthRange: [0, 3],
        operationId: ops[0]!,
      },
      {
        face: 'stock.top',
        bounds: [
          [20, 0],
          [21, 1],
        ],
        area: 1,
        volume: 0.2,
        maxDev: 0.3,
        sign: 'undercut',
        depthRange: [2, 3],
        cause: 'toolRadius',
        operationId: ops[1]!,
      },
      {
        face: 'stock.bottom',
        bounds: [
          [0, 0],
          [8, 4],
        ],
        area: 19,
        volume: 2,
        maxDev: 0.2,
        sign: 'undercut',
        depthRange: [0, 1],
        cause: 'tab',
      },
    ],
    more: 2,
    unexplained: 1,
    planId,
  }
}

const within0 = (planId: string): DeviationResultView => ({
  ...resultOf(planId, []),
  stats: stats(0.01),
  faces: [{ face: 'stock.top', ...stats(0.01) }],
  regions: [],
  unexplained: 0,
  more: 0,
})

async function renderPlan(opts: { reference?: boolean } = {}) {
  const p = fakeProject()
  const s = await planSetup({
    services: { region2d: nodeRegion2d(), project: p.session, workers: p.workers },
  })
  if (opts.reference !== false)
    await s.run('design.reference.import', { partId: s.partId, path: '/models/box.stl' })
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const bridge = createFakeBridge()
  bridge.bind(s.d)
  bridge.handle('plan.toolpath.get', () => ok({ toolpath: null, stale: false }))
  // the comparison job, driven by the test
  const job: { reply: unknown } = { reply: { state: 'running' } }
  bridge.handle('design.reference.compare', () => ok({ jobId: 'job1' }))
  bridge.handle('job.get', () => ok(job.reply))
  bridge.handle('job.abort', () => {
    job.reply = {
      state: 'finished',
      outcome: {
        ok: false,
        error: { code: 'op.aborted', message: 'aborted', issues: [], frames: [] },
      },
    }
    return ok({})
  })
  const shell = createShell(bridge)
  shell.ui.getState().setMode('plan')
  const r = renderUi(
    <ShellProvider shell={shell}>
      <App />
    </ShellProvider>,
  )
  await r.user.click(screen.getByRole('button', { name: 'Inspector' }))
  const inspector = () => screen.getByRole('complementary', { name: 'Inspector' })
  const panel = () => within(inspector()).getByRole('region', { name: 'Compare with reference' })
  const callsOf = (name: string) => bridge.calls.filter((c) => c.name === name).map((c) => c.args)
  const select = (id: string | null) => act(() => shell.ui.getState().select('plan', id))
  const plan = () => s.plan(planId)
  await waitFor(() => expect(plan().setups.length).toBeGreaterThan(0))
  const ops = plan().setups.flatMap((x) => x.operations.map((o) => o.id))
  select(null)
  await waitFor(() => panel())
  return { ...r, s, planId, plan, ops, job, inspector, panel, callsOf, select, shell }
}

describe('deviation panel (U4)', () => {
  it('without a reference: a note and no Compare', async () => {
    const t = await renderPlan({ reference: false })
    expect(within(t.panel()).getByText(/^Import a reference model in Design/)).toBeVisible()
    expect(within(t.panel()).queryByRole('button', { name: 'Compare' })).toBeNull()
  })

  it('runs the job with the threshold, shows progress, Cancel aborts it', async () => {
    const t = await renderPlan()
    const panel = within(t.panel())
    expect(panel.getByText(/^Toolpaths are generated where missing/)).toBeVisible()
    const threshold = panel.getByLabelText('Threshold')
    await t.user.clear(threshold)
    await t.user.type(threshold, '0.2{Enter}')
    t.job.reply = { state: 'running', progress: { done: 1, total: 4 } }
    await t.user.click(panel.getByRole('button', { name: 'Compare' }))
    expect(t.callsOf('design.reference.compare')).toEqual([
      {
        partId: t.s.partId,
        source: { kind: 'plan', planId: t.planId },
        threshold: 0.2,
        limit: 20,
      },
    ])
    await waitFor(() => expect(panel.getByRole('status')).toHaveTextContent('Comparing'))
    expect(t.panel()).toHaveAttribute('aria-busy', 'true')
    await waitFor(() =>
      expect(panel.getByRole('progressbar', { name: 'Comparing' })).toHaveAttribute(
        'aria-valuenow',
        '1',
      ),
    )
    await t.user.click(panel.getByRole('button', { name: 'Cancel' }))
    expect(t.callsOf('job.abort')).toEqual([{ jobId: 'job1' }])
    await waitFor(() => expect(panel.getByRole('button', { name: 'Compare' })).toBeVisible())
    expect(panel.queryByRole('progressbar')).toBeNull()
    expect(t.panel()).toHaveAttribute('aria-busy', 'false')
  })

  it('shows the statistics and the regions with causes; a region selects its operation', async () => {
    const t = await renderPlan()
    t.job.reply = { state: 'finished', outcome: { ok: true, value: resultOf(t.planId, t.ops) } }
    const scrolled = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    await t.user.click(within(t.panel()).getByRole('button', { name: 'Compare' }))
    const panel = within(t.panel())
    // R7: a result that arrives scrolls the group into view
    await waitFor(() => expect(scrolled.mock.contexts).toContain(t.panel()))
    scrolled.mockClear()
    await waitFor(() =>
      expect(panel.getByRole('status')).toHaveTextContent(
        '5 regions over 0.1 mm · 1 without a known cause',
      ),
    )
    // R7: summary, then the regions, then the statistics in a closed accordion
    const statistics = panel.getByRole('region', { name: 'Statistics' })
    const toggle = within(statistics).getByRole('button', { name: /^Statistics/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('Statistics· max 0.8 mm · 95 % 0.005 mm')
    expect(
      panel.getByRole('list', { name: 'Regions' }).compareDocumentPosition(statistics) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      panel
        .getByRole('status')
        .compareDocumentPosition(panel.getByRole('list', { name: 'Regions' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(within(statistics).getByText('Mean')).not.toBeVisible()
    await t.user.click(toggle)
    expect(within(statistics).getByText('Mean')).toBeVisible()
    const statList = t.panel().querySelector('dl')!
    expect(statList).toHaveTextContent('Mean0.012 mm')
    expect(statList).toHaveTextContent('99 %0.04 mm')
    expect(statList).toHaveTextContent('Worst over-cut0.8 mm')
    expect(statList).toHaveTextContent('Worst under-cut0.3 mm')
    expect(statList).toHaveTextContent('Area over threshold140 mm²')
    expect(statList).toHaveTextContent('Edge band (not compared)13 mm²')
    expect(panel.getByText('Top: 99 % 0.04 mm · max 0.8 mm')).toBeVisible()
    expect(panel.getByText('Bottom: 99 % 0.04 mm · max 0.3 mm')).toBeVisible()
    const regions = panel.getByRole('list', { name: 'Regions' })
    const rows = within(regions).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    const first = within(rows[0]!).getByRole('button')
    expect(first).toHaveAccessibleName(
      /^Over-cut 0\.8 mm · .+, top, 120 mm², check: no known cause$/,
    )
    expect(within(rows[1]!).getByRole('button')).toHaveAccessibleName(
      /^Under-cut 0\.3 mm · .+, top, 1 mm², tool radius$/,
    )
    // no operation: a button too (it marks and frames its region)
    expect(within(rows[2]!).getByRole('button')).toHaveAccessibleName(
      'Under-cut 0.2 mm, bottom, 19 mm², tab',
    )
    expect(panel.getByText('2 more regions not shown.')).toBeVisible()
    await expectNoAxeViolations(t.inspector())

    // choosing a region selects its plan operation; back on the plan it stays chosen
    await t.user.click(first)
    expect(t.shell.ui.getState().selection.plan).toBe(t.ops[0])
    await waitFor(() =>
      expect(
        within(t.inspector()).queryByRole('region', { name: 'Compare with reference' }),
      ).toBeNull(),
    )
    t.select(null)
    const again = await waitFor(() =>
      within(within(t.panel()).getByRole('list', { name: 'Regions' })).getAllByRole('button'),
    )
    expect(again[0]).toHaveAttribute('aria-pressed', 'true')
    // the kept result does not scroll again when the panel comes back
    expect(scrolled.mock.contexts).not.toContain(t.panel())
    scrolled.mockRestore()
    expect(within(t.panel()).queryByText(/^The plan changed since/)).toBeNull()

    // an edit makes the numbers outdated; they stay
    await t.s.run('plan.update', { planId: t.planId, name: 'Renamed' })
    await waitFor(() =>
      expect(within(t.panel()).getByText(/^The plan changed since this comparison/)).toBeVisible(),
    )
    expect(within(t.panel()).getByRole('button', { name: 'Compare again' })).toBeVisible()
  })

  it('a chosen region is marked in the Plan viewport; a row without an operation only marks', async () => {
    const t = await renderPlan()
    t.job.reply = { state: 'finished', outcome: { ok: true, value: resultOf(t.planId, t.ops) } }
    await t.user.click(within(t.panel()).getByRole('button', { name: 'Compare' }))
    const rows = await waitFor(() =>
      within(within(t.panel()).getByRole('list', { name: 'Regions' })).getAllByRole('button'),
    )
    expect(scene.last['regionMarker']).toBeUndefined()
    // the tab region on the bottom: no operation to select, the panel stays
    await t.user.click(rows[2]!)
    expect(t.shell.ui.getState().selection.plan ?? null).toBeNull()
    expect(rows[2]).toHaveAttribute('aria-pressed', 'true')
    const thickness = planStockSize(t.s.d.doc, t.plan())!.thickness
    await waitFor(() =>
      expect(scene.last['regionMarker']).toMatchObject({
        sign: 'undercut',
        label: 'Marked: Under-cut 0.2 mm, bottom.',
      }),
    )
    type B = { min: [number, number, number]; max: [number, number, number] }
    const marker = scene.last['regionMarker'] as { box: B }
    // seen from below: the depths 0–1 mm run up from the stock bottom
    expect(marker.box.min[2]).toBeCloseTo(-thickness)
    expect(marker.box.max[2]).toBeCloseTo(-thickness + 1)
    expect(marker.box.max[0] - marker.box.min[0]).toBeCloseTo(8)
    expect(marker.box.max[1] - marker.box.min[1]).toBeCloseTo(4)
    // the framing request: the box grown to 10 mm; a second choice is a new request
    const focus = scene.last['focus'] as { box: B; seq: number }
    expect(focus.box.max[0] - focus.box.min[0]).toBeCloseTo(10)
    await t.user.click(rows[2]!)
    await waitFor(() => expect((scene.last['focus'] as { seq: number }).seq).toBe(focus.seq + 1))
    // another region replaces it
    await t.user.click(rows[1]!)
    await waitFor(() => expect(scene.last['regionMarker']).toMatchObject({ sign: 'undercut' }))
    expect((scene.last['regionMarker'] as typeof marker).box.max[0]).not.toBe(marker.box.max[0])
    // an edit makes the result outdated: the marker goes
    await t.s.run('plan.update', { planId: t.planId, name: 'Renamed' })
    await waitFor(() => expect(scene.last['regionMarker']).toBeUndefined())
  })

  it('a result within the threshold says so, without a regions list', async () => {
    const t = await renderPlan()
    t.job.reply = { state: 'finished', outcome: { ok: true, value: within0(t.planId) } }
    await t.user.click(within(t.panel()).getByRole('button', { name: 'Compare' }))
    const panel = within(t.panel())
    await waitFor(() =>
      expect(panel.getByRole('status')).toHaveTextContent(
        'The programs make the reference within 0.1 mm.',
      ),
    )
    expect(panel.queryByRole('list', { name: 'Regions' })).toBeNull()
    expect(panel.queryByText(/^Top:/)).toBeNull()
  })

  it('a failed job shows the error and keeps Compare', async () => {
    const t = await renderPlan()
    t.job.reply = {
      state: 'finished',
      outcome: {
        ok: false,
        error: {
          code: 'plan.check',
          message: 'the plan has no operations',
          issues: [],
          frames: [],
        },
      },
    }
    await t.user.click(within(t.panel()).getByRole('button', { name: 'Compare' }))
    const panel = within(t.panel())
    await waitFor(() => expect(panel.getByText('The plan could not be compared.')).toBeVisible())
    expect(panel.getByRole('button', { name: 'Compare' })).toBeVisible()
  })
})
