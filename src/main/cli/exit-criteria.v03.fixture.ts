// Test-only: the v0.3 exit-criteria script (task X1), run headless through the bundled CLI by
// both agent transports (exit-criteria.mcp.test.ts, exit-criteria.batch.test.ts), like the v0.1
// and v0.2 flows. Every step goes through the public tools; only the deviation check at the end
// evaluates the part in-process (test-only, as the criteria say). Not app code.
// Docs: docs/plans/v0.3.md#exit-criteria, docs/conventions/testing.md#end-to-end
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import {
  SECTION_Z,
  readBinaryStl,
  sliceMesh,
  type Pt,
} from '../../core/design/enclosure-sections.testing'
import { toGeometryInput } from '../../core/design/geometry-input'
import { partFromDTO } from '../../core/design/operation'
import type { PartDTO } from '../../core/design/part.dto'
import { nodeRegion2d } from '../../core/geometry/2d/testing/node-wasm'
import { evaluatePart } from '../../core/geometry/evaluate'
import { loadManifold } from '../../core/geometry/manifold'
import { Snapshot, type SnapshotDTO } from '../../core/library/snapshot'
import { Stock } from '../../core/library/stock'
import { loadArchive } from '../persistence/archive'
import { nodeFs } from '../persistence/fs'
import { agentSession, type Call, programEnd, type RunJobStatus } from './exit-criteria.fixture'
import { ENCLOSURE_STL } from './exit-criteria.v02.fixture'

/** The X0 drawing: the STL's outline and cavity sectioned at mid-wall height, cubic Béziers. */
export const ENCLOSURE_SVG = resolve(
  import.meta.dirname,
  '../../core/design/__fixtures__/enclosure-sections.svg',
)

/**
 * The golden program of each setup, in machining order (paths relative to the test files).
 * Update after an intended post or generator change with
 * `npx vitest run src/main/cli/exit-criteria -u` and review the diff.
 */
export const GOLDEN_V03 = [
  './__golden__/exit-criteria-shapes-1-bottom.nc',
  './__golden__/exit-criteria-shapes-2-top.nc',
] as const

/** Stock: the hardwood board of v0.2 (mm). */
export const STOCK_V03 = { length: 255, width: 185, thickness: 40 } as const
const STOCK = STOCK_V03

/**
 * The four blind holes drilled on `stock.bottom`, as `[u, v]` in that face's frame (u = part +X,
 * v = part −Y from the back): (±88.5, ±44.3) from the centre. The v0.4 lid's countersunk screws
 * stand over them (exit-part-v04.test.ts, task X0).
 */
export const BASE_HOLE_CENTRES: readonly (readonly [string, string])[] = [-88.5, 88.5].flatMap(
  (du) =>
    [-44.3, 44.3].map(
      (dv) => [`${STOCK.length / 2 + du}`, `${(STOCK.width / 2 + dv).toFixed(1)}`] as const,
    ),
)

/** The deviation the criteria allow between the evaluated part and the reference (mm). */
export const DEVIATION_LIMIT = 0.2

const hardwood = (name: string, values: Record<string, string>) => ({
  name,
  materialClass: 'hardwood',
  ...values,
})

/** Library tools, with hardwood presets (quantity strings, mm). */
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
    name: 'Drill 3',
    type: 'drill',
    diameter: '3',
    fluteLength: '20',
    overallLength: '50',
    fluteCount: '2',
    pointAngle: '118',
    presets: [
      hardwood('Hardwood drill', { spindleSpeed: '5000', feedRate: '250', plungeRate: '250' }),
    ],
  },
] as const

/** A GRBL router; two setups (bottom, top) keep the board flat, so a 150 mm Z will do. */
const MACHINE = {
  name: 'Router',
  controller: 'grbl',
  travel: { x: '800', y: '800', z: '150' },
  maxFeedRate: { x: '5000', y: '5000', z: '1000' },
  spindle: { control: 'manual', maxSpeed: '30000' },
  programUnits: 'mm',
  toolChanger: 'none',
}

/** Fillet radii an agent tries at a sharp corner: the tool radius the warning asks for, then less. */
const FILLET_RADII = ['3', '2', '1', '0.5', '0.25', '0.1']

export interface FlowV03Result {
  /** The text `plan.export` wrote for each setup, in machining order. */
  readonly programs: readonly string[]
  /** Largest distance between the evaluated part's mid-wall section and the reference's (mm). */
  readonly deviation: Deviation
  /** The outcome of `design.part.evaluate` (job.wait), for `expectEvaluated`. */
  readonly evaluation: { readonly ok: boolean; readonly value?: unknown }
}

/**
 * Runs the v0.3 exit-criteria flow: library → project with the 255 × 185 × 40 board → the STL
 * reference imported and fitted → `design.shape.import` of the X0 drawing (outline and cavity) →
 * the back wall measured on the imported shapes → facing; the cavity pocketed on the facing floor,
 * its two sharp step corners filleted with Shape Editor commands as the warnings point them out
 * (D32); a cable notch from an obround and a rectangle (a boolean), rotated, pocketed across the
 * back wall; the outline profiled outside with four tabs placed along the loop and a locked
 * library tool; four drillings and an `on` groove along an open path on the bottom → plan: two
 * setups (Bottom, Top) → toolpaths → per setup: work zero, GRBL export (golden), virtual run →
 * save → close → reopen → compare → the deviation check of the evaluated part (test-only).
 */
export async function exitCriteriaV03Flow(call: Call, dir: string): Promise<FlowV03Result> {
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

  // ── Criterion: new project, 255 × 185 × 40 mm board ───────────────────────────────────────
  const created = await ok<{ key: string; revision: number }>('project.create', {
    name: 'Enclosure (shapes)',
    unitSystem: 'mm',
  })
  const { partId } = (
    await ok<{ partId: string }>('design.part.add', {
      name: 'Enclosure base',
      stockLibraryItemId: stock,
      expectedRevision: created.value.revision,
    })
  ).value

  // ── Criterion: import the STL reference and fit it (centred, onto the stock bottom) ───────
  const imported = (
    await ok<{ referenceId: string; sourceUnit: string }>('design.reference.import', {
      partId,
      path: ENCLOSURE_STL,
    })
  ).value
  expect(imported.sourceUnit).toBe('mm')
  await ok('design.reference.update', {
    partId,
    referenceId: imported.referenceId,
    fit: { z: 'bottom' },
  })
  const { references } = (await ok<ReferenceList>('design.reference.list', { partId })).value
  expect(references).toHaveLength(1)
  const placed = references[0]!.placed
  // 249.5 × 177 × 39 centred on the board, on its bottom (the board is faced by 1 mm)
  expect((placed.min.x + placed.max.x) / 2).toBeCloseTo(STOCK.length / 2, 3)
  expect((placed.min.y + placed.max.y) / 2).toBeCloseTo(STOCK.width / 2, 3)
  expect(placed.min.z).toBeCloseTo(-STOCK.thickness, 3)
  expect(placed.max.z).toBeCloseTo(-1, 1)

  // ── Criterion: import the SVG sections: two shapes, Béziers fitted to arcs, the deviation ─
  const svg = (await ok<ShapeImport>('design.shape.import', { partId, path: ENCLOSURE_SVG })).value
  expect(svg.shapeIds).toEqual(['shape1', 'shape2'])
  expect(svg.report).toMatchObject({
    unit: 'mm',
    unitAssumed: false,
    imported: { path: 2 },
    skipped: {},
    beziersFitted: 22,
    loops: 2,
    openPaths: 0,
    lines: 3,
    warnings: [],
  })
  expect(svg.report.arcs).toBeGreaterThan(100)
  expect(svg.report.maxDeviation).toBeLessThanOrEqual(0.01)
  const listed = (await ok<{ shapes: ShapeSummary[] }>('design.shape.list', { partId })).value
  expect(listed.shapes.map((s) => [s.id, s.name, s.kind])).toEqual([
    ['shape1', 'outline', 'region'],
    ['shape2', 'cavity', 'region'],
  ])
  const outline = (await ok<ShapeGet>('design.shape.get', { partId, shapeId: 'shape1' })).value
  let cavity = (await ok<ShapeGet>('design.shape.get', { partId, shapeId: 'shape2' })).value

  // ── Criterion: measure the back wall (headless: on the resolved shapes, not the viewport) ─
  // the cavity's flat back stretch (its longest line) against the outline's back (X0: ≈ 12.5 mm
  // over 93.4 mm); the notch below crosses it
  const flat = longestLine(cavity)
  expect(flat.b[1]).toBeCloseTo(flat.a[1], 9)
  expect(Math.abs(flat.b[0] - flat.a[0])).toBeCloseTo(93.36, 2)
  const backWall = outline.resolved.bounds.max[1] - flat.a[1]
  expect(backWall).toBeCloseTo(12.5, 1)

  // the page (the STL's centre at its centre) centred on the board, like the fitted reference:
  // each shape's anchor is the centre of its box, moved by the same offset
  const offset = [
    STOCK.length / 2 - svg.report.size.width / 2,
    STOCK.width / 2 - svg.report.size.height / 2,
  ] as const
  const centreOf = (s: ShapeGet): [string, string] => {
    const b = s.resolved.bounds
    return [0, 1].map((k) => ((b.min[k]! + b.max[k]!) / 2 + offset[k]!).toFixed(6)) as [
      string,
      string,
    ]
  }

  // ── Criterion: facing on top; the cavity as a pocket on the facing floor ─────────────────
  const facing = (await ok<AddResult>('design.facing.add', { partId, depth: '1' })).value
  // down to the 4.2 mm floor of the 39 mm reference
  const pocket = (
    await ok<AddResult>('design.pocket.add', {
      partId,
      on: `${facing.operationId}.floor`,
      shape: { kind: 'named', shapeId: 'shape2', center: centreOf(cavity) },
      depth: '34.8',
    })
  ).value
  // X0: two sharp convex corners where the back wall meets its 2 mm step; the warnings say where
  // an edit's result lists the warnings that changed since this session last saw the part's
  const sharp = (pocket.warnings.added ?? []).filter(
    (w) => w.code === 'dfm.cornerSharp' && w.operation === pocket.operationId,
  )
  expect(sharp).toHaveLength(2)

  // ── Criterion (D32): fillet them in the Shape Editor (design.shape.item.update) ──────────
  // each marker back into the shape frame, onto the path vertex there; the largest radius the
  // neighbouring segments take (one corner sits next to a 0.33 mm arc of the fitted wall)
  const fillets: { vertex: number; radius: string }[] = []
  for (const w of sharp) {
    const at = w.params['at'] as [number, number]
    const vertex = nearestVertex(cavity, [at[0] - offset[0], at[1] - offset[1]])
    for (const radius of FILLET_RADII) {
      const r = await call('design.shape.item.update', {
        partId,
        shapeId: 'shape2',
        index: 0,
        fillets: [...fillets, { vertex, radius }],
      })
      if (r.ok) {
        fillets.push({ vertex, radius })
        break
      }
      expect(r.error, JSON.stringify(r.error)).toMatchObject({
        code: 'model.invariant',
        issues: [{ rule: 'filletTooLarge' }],
      })
    }
  }
  expect(fillets).toEqual([
    { vertex: 72, radius: '1' },
    { vertex: 0, radius: '0.25' },
  ])
  cavity = (await ok<ShapeGet>('design.shape.get', { partId, shapeId: 'shape2' })).value
  // no sharp corner left: what remains is two corners below every end mill's radius
  const corners = (await ok<{ warnings: Warning[] }>('design.warning.list', { partId })).value
  expect(
    corners.warnings
      .filter((w) => w.operation === pocket.operationId)
      .map((w) => [w.code, w.params['cornerRadius']]),
  ).toEqual([
    ['dfm.cornerTooSmall', expect.closeTo(1, 9)],
    ['dfm.cornerTooSmall', expect.closeTo(0.25, 9)],
    // the 0.25 mm corner is below even the 1 mm end mill's radius: no tool fits (DF52)
    ['dfm.noFittingTool', expect.closeTo(0.25, 9)],
  ])
  expect(cavity.usedBy).toEqual([pocket.operationId])

  // ── Criterion: a cable notch from an obround and a rectangle, rotated, across the back wall
  // a slot with one round end (in the cavity) and one square end (past the outline): 24 × 10,
  // the square end's corners rounded to the 6 mm tool's radius; rotated to run across the wall
  const notchLength = 24
  const notch = (
    await ok<{ shapeId: string }>('design.shape.add', {
      partId,
      name: 'Cable notch',
      items: [
        { kind: 'obround', center: ['0', '0'], length: `${notchLength}`, width: '10' },
        { kind: 'rectangle', center: ['6', '0'], length: '12', width: '10', cornerRadius: '3' },
      ],
    })
  ).value
  const notchShape = (await ok<ShapeGet>('design.shape.get', { partId, shapeId: notch.shapeId }))
    .value
  expect(notchShape.resolved).toMatchObject({ kind: 'region', bounds: { min: [-12, -5] } })
  expect(notchShape.resolved.pieces).toHaveLength(1)
  // centred on the flat stretch, reaching past the outline's back and 8 mm into the cavity
  const wallInner = flat.a[1] + offset[1]
  const wallOuter = outline.resolved.bounds.max[1] + offset[1]
  const notchCentre = [STOCK.length / 2, wallInner - 8 + notchLength / 2]
  expect(notchCentre[1]! + notchLength / 2).toBeGreaterThan(wallOuter)
  expect(notchCentre[1]! + notchLength / 2).toBeLessThan(STOCK.width)
  const notchPocket = (
    await ok<AddResult>('design.pocket.add', {
      partId,
      on: `${facing.operationId}.floor`,
      shape: {
        kind: 'named',
        shapeId: notch.shapeId,
        center: notchCentre.map(String),
        rotation: '90',
      },
      depth: '10',
    })
  ).value

  // ── Criterion: the outline as an outside profile, four tabs along the path, a locked tool ─
  const loopLength = outline.resolved.length
  const tabPositions = [0, 1, 2, 3].map((k) => (((k + 0.5) * loopLength) / 4).toFixed(3))
  const profile = (
    await ok<AddResult>('design.profile.add', {
      partId,
      shape: { kind: 'named', shapeId: 'shape1', center: centreOf(outline) },
      side: 'outside',
      slotWidth: '12',
      tabs: { width: '12', thickness: '4', positions: tabPositions },
      tool: { kind: 'specific', toolLibraryItemId: tools['Flat 12'] },
    })
  ).value
  expect(profile).toMatchObject({ toolLocked: true, tool: { kind: 'specific' } })

  // ── Criterion: four drillings on the bottom (u = part +X, v = part −Y from the back) ──────
  // Ø 3 mm, 3.9 mm deep at (±88.5, ±44.3) from the centre
  const holes: AddResult[] = []
  for (const center of BASE_HOLE_CENTRES)
    holes.push(
      (
        await ok<AddResult>('design.drilling.add', {
          partId,
          on: 'stock.bottom',
          center,
          diameter: '3',
          bottom: 'drillPoint',
          depth: '3.9',
        })
      ).value,
    )

  // ── Criterion: an `on` groove along an open path on the bottom (a blind label line) ──────
  const groove = (
    await ok<{ shapeId: string }>('design.shape.add', {
      partId,
      name: 'Label groove',
      items: [
        {
          kind: 'path',
          start: ['0', '0'],
          closed: false,
          segments: [
            { kind: 'line', to: ['40', '0'] },
            { kind: 'tangentArc', to: ['60', '20'] },
          ],
        },
      ],
    })
  ).value
  expect(
    (await ok<ShapeGet>('design.shape.get', { partId, shapeId: groove.shapeId })).value.resolved
      .kind,
  ).toBe('path')
  const grooveOp = (
    await ok<AddResult>('design.profile.add', {
      partId,
      on: 'stock.bottom',
      shape: { kind: 'named', shapeId: groove.shapeId, center: ['127.5', '92.5'] },
      side: 'on',
      slotWidth: '6',
      depth: '1',
    })
  ).value

  // the part evaluates; agents auto-apply, so every operation has its tool choice already. The
  // outcome is returned and asserted by the batch test (toolpaths, export and runs do not need
  // the solid)
  const evaluated = await ok<{ jobId: string }>('design.part.evaluate', { partId })
  const evaluation = await waitJob(evaluated.value.jobId)
  const designed = (await ok<PartGet>('design.part.get', { partId })).value
  const ops = designed.part.operations
  expect(ops.map((o) => [o.id, o.kind, o.on ?? 'stock.top'])).toEqual([
    [facing.operationId, 'facing', 'stock.top'],
    [pocket.operationId, 'pocket', `${facing.operationId}.floor`],
    [notchPocket.operationId, 'pocket', `${facing.operationId}.floor`],
    [profile.operationId, 'profile', 'stock.top'],
    ...holes.map((h) => [h.operationId, 'drilling', 'stock.bottom']),
    [grooveOp.operationId, 'profile', 'stock.bottom'],
  ])
  expect(designed.part.shapes.map((s) => s.name)).toEqual([
    'outline',
    'cavity',
    'Cable notch',
    'Label groove',
  ])
  const byId = new Map(ops.map((o) => [o.id, o]))
  expect(byId.get(notchPocket.operationId)).toMatchObject({
    shape: { kind: 'named', shapeId: notch.shapeId, rotation: 90 },
  })
  expect(byId.get(profile.operationId)).toMatchObject({
    toolLocked: true,
    tabs: { positions: tabPositions.map(Number) },
  })
  expect(byId.get(grooveOp.operationId)).toMatchObject({ side: 'on', depth: 1 })
  // what the design still says: the filleted corners are below every end mill's radius (so no
  // tool fits the cavity, DF52), the 2.75 mm board margin is narrower than the 12 mm slot (so the tabs hold to nothing), and two
  // setups are needed
  const designWarnings = (await ok<{ warnings: Warning[] }>('design.warning.list', { partId }))
    .value.warnings
  expect(designWarnings.map((w) => [w.code, w.operation])).toEqual([
    ['dfm.cornerTooSmall', pocket.operationId],
    ['dfm.cornerTooSmall', pocket.operationId],
    ['dfm.noFittingTool', pocket.operationId],
    ['dfm.slotLeavesStock', profile.operationId],
    ['dfm.setups', holes[0]!.operationId],
  ])

  // ── Criterion: plan derives two setups (bottom, top) ─────────────────────────────────────
  const createdPlan = (
    await ok<{ planId: string; setupIds: string[] }>('plan.create', {
      partId,
      machineLibraryItemId: machine,
    })
  ).value
  const planId = createdPlan.planId
  const plan = (await ok<PlanGet>('plan.get', { planId, detail: 'full' })).value.plan
  expect(plan.setups.map((s) => [s.name, s.direction ?? '+z'])).toEqual([
    ['Bottom', '-z'],
    ['Top', '+z'],
  ])
  expect(plan.setups.map((s) => s.id)).toEqual(createdPlan.setupIds)
  const setupOf = (opId: string) =>
    plan.setups.find((s) => s.operations.some((o) => o.designOperationIds.includes(opId)))?.name
  expect(ops.map((o) => setupOf(o.id))).toEqual([
    'Top',
    'Top',
    'Top',
    'Top',
    'Bottom',
    'Bottom',
    'Bottom',
    'Bottom',
    'Bottom',
  ])
  const toolOf = (opId: string) => {
    const planOp = plan.setups
      .flatMap((s) => s.operations)
      .find((o) => o.designOperationIds.includes(opId))!
    return plan.snapshots.find((s) => s.id === planOp.tool)?.values.name
  }
  expect(ops.map((o) => toolOf(o.id))).toEqual([
    'Flat 12',
    'Flat 12',
    'Flat 6',
    'Flat 12',
    'Drill 3',
    'Drill 3',
    'Drill 3',
    'Drill 3',
    'Flat 6',
  ])
  // the only finding: the cavity's 0.25 mm fillet keeps the 12 mm tool's radius
  const findings = (
    await ok<{ warnings: Finding[] }>('plan.warning.list', { planId, detail: 'full' })
  ).value
  expect(findings.warnings.map((f) => [f.severity, f.rule, f.params['operation']])).toEqual([
    ['warning', 'cornerRadius', pocket.operationId],
  ])

  // Toolpaths (a job; job.wait reports its outcome)
  const gen = await ok<{ jobId: string }>('plan.toolpath.generate', { planId })
  const generated = (await waitJob(gen.value.jobId)) as {
    ok: boolean
    value: { operations: { status: string }[] }
  }
  expect(generated.ok).toBe(true)
  expect(generated.value.operations.every((o) => o.status === 'generated')).toBe(true)

  // ── Criterion: export per setup; run both on the virtual machine ─────────────────────────
  await ok('run.connection.open', { target: 'virtual', planId, timeScale: 'max', prepare: true })
  const programs: string[] = []
  let setupId: string | undefined = plan.setups[0]!.id
  for (const [i, setup] of plan.setups.entries()) {
    expect(setupId).toBe(setup.id)
    if (i > 0) await zeroForSetup(ok, mm(setup.clearanceHeight))
    const target = join(dir, `shapes-${i + 1}.nc`)
    const exported = (await ok<ExportResult>('plan.export', { planId, setupId, target })).value
    expect(exported).toMatchObject({
      setupId,
      softLimitChecked: true,
      warnings: [],
      regenerated: [],
    })
    const gcode = readFileSync(target, 'utf8')
    await expect(gcode).toMatchFileSnapshot(GOLDEN_V03[i]!)
    expect(gcode).toContain(`(Setup: ${setup.name})`)
    expect(gcode.split('\n').filter((l) => l !== '')).toHaveLength(exported.lines)
    expect(gcode.trimEnd().endsWith('M30')).toBe(true)
    programs.push(gcode)

    const run = await ok<{ jobId: string }>('run.job.start', { planId, setupId })
    const jobId = run.value.jobId
    const ended = (await waitJob(jobId, async (job: RunJobStatus) => {
      if (job.phase === 'toolChange') {
        const tc = job.toolChange!
        await untilLabel(jobId, `Tool change ${tc.n}: ${tc.name}`)
        await ok('run.job.continue', { jobId, toolChange: tc.n })
      } else if (job.phase === 'programPause')
        await ok('run.job.continue', { jobId, pause: job.pause })
    })) as { ok: boolean; value: RunSummary }
    expect(ended.ok, JSON.stringify(ended)).toBe(true)
    expect(ended.value).toMatchObject({
      setupId,
      lines: exported.lines,
      toolChanges: exported.stats.toolChanges,
      warnings: [],
    })
    setupId = ended.value.next?.setupId
    const after = (await ok<RunStatus>('run.status.get')).value
    expect(after).toMatchObject({ state: 'Idle', homed: true })
    expect(after.alarm).toBeUndefined()
    const end = programEnd(gcode)
    after.wpos.forEach((v, k) => expect(v).toBeCloseTo(end[k]!, 3))
  }
  expect(setupId).toBeUndefined()
  await ok('run.connection.close')
  // each setup's program holds only its own operations
  expect(
    programs.map((g) =>
      [...g.matchAll(/^\(((?:Facing|Pocket|Profile|Drilling)[^)]*)\)$/gm)].map((m) => m[1]),
    ),
  ).toEqual([
    ['Drilling 1, Drilling 2, Drilling 3, Drilling 4', 'Profile 2'],
    ['Facing 1', 'Pocket 1', 'Pocket 2', 'Profile 1'],
  ])
  // the top program follows the oval with arcs; the groove stays 1 mm deep
  expect(programs[1]!.match(/^G[23] /gm)?.length ?? 0).toBeGreaterThan(100)
  const grooveZ = sectionZs(programs[0]!, 'Profile 2')
  expect(Math.min(...grooveZ)).toBeCloseTo(-1, 6)

  // ── Criterion: save, close, reopen: shapes, placements and tabs unchanged ────────────────
  const file = join(dir, 'enclosure-shapes.dfyom')
  await ok('project.save', { target: file })
  const partBefore = (await ok('design.part.get', { partId })).value
  const shapesBefore = (await ok('design.shape.list', { partId })).value
  const planBefore = (await ok('plan.get', { planId, detail: 'full' })).value
  await ok('project.close', { key: created.value.key })
  const reopened = await ok<{ key: string; alreadyOpen: boolean }>('project.open', { file })
  expect(reopened.value.alreadyOpen).toBe(false)
  expect((await ok('design.part.get', { partId })).value).toEqual(partBefore)
  expect((await ok('design.shape.list', { partId })).value).toEqual(shapesBefore)
  expect((await ok('plan.get', { planId, detail: 'full' })).value).toEqual(planBefore)
  for (const [i, setup] of plan.setups.entries()) {
    const again = join(dir, `shapes-reopened-${i + 1}.nc`)
    await ok('plan.export', { planId, setupId: setup.id, target: again })
    expect(readFileSync(again, 'utf8')).toBe(programs[i])
  }

  // ── Criterion (test-only): the deviation check ───────────────────────────────────────────
  // on the saved part: agent results carry compact quantities (llm-api.md#result-size), the
  // in-process evaluation needs the exact DTOs
  const saved = expectOk(await loadArchive(nodeFs, file)).doc
  const savedPart = saved.parts[partId]!
  const deviation = await deviationCheck(
    { part: savedPart, stock: saved.snapshots[savedPart.stock] } as unknown as PartGet,
    [placed.min.x + placed.max.x, placed.min.y + placed.max.y].map((v) => v / 2) as [
      number,
      number,
    ],
    placed.min.z,
    sharp.map((w) => w.params['at'] as [number, number]),
  )
  expect(deviation.outline).toBeLessThanOrEqual(DEVIATION_LIMIT)
  expect(deviation.cavity).toBeLessThanOrEqual(DEVIATION_LIMIT)
  // the fillets of D32 round the reference's sharp step corners on purpose: there the section
  // lies inside the larger fillet's radius
  expect(deviation.fillets).toBeGreaterThan(DEVIATION_LIMIT)
  expect(deviation.fillets).toBeLessThan(1)
  return { programs, deviation, evaluation }
}

/** The evaluation criterion: the part, tabs on the imported outline included, evaluates. */
export function expectEvaluated(evaluation: FlowV03Result['evaluation']): void {
  expect(evaluation).toMatchObject({ ok: true, value: { evaluation: 'done' } })
}

/**
 * Test-only: the part (as `design.part.get` returned it) evaluated in-process with the same core
 * code the geometry worker runs, sectioned at mid-wall height, against the reference STL's section
 * there (placed as the fitted reference: its centre at `centre`, its bottom at `bottom`; the
 * profile's tabs stand below the section). Returns the two-sided distance per loop
 * (outline, cavity), leaving out points within `FILLET_ZONE` of a corner the flow filleted
 * (`filleted`, part frame), and the largest distance inside those zones. Every other loop of the
 * section is offcut (the stock's corners outside the slot) and must lie outside the outline.
 */
export async function deviationCheck(
  got: PartGet,
  centre: readonly [number, number],
  bottom: number,
  filleted: readonly (readonly [number, number])[],
): Promise<Deviation> {
  const part = expectOk(partFromDTO(got.part as unknown as PartDTO))
  const snapshot = expectOk(Snapshot.fromDTO(got.stock as unknown as SnapshotDTO))
  if (!(snapshot.values instanceof Stock)) throw new Error('stock snapshot expected')
  const region2d = nodeRegion2d()
  const input = expectOk(toGeometryInput(part, snapshot.values, region2d))
  const kernel = expectOk(await loadManifold())
  const e = expectOk(kernel.withSolids((s) => evaluatePart(input, s, undefined, region2d)))
  const soup = new Float64Array(e.indices.length * 3)
  e.indices.forEach((v, k) => {
    for (let c = 0; c < 3; c++) soup[k * 3 + c] = e.positions[v * 3 + c]!
  })
  const z = bottom + SECTION_Z
  const section = sliceMesh(soup, z)

  // the STL is centred in x/y with its bottom at z = 0 (testing.md § Fixtures)
  const stl = sliceMesh(readBinaryStl(readFileSync(ENCLOSURE_STL)), SECTION_Z).map((loop) =>
    loop.map((p) => ({ x: p.x + centre[0], y: p.y + centre[1] })),
  )
  expect(stl).toHaveLength(2)
  const [outer, inner] = [...stl].sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)))
  const inZone = (p: Pt) => filleted.some(([x, y]) => Math.hypot(p.x - x, p.y - y) <= FILLET_ZONE)
  const outsideZones = (p: Pt) => !inZone(p)
  const best = (ref: Pt[]) => {
    const scored = section.map((l) => ({ l, d: hausdorff(l, ref, outsideZones) }))
    scored.sort((a, b) => a.d - b.d)
    return scored[0]!
  }
  const o = best(outer!)
  const c = best(inner!)
  for (const l of section)
    if (l !== o.l && l !== c.l)
      for (const p of l) expect(insidePolygon(p, outer!), 'offcut inside the outline').toBe(false)
  return { outline: o.d, cavity: c.d, fillets: hausdorff(c.l, inner!, inZone) }
}

/** Around a filleted corner the deviation check leaves out (mm): the smallest end mill radius. */
const FILLET_ZONE = 3

export interface Deviation {
  /** Outline section vs the reference's (mm). */
  readonly outline: number
  /** Cavity section vs the reference's, away from the filleted corners (mm). */
  readonly cavity: number
  /** Cavity section vs the reference's at the filleted corners (mm). */
  readonly fillets: number
}

/**
 * The setup change for the top setup: G54 so the stock lies centred on the table with its
 * clearance plane 5 mm below the top of the travel, as `prepare` does for the first setup
 * (docs/modes/plan-v0.2.md#implementation-task-e2). Both setups lie flat (±z).
 */
async function zeroForSetup(
  ok: ReturnType<typeof agentSession>['ok'],
  clearance: number,
): Promise<void> {
  const travel = { x: 800, y: 800 }
  const g54 = [-travel.x / 2 - STOCK.length / 2, -travel.y / 2 - STOCK.width / 2, -5 - clearance]
  const { mpos } = (await ok<RunStatus>('run.status.get')).value
  const values = mpos.map((m, i) => m - g54[i]!)
  const set = (
    await ok<{ workZero: number[] }>('run.workZero.set', { axes: ['x', 'y', 'z'], values })
  ).value
  set.workZero.forEach((v, i) => expect(v).toBeCloseTo(g54[i]!, 3))
}

/** The longest line element of a resolved region (the cavity's flat back stretch). */
function longestLine(s: ShapeGet): { a: [number, number]; b: [number, number] } {
  const lines = s.resolved.pieces.flatMap((p) => p.outer).filter((e) => e.kind === 'line')
  const len = (e: Element) => Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])
  return lines.reduce((m, e) => (len(e) > len(m) ? e : m))
}

/** The index of a path item's vertex at `p` (shape frame): 0 = start, i = end of segment i − 1. */
function nearestVertex(s: ShapeGet, p: readonly [number, number]): number {
  const item = s.shape.items[0]!
  // a closed path's last segment ends at the start (vertex 0)
  const vertices = [item.start, ...item.segments.slice(0, -1).map((g) => g.to)].map(
    ([x, y]) => [mm(x), mm(y)] as const,
  )
  let best = 0
  vertices.forEach((v, i) => {
    const d = Math.hypot(v[0] - p[0], v[1] - p[1])
    const b = vertices[best]!
    if (d < Math.hypot(b[0] - p[0], b[1] - p[1])) best = i
  })
  const v = vertices[best]!
  expect(Math.hypot(v[0] - p[0], v[1] - p[1])).toBeLessThan(1e-3)
  return best
}

/** Z values of one operation's section of a program (from its comment to the next one). */
function sectionZs(gcode: string, operation: string): number[] {
  const from = gcode.indexOf(`(${operation})`)
  const rest = gcode.slice(from + 1)
  const to = rest.search(/^\((?:Facing|Pocket|Profile|Drilling)/m)
  const body = to < 0 ? rest : rest.slice(0, to)
  return [...body.matchAll(/Z(-?[\d.]+)/g)].map((m) => Number(m[1]))
}

function area(loop: readonly Pt[]): number {
  let a = 0
  loop.forEach((p, i) => {
    const q = loop[(i + 1) % loop.length]!
    a += p.x * q.y - q.x * p.y
  })
  return a / 2
}

function insidePolygon(p: Pt, loop: readonly Pt[]): boolean {
  let inside = false
  loop.forEach((a, i) => {
    const b = loop[(i + 1) % loop.length]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside
  })
  return inside
}

/** Largest distance from a kept vertex of either polygon to the other polygon's edges (mm). */
function hausdorff(a: readonly Pt[], b: readonly Pt[], keep: (p: Pt) => boolean): number {
  return Math.max(oneSided(a, b, keep), oneSided(b, a, keep))
}

function oneSided(from: readonly Pt[], to: readonly Pt[], keep: (p: Pt) => boolean): number {
  let worst = 0
  for (const p of from) {
    if (!keep(p)) continue
    let d = Infinity
    to.forEach((a, i) => {
      const b = to[(i + 1) % to.length]!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const l2 = dx * dx + dy * dy
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
      d = Math.min(d, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y))
    })
    worst = Math.max(worst, d)
    // early exit for the loop matching: a far loop is far
    if (worst > 50) return worst
  }
  return worst
}

/** A compact quantity's value in its canonical unit (mm): a number, or `{ source, value }`. */
const mm = (q: Exact) => (typeof q === 'number' ? q : q.value)

type Exact = number | { source: string; value: number }
interface Box {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}
interface ReferenceList {
  references: { id: string; placed: Box }[]
}
interface ShapeImport {
  shapeIds: string[]
  report: {
    size: { width: number; height: number }
    arcs: number
    maxDeviation: number
    [key: string]: unknown
  }
}
interface ShapeSummary {
  id: string
  name: string
  kind?: string
}
interface Element {
  kind: 'line' | 'arc'
  a: [number, number]
  b: [number, number]
}
interface ShapeGet {
  shape: {
    items: {
      start: [Exact, Exact]
      segments: { to: [Exact, Exact] }[]
    }[]
  }
  usedBy: string[]
  resolved: {
    kind: 'region' | 'path'
    pieces: { outer: Element[] }[]
    bounds: { min: [number, number]; max: [number, number] }
    length: number
  }
}
interface Warning {
  code: string
  operation?: string
  params: Record<string, unknown>
}
interface AddResult {
  operationId: string
  tool?: unknown
  toolLocked: boolean
  /** The part's DFM warnings as changes (llm-api.md#result-size). */
  warnings: { count: number; added?: Warning[]; changed?: Warning[]; removed?: unknown[] }
}
interface Op {
  id: string
  kind: string
  on?: string
  [key: string]: unknown
}
interface PartGet {
  part: { operations: Op[]; shapes: { id: string; name: string }[] }
  stock: unknown
}
interface PlanGet {
  plan: {
    setups: {
      id: string
      name: string
      direction?: string
      clearanceHeight: Exact
      operations: { id: string; tool: string; designOperationIds: string[] }[]
    }[]
    snapshots: { id: string; values: { name: string } }[]
  }
}
interface Finding {
  severity: string
  rule: string
  params: Record<string, unknown>
}
interface ExportResult {
  setupId: string
  lines: number
  stats: { toolChanges: number }
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
  next?: { setupId: string }
}
