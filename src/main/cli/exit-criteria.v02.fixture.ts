// Test-only: the v0.2 exit-criteria script (task X1), run headless through the bundled CLI by
// both agent transports (exit-criteria.mcp.test.ts, exit-criteria.batch.test.ts), like the v0.1
// flow in exit-criteria.fixture.ts. Each step asserts the exit criterion it covers. Not app code.
// Docs: docs/plans/v0.2.md#exit-criteria, docs/conventions/testing.md#end-to-end
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { agentSession, type Call, programEnd, type RunJobStatus } from './exit-criteria.fixture'

/**
 * The user's STL of a wooden enclosure base (249.5 × 177 × 39 mm, a tray with ~7 mm walls and a
 * 4.2 mm floor), the reference the part is recreated from.
 */
export const ENCLOSURE_STL = resolve(
  import.meta.dirname,
  '../../core/design/__fixtures__/enclosure-wood-base.stl',
)

/**
 * The golden program of each setup, in machining order (paths relative to the test files).
 * Update after an intended post or generator change with
 * `npx vitest run src/main/cli/exit-criteria -u` and review the diff.
 */
export const GOLDEN_V02 = [
  './__golden__/exit-criteria-enclosure-1-bottom.nc',
  './__golden__/exit-criteria-enclosure-2-right.nc',
  './__golden__/exit-criteria-enclosure-3-top.nc',
] as const

/** Stock: a hardwood board a little larger than the reference (mm). */
const STOCK = { length: 255, width: 185, thickness: 40 }

const hardwood = (name: string, values: Record<string, string>) => ({
  name,
  materialClass: 'hardwood',
  ...values,
})

/** Library tools for the enclosure, with hardwood presets (quantity strings, mm). */
const TOOLS = [
  {
    name: 'Flat 12',
    type: 'flatEndMill',
    diameter: '12',
    fluteLength: '50',
    overallLength: '100',
    fluteCount: '2',
    toolMaterial: 'carbide',
    presets: [
      hardwood('Hardwood rough', {
        spindleSpeed: '12000',
        feedRate: '3600',
        plungeRate: '800',
        stepdown: '6',
        stepover: '6',
      }),
    ],
  },
  {
    name: 'Flat 6',
    type: 'flatEndMill',
    diameter: '6',
    fluteLength: '25',
    overallLength: '60',
    fluteCount: '2',
    toolMaterial: 'carbide',
    presets: [
      hardwood('Hardwood', {
        spindleSpeed: '16000',
        feedRate: '3000',
        plungeRate: '600',
        stepdown: '3',
        stepover: '3',
      }),
    ],
  },
  {
    name: 'Drill 6',
    type: 'drill',
    diameter: '6',
    fluteLength: '30',
    overallLength: '66',
    fluteCount: '2',
    pointAngle: '118',
    presets: [
      hardwood('Hardwood drill', { spindleSpeed: '3000', feedRate: '300', plungeRate: '300' }),
    ],
  },
] as const

/**
 * A router with a tall Z: the right-side setup stands the 255 mm board on its end, and the plan's
 * machine check needs the stock's extent along the spindle plus the clearance within the travel.
 */
const MACHINE = {
  name: 'Router, tall Z',
  controller: 'grbl',
  travel: { x: '800', y: '800', z: '300' },
  maxFeedRate: { x: '5000', y: '5000', z: '1000' },
  spindle: { control: 'manual', maxSpeed: '30000' },
  programUnits: 'mm',
  toolChanger: 'none',
}

export interface FlowV02Result {
  /** The text `plan.export` wrote for each setup, in machining order. */
  readonly programs: readonly string[]
}

/**
 * Runs the v0.2 exit-criteria flow: library → project with a hardwood board → STL reference
 * imported (read as mm, fitted centred, then onto the stock bottom) → the enclosure recreated on
 * three faces: top facing, a pocket placed by its front-left corner on the facing floor and a
 * through profile with tabs and a locked library tool; two holes on the right side; a recess on the
 * bottom (auto tool choice everywhere else) → plan: three setups (Bottom, Right, Top), settled,
 * one operation edited for this plan only, a strategy parameter → toolpaths → per setup: work
 * zero, GRBL export (golden), virtual run at `max`, chained by `next` → save → close → reopen →
 * compare (and re-export: same bytes).
 */
export async function exitCriteriaV02Flow(call: Call, dir: string): Promise<FlowV02Result> {
  const { ok, waitJob, untilLabel } = agentSession(call)

  // ── Library (app scope, no project needed) ────────────────────────────────────────────────
  const stock = (
    await ok<{ id: string }>('library.stock.add', {
      values: {
        name: 'Walnut board',
        shape: 'block',
        length: `${STOCK.length}`,
        width: `${STOCK.width}`,
        thickness: `${STOCK.thickness}`,
        material: { name: 'Walnut', class: 'hardwood' },
      },
    })
  ).value.id
  const tools: Record<string, string> = {}
  for (const t of TOOLS)
    tools[t.name] = (await ok<{ id: string }>('library.tool.add', { values: t })).value.id
  const machine = (await ok<{ id: string }>('library.machine.add', { values: MACHINE })).value.id

  // ── New project with the board as stock ───────────────────────────────────────────────────
  const created = await ok<{ key: string; revision: number }>('project.create', {
    name: 'Enclosure',
    unitSystem: 'mm',
  })
  const { partId } = (
    await ok<{ partId: string }>('design.part.add', {
      name: 'Enclosure base',
      stockLibraryItemId: stock,
      expectedRevision: created.value.revision,
    })
  ).value

  // ── Criterion: import the STL reference, read as mm, fit to the stock (centre, top) ───────
  const imported = (
    await ok<ReferenceImport>('design.reference.import', { partId, path: ENCLOSURE_STL })
  ).value
  expect(imported).toMatchObject({
    sourceUnit: 'mm',
    guess: { unit: 'mm' },
    warnings: [expect.objectContaining({ code: 'reference.unitGuessed' })],
  })
  const referenceId = imported.referenceId
  const placed = async () => {
    const { references } = (await ok<ReferenceList>('design.reference.list', { partId })).value
    expect(references).toHaveLength(1)
    expect(references[0]).toMatchObject({ id: referenceId, name: 'enclosure-wood-base' })
    expect(references[0]!.warnings).toEqual([])
    return references[0]!.placed
  }
  // centred on the stock, its top on the stock top; the reference sizes the stock: 249.5 × 177 ×
  // 39 inside the 255 × 185 × 40 board
  const fitted = await placed()
  expectBox(fitted, {
    min: [2.75, 3.97, -39],
    max: [252.25, 181.03, 0],
  })
  // the board is faced by 1 mm, the reference sits on the stock bottom (its top on the faced top)
  await ok('design.reference.update', { partId, referenceId, fit: { z: 'bottom' } })
  expectBox(await placed(), { min: [2.75, 3.97, -40], max: [252.25, 181.03, -1] })

  // ── Criterion: recreate the part on three faces ───────────────────────────────────────────
  // top: facing, the cavity placed by its front-left corner on the facing floor, a through
  // profile with tabs (its tool locked: a library tool); everything else: the auto choice
  const facing = (await ok<AddResult>('design.facing.add', { partId, depth: '1' })).value
  const pocket = (
    await ok<AddResult>('design.pocket.add', {
      partId,
      on: `${facing.operationId}.floor`,
      anchor: { u: 'min', v: 'min' },
      shape: {
        kind: 'rectangle',
        center: ['10', '13'],
        length: '235',
        width: '159',
        cornerRadius: '8',
      },
      depth: '34.8',
    })
  ).value
  const profile = (
    await ok<AddResult>('design.profile.add', {
      partId,
      shape: {
        kind: 'rectangle',
        center: ['127.5', '92.5'],
        length: '249.5',
        width: '177',
        cornerRadius: '6',
      },
      slotWidth: '12',
      tabs: { count: '4', width: '12', thickness: '4' },
      tool: { kind: 'specific', toolLibraryItemId: tools['Flat 12'] },
    })
  ).value
  expect(profile).toMatchObject({ toolLocked: true, tool: { kind: 'specific' } })
  // right side (+x; u = part +Y, v = part +Z from the bottom): two cable holes through the wall
  // into the cavity, 20 mm above the bottom
  const holes: AddResult[] = []
  for (const u of ['72.5', '112.5'])
    holes.push(
      (
        await ok<AddResult>('design.drilling.add', {
          partId,
          on: 'stock.side[1]',
          center: [u, '20'],
          diameter: '6',
          bottom: 'drillPoint',
          depth: '14',
        })
      ).value,
    )
  // bottom (u = part +X, v = part −Y): a label recess, centred
  const recess = (
    await ok<AddResult>('design.pocket.add', {
      partId,
      on: 'stock.bottom',
      shape: {
        kind: 'rectangle',
        center: ['127.5', '92.5'],
        length: '80',
        width: '40',
        cornerRadius: '4',
      },
      depth: '1.5',
    })
  ).value
  const evaluated = await ok<{ jobId: string }>('design.part.evaluate', { partId })
  expect(await waitJob(evaluated.value.jobId)).toMatchObject({
    ok: true,
    value: { evaluation: 'done' },
  })
  const designed = (await ok<PartGet>('design.part.get', { partId })).value
  expect(designed.stock.values).toMatchObject({
    // quantities entered as plain numbers come back as numbers (llm-api.md#result-size)
    length: STOCK.length,
    width: STOCK.width,
    thickness: STOCK.thickness,
  })
  const ops = designed.part.operations
  expect(ops.map((o) => [o.kind, o.on ?? 'stock.top'])).toEqual([
    ['facing', 'stock.top'],
    ['pocket', `${facing.operationId}.floor`],
    ['profile', 'stock.top'],
    ['drilling', 'stock.side[1]'],
    ['drilling', 'stock.side[1]'],
    ['pocket', 'stock.bottom'],
  ])
  expect(ops[1]).toMatchObject({
    shape: { anchor: { u: 'min', v: 'min' }, center: [10, 13] },
  })
  // agents auto-apply: the auto choice gave every other operation a tool, unlocked
  const byId = new Map(ops.map((o) => [o.id, o]))
  expect(byId.get(profile.operationId)).toMatchObject({ toolLocked: true })
  for (const id of [facing, pocket, ...holes, recess].map((a) => a.operationId)) {
    expect(byId.get(id)!.tool, id).toBeDefined()
    expect(byId.get(id)!.toolLocked, id).toBeUndefined()
  }
  // the recess's 4 mm corners rule out the 12 mm end mill
  const candidates = (
    await ok<ToolCandidates>('design.tool.candidates', {
      partId,
      operationId: recess.operationId,
    })
  ).value
  expect(candidates.current).toMatchObject({ locked: false, fits: true })
  expect(candidates.fitting.map((c) => c.name)).not.toContain('Flat 12')

  // ── Criterion: plan derives three setups (bottom, right, top last) ────────────────────────
  const createdPlan = (
    await ok<{ planId: string; setupIds: string[] }>('plan.create', {
      partId,
      machineLibraryItemId: machine,
    })
  ).value
  const planId = createdPlan.planId
  let plan = (await ok<PlanGet>('plan.get', { planId, detail: 'full' })).value.plan
  expect(plan.setups.map((s) => [s.name, s.direction ?? '+z'])).toEqual([
    ['Bottom', '-z'],
    ['Right', '+x'],
    ['Top', '+z'],
  ])
  expect(plan.setups.map((s) => s.id)).toEqual(createdPlan.setupIds)
  // every design operation is machined once, in the setup of its face
  const setupOf = (opId: string) =>
    plan.setups.find((s) => s.operations.some((o) => o.designOperationIds.includes(opId)))?.name
  expect(ops.map((o) => setupOf(o.id))).toEqual(['Top', 'Top', 'Top', 'Right', 'Right', 'Bottom'])
  // the locked tool is assigned from the design (a plan copy of its snapshot)
  const profilePlanOp = plan.setups[2]!.operations.find((o) =>
    o.designOperationIds.includes(profile.operationId),
  )!
  expect(profilePlanOp).toMatchObject({ toolSource: 'design' })
  expect(snapshotName(plan, profilePlanOp.tool)).toBe('Flat 12')
  const findings = (
    await ok<{ warnings: Finding[] }>('plan.warning.list', { planId, detail: 'full' })
  ).value
  // no errors, and no machine or feeds warnings (the presets keep the chip load in range)
  expect(findings.warnings).toEqual([])

  // ── Criterion: settle the design, edit one operation for this plan only, a strategy ───────
  await ok('plan.status.set', { planId, status: 'settledDesign' })
  await ok('plan.design.operation.update', {
    planId,
    operationId: recess.operationId,
    depth: '2',
  })
  const stale = (await ok<StaleList>('plan.stale.list', { planId })).value
  expect(stale.operations.filter((o) => o.editedInPlan)).toHaveLength(1)
  const drillPlanOp = plan.setups[1]!.operations[0]!
  expect(drillPlanOp.designOperationIds.sort()).toEqual(holes.map((h) => h.operationId).sort())
  await ok('plan.operation.update', {
    planId,
    planOperationId: drillPlanOp.id,
    strategy: { cycle: 'peck', peckDepth: '4' },
  })
  plan = (await ok<PlanGet>('plan.get', { planId, detail: 'full' })).value.plan
  expect(plan.status).toBe('settledDesign')
  expect(plan.design.part.operations.find((o) => o.id === recess.operationId)).toMatchObject({
    depth: 2,
  })

  // Toolpaths (a job; job.wait reports its outcome)
  const gen = await ok<{ jobId: string }>('plan.toolpath.generate', { planId })
  const generated = (await waitJob(gen.value.jobId)) as {
    ok: boolean
    value: { operations: { status: string }[] }
  }
  expect(generated.ok).toBe(true)
  const planOpCount = plan.setups.reduce((n, s) => n + s.operations.length, 0)
  expect(generated.value.operations).toHaveLength(planOpCount)
  expect(generated.value.operations.every((o) => o.status === 'generated')).toBe(true)

  // ── Criterion: export one GRBL program per setup; run each on the virtual machine ─────────
  // `prepare` homes and centres the first setup's stock; each later setup is re-zeroed at the
  // setup change (the operator's jog + zero; here `values` at the current position)
  await ok('run.connection.open', { target: 'virtual', planId, timeScale: 'max', prepare: true })
  const programs: string[] = []
  let setupId: string | undefined = plan.setups[0]!.id
  for (const [i, setup] of plan.setups.entries()) {
    expect(setupId).toBe(setup.id)
    if (i > 0) await zeroForSetup(ok, setup.direction ?? '+z', mm(setup.clearanceHeight))
    const target = join(dir, `enclosure-${i + 1}.nc`)
    const exported = (await ok<ExportResult>('plan.export', { planId, setupId, target })).value
    expect(exported).toMatchObject({
      setupId,
      softLimitChecked: true,
      warnings: [],
      regenerated: [],
    })
    const gcode = readFileSync(target, 'utf8')
    await expect(gcode).toMatchFileSnapshot(GOLDEN_V02[i]!)
    expect(gcode).toContain(`(Setup: ${setup.name})`)
    expect(gcode.split('\n').filter((l) => l !== '')).toHaveLength(exported.lines)
    expect(gcode.trimEnd().endsWith('M30')).toBe(true)
    programs.push(gcode)

    const run = await ok<{ jobId: string }>('run.job.start', { planId, setupId })
    const jobId = run.value.jobId
    const waits: string[] = []
    const ended = (await waitJob(jobId, async (job: RunJobStatus) => {
      if (job.phase === 'toolChange') {
        const tc = job.toolChange!
        await untilLabel(jobId, `Tool change ${tc.n}: ${tc.name}`)
        waits.push(`toolChange ${tc.n}`)
        await ok('run.job.continue', { jobId, toolChange: tc.n })
      } else if (job.phase === 'programPause') {
        waits.push('programPause')
        await ok('run.job.continue', { jobId, pause: job.pause })
      }
    })) as { ok: boolean; value: RunSummary }
    expect(ended.ok, JSON.stringify(ended)).toBe(true)
    expect(ended.value).toMatchObject({
      setupId,
      lines: exported.lines,
      toolChanges: exported.stats.toolChanges,
      warnings: [],
    })
    const markers = [...gcode.matchAll(/^\(DFYOM TOOL CHANGE (\d+): [^)]*\)\nM0$/gm)]
    expect(waits.filter((w) => w.startsWith('toolChange'))).toEqual(
      markers.map((mk) => `toolChange ${mk[1]}`),
    )
    // the run names the setup after it: the agent chains the setups by `next`
    const next = plan.setups[i + 1]
    if (next === undefined) expect(ended.value.next).toBeUndefined()
    else
      expect(ended.value.next).toEqual({
        setupId: next.id,
        name: next.name,
        direction: next.direction ?? '+z',
        rotation: 0,
        // the part corner at the work zero (hardening M7)
        corner: expect.any(String),
      })
    setupId = ended.value.next?.setupId
    const after = (await ok<RunStatus>('run.status.get')).value
    expect(after).toMatchObject({ state: 'Idle', homed: true })
    expect(after.alarm).toBeUndefined()
    const end = programEnd(gcode)
    after.wpos.forEach((v, k) => expect(v).toBeCloseTo(end[k]!, 3))
  }
  expect(setupId).toBeUndefined()
  // each setup's program holds only its own operations
  expect(
    programs.map((g) =>
      [...g.matchAll(/^\(((?:Facing|Pocket|Profile|Drilling)[^)]*)\)$/gm)].map((m) => m[1]),
    ),
  ).toEqual([['Pocket 2'], ['Drilling 1, Drilling 2'], ['Facing 1', 'Pocket 1', 'Profile 1']])
  await ok('run.connection.close')

  // ── Criterion: save, close and reopen: reference, anchors, tools and setups unchanged ─────
  const file = join(dir, 'enclosure.dfyom')
  await ok('project.save', { target: file })
  const partBefore = (await ok('design.part.get', { partId })).value
  const refsBefore = (await ok('design.reference.list', { partId })).value
  const planBefore = (await ok('plan.get', { planId, detail: 'full' })).value
  await ok('project.close', { key: created.value.key })
  const reopened = await ok<{ key: string; alreadyOpen: boolean }>('project.open', { file })
  expect(reopened.value.alreadyOpen).toBe(false)
  expect((await ok('design.part.get', { partId })).value).toEqual(partBefore)
  expect((await ok('design.reference.list', { partId })).value).toEqual(refsBefore)
  expect((await ok('plan.get', { planId, detail: 'full' })).value).toEqual(planBefore)
  // the reopened project exports the same programs
  for (const [i, setup] of plan.setups.entries()) {
    const again = join(dir, `enclosure-reopened-${i + 1}.nc`)
    await ok('plan.export', { planId, setupId: setup.id, target: again })
    expect(readFileSync(again, 'utf8')).toBe(programs[i])
  }
  return { programs }
}

/**
 * The setup change, done by the agent: G54 so the setup's stock lies centred on the table with
 * its clearance plane 5 mm below the top of the travel, as `prepare` does for the first setup
 * (docs/modes/plan-v0.2.md#implementation-task-e2).
 */
async function zeroForSetup(
  ok: ReturnType<typeof agentSession>['ok'],
  direction: string,
  clearance: number,
): Promise<void> {
  const { length: l, width: w } = STOCK
  const t = STOCK.thickness
  // the stock's extents along the setup's X and Y (unrotated face frame)
  const [x, y] = direction.endsWith('x') ? [w, t] : direction.endsWith('y') ? [l, t] : [l, w]
  const travel = { x: 800, y: 800 }
  const g54 = [-travel.x / 2 - x / 2, -travel.y / 2 - y / 2, -5 - clearance]
  const { mpos } = (await ok<RunStatus>('run.status.get')).value
  const values = mpos.map((m, i) => m - g54[i]!)
  const set = (
    await ok<{ workZero: number[] }>('run.workZero.set', {
      axes: ['x', 'y', 'z'],
      values,
    })
  ).value
  set.workZero.forEach((v, i) => expect(v).toBeCloseTo(g54[i]!, 3))
}

function expectBox(
  box: Box,
  want: { min: [number, number, number]; max: [number, number, number] },
): void {
  const axes = ['x', 'y', 'z'] as const
  axes.forEach((a, i) => {
    expect(box.min[a], `min.${a}`).toBeCloseTo(want.min[i]!, 1)
    expect(box.max[a], `max.${a}`).toBeCloseTo(want.max[i]!, 1)
  })
}

function snapshotName(plan: PlanGet['plan'], snapshotId: string): string | undefined {
  return plan.snapshots.find((s) => s.id === snapshotId)?.values.name
}

/** A compact quantity's value in its canonical unit (mm): a number, or `{ source, value }`. */
const mm = (q: Exact) => (typeof q === 'number' ? q : q.value)

type Exact = number | { source: string; value: number }
interface Box {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}
interface ReferenceImport {
  referenceId: string
  sourceUnit: string
  guess: { unit: string; reason: string }
  warnings: { code: string }[]
}
interface ReferenceList {
  references: { id: string; name: string; placed: Box; warnings: unknown[] }[]
}
interface AddResult {
  operationId: string
  tool?: unknown
  toolLocked: boolean
}
interface Op {
  id: string
  kind: string
  on?: string
  tool?: unknown
  toolLocked?: true
  [key: string]: unknown
}
interface PartGet {
  part: { operations: Op[] }
  stock: { values: Record<string, unknown> }
}
interface ToolCandidates {
  fitting: { name: string }[]
  current: { locked: boolean; fits: boolean } | null
}
interface PlanOp {
  id: string
  tool: string
  toolSource?: string
  designOperationIds: string[]
}
interface PlanGet {
  plan: {
    status: string
    setups: {
      id: string
      name: string
      direction?: string
      clearanceHeight: Exact
      operations: PlanOp[]
    }[]
    snapshots: { id: string; kind: string; values: { name: string } }[]
    design: { part: { operations: Op[] } }
  }
}
interface Finding {
  code: string
  severity: string
}
interface StaleList {
  operations: { editedInPlan?: boolean }[]
}
interface ExportResult {
  setupId: string
  lines: number
  stats: { toolChanges: number }
  warnings: unknown[]
  softLimitChecked: boolean
}
interface RunStatus {
  state: string
  homed: boolean
  mpos: number[]
  wpos: number[]
  alarm?: unknown
}
interface RunSummary {
  setupId: string
  lines: number
  toolChanges: number
  pauses: number
  warnings: unknown[]
  next?: { setupId: string; name: string; direction: string; rotation: number }
}
