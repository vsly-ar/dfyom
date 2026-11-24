// Test-only: the v0.4 exit-criteria script (task X1), run headless through the bundled CLI by
// both agent transports (exit-criteria.mcp.test.ts, exit-criteria.batch.test.ts), like the v0.3
// flow. The exit part is the enclosure lid (src/core/design/enclosure-lid.testing.ts): the SVG
// outline as an outside profile with six tabs, a Clones grid of countersunk M3 holes, a Ø 22
// cutout with a standalone chamfer on its edge (X2) and an arc of counterbored holes (then edited M3 → M4), an offset row of vent slots with
// one skipped. Every step goes through the public tools; only the geometry check at the end
// evaluates the part in-process (test-only, as the criteria say). Not app code.
// Docs: docs/plans/v0.4.md#exit-criteria, docs/conventions/testing.md#end-to-end
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import {
  BOLT_CIRCLE,
  BOLT_CIRCLE_EDITED,
  counterboreSizes,
  countersinkSizes,
  CUTOUT,
  EXPECTED,
  fastener,
  LID_PROFILE,
  LID_STOCK,
  LID_TOOLS,
  onBoard,
  SCREWS,
  VENTS,
} from '../../core/design/enclosure-lid.testing'
import { signedArea, sliceMesh, type Pt } from '../../core/design/enclosure-sections.testing'
import { toGeometryInput } from '../../core/design/geometry-input'
import { partFromDTO } from '../../core/design/operation'
import type { PartDTO } from '../../core/design/part.dto'
import type { Vec2 } from '../../core/geometry/model'
import { nodeRegion2d } from '../../core/geometry/2d/testing/node-wasm'
import { evaluatePart } from '../../core/geometry/evaluate'
import { loadManifold } from '../../core/geometry/manifold'
import { Snapshot, type SnapshotDTO } from '../../core/library/snapshot'
import { Stock } from '../../core/library/stock'
import { loadArchive } from '../persistence/archive'
import { nodeFs } from '../persistence/fs'
import { agentSession, type Call, programEnd, type RunJobStatus } from './exit-criteria.fixture'
import { ENCLOSURE_SVG } from './exit-criteria.v03.fixture'
import { withoutAppVersion } from '../../core/post/plan-export'

/**
 * The golden program of the lid's one setup (path relative to the test files). Update after an
 * intended post or generator change with `npx vitest run src/main/cli/exit-criteria -u` and
 * review the diff.
 */
export const GOLDEN_V04 = './__golden__/exit-criteria-lid.nc'

/** The call budget of the scripted flow and the largest single result (llm-api.md#result-size). */
export const CALL_BUDGET = { calls: 100, resultBytes: 64 * 1024 } as const

const sheet = (name: string, values: Record<string, string>) => ({
  name,
  materialClass: 'sheetGood',
  ...values,
})

/** Library tools (LID_TOOLS), with plywood presets (quantity strings, mm). */
const TOOLS = [
  {
    name: LID_TOOLS.profile.name,
    type: LID_TOOLS.profile.type,
    diameter: `${LID_TOOLS.profile.diameter}`,
    fluteLength: '22',
    overallLength: '60',
    fluteCount: '2',
    toolMaterial: 'carbide',
    presets: [
      sheet('Plywood', {
        spindleSpeed: '18000',
        feedRate: '4800',
        plungeRate: '800',
        stepdown: '3',
        stepover: '3',
      }),
    ],
  },
  {
    name: LID_TOOLS.mill.name,
    type: LID_TOOLS.mill.type,
    diameter: `${LID_TOOLS.mill.diameter}`,
    fluteLength: '12',
    overallLength: '38',
    fluteCount: '2',
    toolMaterial: 'carbide',
    presets: [
      sheet('Plywood', {
        spindleSpeed: '18000',
        feedRate: '3600',
        plungeRate: '300',
        stepdown: '1.5',
        stepover: '1.2',
      }),
    ],
  },
  {
    name: LID_TOOLS.chamfer.name,
    type: LID_TOOLS.chamfer.type,
    diameter: `${LID_TOOLS.chamfer.diameter}`,
    angle: `${LID_TOOLS.chamfer.angle}`,
    fluteLength: '8',
    overallLength: '50',
    fluteCount: '2',
    toolMaterial: 'carbide',
    presets: [sheet('Plywood', { spindleSpeed: '12000', feedRate: '3800', plungeRate: '600' })],
  },
] as const

/** A GRBL router; one setup on a 6 mm board, so a 100 mm Z will do. */
const MACHINE = {
  name: 'Router',
  controller: 'grbl',
  travel: { x: '800', y: '800', z: '100' },
  maxFeedRate: { x: '5000', y: '5000', z: '1000' },
  spindle: { control: 'manual', maxSpeed: '24000' },
  programUnits: 'mm',
  toolChanger: 'none',
  // the Z headroom fields (DF68): the checks run and find enough headroom
  noseToTable: '115',
  spoilboardThickness: '10',
}

/** `first` and `pattern` with `%` replaced by each of `ns`, space-separated (plan rows). */
const ids = (first: string, pattern: string, ns: readonly number[]) =>
  [first, ...ns.map((n) => pattern.replace('%', `${n}`))].join(' ')

/** A layout point (from the board's centre) as a `center` argument on the top face. */
const at = (p: Vec2): [string, string] => onBoard(p).map((c) => `${c}`) as [string, string]

export interface CallStats {
  /** Every call the flow made, polls included. */
  readonly calls: number
  /** `job.wait` and `run.status.get` calls while waiting for jobs (the run's polling). */
  readonly polls: number
  /** The largest result (value or error JSON), its tool and size in bytes. */
  readonly largest: { readonly name: string; readonly bytes: number }
  /** Bytes per tool, summed, for the report. */
  readonly bytesByTool: Readonly<Record<string, number>>
}

export interface FlowV04Result {
  /** The text `plan.export` wrote for the one setup. */
  readonly program: string
  readonly stats: CallStats
}

/**
 * Runs the v0.4 exit-criteria flow: library → project with the 255 × 200 × 6 plywood board →
 * `design.shape.import` of the v0.3 drawing, keeping the outline → outside profile with six tabs
 * (two relocate, `dfm.tabsRelocated`) → `design.fastener.list` → the countersunk M3 hole and its
 * Clones grid (`preview` first) → the Ø 22 cutout and the chamfer on its edge, the counterbored
 * M3 hole and its arc Clones →
 * the vent slot and its offset Clones, instance 4 skipped by an update → the bolt-circle source
 * M3 → M4 (one pending change; every instance follows) → plan (one setup) → toolpaths → GRBL
 * export (golden; one tool run per distinct tool but Flat 6, clone position comments) → virtual run →
 * save → close → reopen → compare → the geometry check of the evaluated part (test-only).
 */
export async function exitCriteriaV04Flow(rawCall: Call, dir: string): Promise<FlowV04Result> {
  // count calls and result sizes (the LLM-first test found huge results, llm-api.md#result-size)
  let calls = 0
  let polls = 0
  let largest = { name: '', bytes: 0 }
  const bytesByTool: Record<string, number> = {}
  const call: Call = async (name, args) => {
    const r = await rawCall(name, args)
    calls++
    if (name === 'job.wait' || name === 'run.status.get') polls++
    const bytes = Buffer.byteLength(JSON.stringify(r.ok ? (r.value ?? null) : r.error))
    bytesByTool[name] = (bytesByTool[name] ?? 0) + bytes
    if (bytes > largest.bytes) largest = { name, bytes }
    return r
  }
  const { ok, waitJob, untilLabel } = agentSession(call)

  // ── Library (app scope, no project needed) ────────────────────────────────────────────────
  const stock = (
    await ok<{ id: string }>('library.stock.add', {
      values: {
        name: 'Birch plywood 6',
        shape: 'block',
        length: `${LID_STOCK.length}`,
        width: `${LID_STOCK.width}`,
        thickness: `${LID_STOCK.thickness}`,
        material: { name: 'Birch plywood', class: LID_STOCK.materialClass },
      },
    })
  ).value.id
  const tools: Record<string, string> = {}
  for (const t of TOOLS)
    tools[t.name] = (await ok<{ id: string }>('library.tool.add', { values: t })).value.id
  const machine = (await ok<{ id: string }>('library.machine.add', { values: MACHINE })).value.id

  // ── Criterion: new project, 255 × 200 × 6 mm plywood ──────────────────────────────────────
  const created = await ok<{ key: string; revision: number }>('project.create', {
    name: 'Enclosure lid',
    unitSystem: 'mm',
  })
  const { partId } = (
    await ok<{ partId: string }>('design.part.add', {
      name: 'Lid',
      stockLibraryItemId: stock,
      expectedRevision: created.value.revision,
    })
  ).value

  // ── Criterion: import the SVG sections and keep the outline ──────────────────────────────
  const svg = (await ok<ShapeImport>('design.shape.import', { partId, path: ENCLOSURE_SVG })).value
  expect(svg.shapeIds).toEqual(['shape1', 'shape2'])
  await ok('design.shape.remove', { partId, shapeId: 'shape2' })
  const shapes = (await ok<{ shapes: ShapeSummary[] }>('design.shape.list', { partId })).value
  expect(shapes.shapes.map((s) => [s.id, s.name, s.kind])).toEqual([
    ['shape1', 'outline', 'region'],
  ])
  // the page (the STL's centre at its centre) on the board's centre, as v0.3 placed it: the
  // anchor is the centre of the outline's box, moved by the same offset
  const b = shapes.shapes[0]!.bounds!
  const outlineCentre = [0, 1].map((k) => {
    const page = k === 0 ? svg.report.size.width : svg.report.size.height
    const board = k === 0 ? LID_STOCK.length : LID_STOCK.width
    return ((b.min[k]! + b.max[k]!) / 2 + board / 2 - page / 2).toFixed(6)
  }) as [string, string]

  // ── Criterion: the outline as an outside profile with six tabs; two relocate (D42, TB1) ───
  const profile = (
    await ok<AddResult>('design.profile.add', {
      partId,
      shape: { kind: 'named', shapeId: 'shape1', center: outlineCentre },
      side: LID_PROFILE.side,
      slotWidth: `${LID_PROFILE.slotWidth}`,
      tabs: {
        count: `${LID_PROFILE.tabs.count}`,
        width: `${LID_PROFILE.tabs.width}`,
        thickness: `${LID_PROFILE.tabs.thickness}`,
      },
    })
  ).value
  const relocated = (profile.warnings.added ?? []).filter((w) => w.code === 'dfm.tabsRelocated')
  expect(relocated).toEqual([
    expect.objectContaining({
      operation: profile.operationId,
      params: expect.objectContaining({ moved: 2, count: LID_PROFILE.tabs.count }),
    }),
  ])
  expect((profile.warnings.added ?? []).map((w) => w.code)).not.toContain('dfm.tabsNoHold')

  // ── Criterion: the fastener table (design.fastener.list) ─────────────────────────────────
  const m3 = (await ok<FastenerList>('design.fastener.list', { size: SCREWS.fastener })).value
  expect(m3.rows).toHaveLength(1)
  expect(m3.rows[0]).toMatchObject({
    size: 'M3',
    clearance: { normal: fastener('M3').clearance.normal },
    countersunkHead: { source: 'ISO 10642' },
  })
  expect(m3.sources.length).toBeGreaterThan(0)

  // ── Criterion: four countersunk M3 holes: one hole feature and a Clones grid 2 × 2 ───────
  const screw = (
    await ok<FeatureResult>('design.hole.add', {
      partId,
      center: at(SCREWS.source),
      type: SCREWS.type,
      fastener: SCREWS.fastener,
      fit: SCREWS.fit,
    })
  ).value
  const grid = {
    kind: 'grid',
    cols: SCREWS.grid.columns,
    rows: SCREWS.grid.rows,
    du: `${SCREWS.grid.spacing[0]}`,
    dv: `${SCREWS.grid.spacing[1]}`,
  }
  const screwSource = { featureId: screw.featureId }
  const screwPreview = (
    await ok<ClonesPreview>('design.clones.preview', {
      partId,
      source: screwSource,
      rows: [grid],
    })
  ).value
  expectPositions(
    screwPreview.instances.map((i) => i.at),
    EXPECTED.screws,
  )
  expect(screwPreview.warnings).toEqual([])
  const screwClones = (
    await ok<FeatureResult>('design.clones.add', { partId, source: screwSource, rows: [grid] })
  ).value

  // ── Criterion: the Ø 22 cutout, a counterbored M3 hole 18 mm right, an arc Clones round it ─
  // a through opening is an inside profile whose slot covers it (cleared like a pocket, no
  // offcut, design.md § Profile): a pocket must end above the stock bottom
  const cutout = (
    await ok<AddResult>('design.profile.add', {
      partId,
      shape: { kind: 'circle', center: at(CUTOUT.centre), diameter: `${CUTOUT.diameter}` },
      side: 'inside',
      slotWidth: `${CUTOUT.diameter / 2}`,
      tabs: { count: '0' },
    })
  ).value
  // a standalone chamfer breaks the cutout's edge (X2: the criteria name no design.chamfer.* step
  // of their own): 1.5 mm × 45° (Ø 25, 90°), contoured by the chamfer mill after the cutout. Not
  // the default edge + 1 mm: 0.5 mm deep, the mill's effective diameter (1 mm) is too small for
  // its plywood feed (feeds.chipLoadHigh)
  const cutoutChamfer = (
    await ok<AddResult>('design.chamfer.add', {
      partId,
      edgeOf: cutout.operationId,
      width: `${CUTOUT.chamferWidth}`,
    })
  ).value
  const bolt = (
    await ok<FeatureResult>('design.hole.add', {
      partId,
      center: at(BOLT_CIRCLE.source),
      type: BOLT_CIRCLE.type,
      fastener: BOLT_CIRCLE.fastener,
      fit: BOLT_CIRCLE.fit,
    })
  ).value
  const arc = {
    kind: 'arc',
    radius: `${BOLT_CIRCLE.arc.radius}`,
    angle: `${BOLT_CIRCLE.arc.angle}`,
    arc: `${BOLT_CIRCLE.arc.sweep}`,
    step: `${BOLT_CIRCLE.arc.step}`,
  }
  const boltSource = { featureId: bolt.featureId }
  const boltPreview = (
    await ok<ClonesPreview>('design.clones.preview', { partId, source: boltSource, rows: [arc] })
  ).value
  expect(boltPreview.instances.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6])
  expectPositions(
    boltPreview.instances.map((i) => i.at),
    EXPECTED.boltCircle,
  )
  // a full circle closes on the source: the row's last point is marked, not cloned
  expect(boltPreview.warnings).toEqual([])
  const boltClones = (
    await ok<FeatureResult>('design.clones.add', { partId, source: boltSource, rows: [arc] })
  ).value

  // ── Criterion: a vent slot and an offset Clones of 6 more; instance 4 skipped ────────────
  const slot = (
    await ok<{ shapeId: string }>('design.shape.add', {
      partId,
      name: 'Vent slot',
      items: [
        {
          kind: 'obround',
          center: ['0', '0'],
          length: `${VENTS.length}`,
          width: `${VENTS.width}`,
        },
      ],
    })
  ).value
  const vent = (
    await ok<AddResult>('design.profile.add', {
      partId,
      shape: { kind: 'named', shapeId: slot.shapeId, center: at(VENTS.source) },
      side: 'inside',
      // covers the slot (≥ half its width) and takes the Ø 3 mill
      slotWidth: `${LID_TOOLS.mill.diameter}`,
      tabs: { count: '0' },
    })
  ).value
  const offset = {
    kind: 'offset',
    count: VENTS.offset.count,
    du: `${VENTS.offset.step[0]}`,
    dv: `${VENTS.offset.step[1]}`,
  }
  const ventSource = { operationIds: [vent.operationId] }
  const ventClones = (
    await ok<FeatureResult>('design.clones.add', { partId, source: ventSource, rows: [offset] })
  ).value
  // "clicking" instance 4: the preview of the feature says which point of the row it is
  const ventPreview = (
    await ok<ClonesPreview>('design.clones.preview', { partId, featureId: ventClones.featureId })
  ).value
  expect(ventPreview.instances.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7])
  const points = ventPreview.rows[0]!.points
  const skipIndex = points.findIndex((p) => p.n === VENTS.skip[0])
  expect(skipIndex).toBeGreaterThanOrEqual(0)
  await ok('design.clones.update', {
    partId,
    featureId: ventClones.featureId,
    rows: [{ ...offset, skip: [skipIndex] }],
  })
  const skipped = (
    await ok<ClonesPreview>('design.clones.preview', { partId, featureId: ventClones.featureId })
  ).value
  expect(skipped.instances.map((i) => i.n)).toEqual(EXPECTED.vents.map((v) => v.n))
  expectPositions(
    skipped.instances.map((i) => i.at),
    EXPECTED.vents.map((v) => v.at),
  )
  expect(skipped.rows[0]!.points[skipIndex]).toMatchObject({ kind: 'skipped' })

  // ── Criterion: the bolt-circle source M3 → M4: one pending change, all instances follow ──
  const before = (await ok<FeatureList>('design.feature.list', { partId })).value
  const ownedOf = (l: FeatureList, id: string) =>
    l.features.find((f) => f.feature.id === id)!.operationIds
  const boltOps = ownedOf(before, boltClones.featureId)
  expect(boltOps).toHaveLength(10) // 5 positions × counterbore and drill
  await ok('design.hole.update', {
    partId,
    featureId: bolt.featureId,
    fastener: BOLT_CIRCLE_EDITED,
    apply: false,
  })
  const applied = (await ok<{ changes: number }>('project.apply')).value
  expect(applied.changes).toBe(1)

  // ── The design: features, owned operations, tools ───────────────────────────────────────
  const designed = (await ok<PartGet>('design.part.get', { partId })).value
  const ops = designed.part.operations
  const byId = new Map(ops.map((o) => [o.id, o]))
  const m4 = counterboreSizes(BOLT_CIRCLE_EDITED)
  const holes = ops.filter((o) => o.kind === 'drilling')
  expect(holes).toHaveLength(10)
  // every bolt-circle instance follows the source: M4 holes and counterbores
  const ofBolt = (o: Op) => o.featureId === bolt.featureId || o.featureId === boltClones.featureId
  expect(holes.filter(ofBolt).map((o) => mm(o['diameter'] as Exact))).toEqual(
    Array(6).fill(m4.diameter),
  )
  const counterbores = ops.filter((o) => o.kind === 'pocket' && ofBolt(o))
  expect(counterbores.map((o) => mm((o['shape'] as { diameter: Exact }).diameter))).toEqual(
    Array(6).fill(m4.cbDiameter),
  )
  const chamfers = ops.filter((o) => o.kind === 'chamfer' && o.id !== cutoutChamfer.operationId)
  const cs = countersinkSizes(SCREWS.fastener)
  // D45: a chamfer stores its width, (csDiameter − Ø) / 2 for a countersink
  expect(chamfers.map((o) => mm(o['width'] as Exact))).toEqual(
    Array(4).fill(expect.closeTo((cs.csDiameter - cs.diameter) / 2, 9)),
  )
  expect(byId.get(cutoutChamfer.operationId)).toMatchObject({
    kind: 'chamfer',
    edgeOf: cutout.operationId,
  })
  expect(mm(byId.get(cutoutChamfer.operationId)!['width'] as Exact)).toBe(CUTOUT.chamferWidth)
  const features = (await ok<FeatureList>('design.feature.list', { partId })).value
  // the instances keep their ids through the edit
  expect(ownedOf(features, boltClones.featureId)).toEqual(boltOps)
  expect(features.features.map((f) => [f.feature.id, f.feature.kind])).toEqual([
    [screw.featureId, 'hole'],
    [screwClones.featureId, 'clones'],
    [bolt.featureId, 'hole'],
    [boltClones.featureId, 'clones'],
    [ventClones.featureId, 'clones'],
  ])
  expect(byId.get(cutout.operationId)).toMatchObject({ kind: 'profile', side: 'inside' })
  const designWarnings = (await ok<{ warnings: Warning[] }>('design.warning.list', { partId }))
    .value.warnings
  expect(designWarnings.map((w) => w.code)).toContain('dfm.tabsRelocated')

  // ── Criterion: plan derives one setup; toolpaths ─────────────────────────────────────────
  const createdPlan = (
    await ok<{ planId: string; setupIds: string[] }>('plan.create', {
      partId,
      machineLibraryItemId: machine,
    })
  ).value
  const planId = createdPlan.planId
  const { plan } = (await ok<PlanSummary>('plan.get', { planId })).value
  expect(plan.setups).toHaveLength(1)
  const setup = plan.setups[0]!
  const planned = setup.operations.map((o) => [o.kind, o.tool, o.designOperationIds.join(' ')])
  // tool by tool (plan-v0.4.md § Machining order v2): the fewest tool runs, each by kind group,
  // and across the clone instances (D34) every instance of one source operation shares the
  // source's tool; equal holes and equal countersinks share one plan operation, so the chamfer
  // mill cuts all four countersinks in one go. The counterbores take their hole's Flat 3
  // (design-v0.4.md § Counterbore tool); the outline frees the part, so it is cut last, after
  // the cutout and vents inside it. The cutout's chamfer follows the cutout (its edge), so the
  // fewest runs cut the cutout with Flat 6 before the chamfer mill's run and come back to Flat 6
  // for the outline: one Flat 6 run more than without it (X2)
  expect(planned).toEqual([
    ['drilling', 'Flat 3', ids('hole1_drill', 'clones1_%_hole1_drill', [2, 3, 4])],
    ...[1, 2, 3, 4, 5, 6].map((n) => [
      'pocket',
      'Flat 3',
      n === 1 ? 'hole2_counterbore' : `clones2_${n}_hole2_counterbore`,
    ]),
    ['drilling', 'Flat 3', ids('hole2_drill', 'clones2_%_hole2_drill', [2, 3, 4, 5, 6])],
    ...EXPECTED.vents.map((v) => [
      'profile',
      'Flat 3',
      v.n === 1 ? vent.operationId : `${ventClones.featureId}_${v.n}_${vent.operationId}`,
    ]),
    ['profile', 'Flat 6', cutout.operationId],
    [
      'chamfer',
      'Chamfer 90 × 12',
      ids('hole1_countersink', 'clones1_%_hole1_countersink', [2, 3, 4]),
    ],
    ['chamfer', 'Chamfer 90 × 12', cutoutChamfer.operationId],
    ['profile', 'Flat 6', profile.operationId],
  ])
  // one tool run per distinct tool but Flat 6 (cutout, outline): Flat 3 → Flat 6 → chamfer mill →
  // Flat 6
  const toolRuns = planned.map((o) => o[1]).filter((t, i, a) => i === 0 || t !== a[i - 1])
  expect(toolRuns).toEqual([
    LID_TOOLS.mill.name,
    LID_TOOLS.profile.name,
    LID_TOOLS.chamfer.name,
    LID_TOOLS.profile.name,
  ])
  // DF39/Q57: Flat 3 has calculator data (the ≤ 3 mm band, Amana 1/16″ in MDF: .003–.005″); the
  // preset's 3600 mm/min at 18,000 rpm, 2 flutes (fz 0.1 mm) sits in the range's middle, so the
  // lid's plan has no roughing feeds findings (nor any other). DF74: Flat 6's two profiles
  // finish 0.2 mm in plywood at 18,000 rpm; the finishing feed that keeps the preset's chip load
  // is held at the router's 5000 mm/min, which leaves 0.05 mm chips (under half the 0.127 mm
  // minimum): a true finishing-rub warning per profile
  const findings = (
    await ok<{ warnings: Finding[] }>('plan.warning.list', { planId, detail: 'full' })
  ).value
  expect(
    findings.warnings.map((f) => [
      f.severity,
      f.rule,
      Math.round(Number(f.params['chipLoad']) * 1000),
    ]),
  ).toEqual([
    ['warning', 'finishRubbing', 50],
    ['warning', 'finishRubbing', 50],
  ])

  const gen = await ok<{ jobId: string }>('plan.toolpath.generate', { planId })
  const generated = (await waitJob(gen.value.jobId)) as {
    ok: boolean
    value: { operations: { status: string }[] }
  }
  expect(generated.ok, JSON.stringify(generated)).toBe(true)
  expect(generated.value.operations.every((o) => o.status === 'generated')).toBe(true)

  // ── Criterion: export (golden), one tool change per distinct tool, clone comments ────────
  await ok('run.connection.open', { target: 'virtual', planId, timeScale: 'max', prepare: true })
  const target = join(dir, 'lid.nc')
  const exported = (await ok<ExportResult>('plan.export', { planId, setupId: setup.id, target }))
    .value
  expect(exported).toMatchObject({
    setupId: setup.id,
    softLimitChecked: true,
    warnings: [],
    regenerated: [],
  })
  const program = readFileSync(target, 'utf8')
  await expect(withoutAppVersion(program)).toMatchFileSnapshot(GOLDEN_V04)
  expect(program.split('\n').filter((l) => l !== '')).toHaveLength(exported.lines)
  expect(program.trimEnd().endsWith('M30')).toBe(true)
  // the first tool is loaded at the start, then one change per tool run of the plan (see above)
  expect(exported.stats.toolChanges).toBe(toolRuns.length - 1)
  expect(exported.stats.toolChanges).toBe(3)
  // the program names each clone position: the screws' grid, the bolt circle, the vents
  const comments = new Set([...program.matchAll(/^\((Clones \d+ #\d+)\)$/gm)].map((m) => m[1]))
  for (const n of [1, 2, 3, 4]) expect(comments).toContain(`Clones 1 #${n}`)
  for (const n of [1, 2, 3, 4, 5, 6]) expect(comments).toContain(`Clones 2 #${n}`)
  for (const v of EXPECTED.vents) expect(comments).toContain(`Clones 3 #${v.n}`)
  expect(comments).not.toContain('Clones 3 #4')

  // ── Criterion: run on the virtual machine ────────────────────────────────────────────────
  const run = await ok<{ jobId: string }>('run.job.start', { planId, setupId: setup.id })
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
    setupId: setup.id,
    lines: exported.lines,
    toolChanges: exported.stats.toolChanges,
    warnings: [],
  })
  const after = (await ok<RunStatus>('run.status.get')).value
  expect(after).toMatchObject({ state: 'Idle', homed: true })
  expect(after.alarm).toBeUndefined()
  const end = programEnd(program)
  after.wpos.forEach((v, k) => expect(v).toBeCloseTo(end[k]!, 3))
  await ok('run.connection.close')

  // ── Criterion: save, close, reopen: features, clone rows, skips and ids unchanged ────────
  const file = join(dir, 'enclosure-lid.dfyom')
  await ok('project.save', { target: file })
  const partBefore = (await ok('design.part.get', { partId })).value
  const featuresBefore = (await ok('design.feature.list', { partId })).value
  await ok('project.close', { key: created.value.key })
  const reopened = await ok<{ key: string; alreadyOpen: boolean }>('project.open', { file })
  expect(reopened.value.alreadyOpen).toBe(false)
  expect((await ok('design.part.get', { partId })).value).toEqual(partBefore)
  expect((await ok('design.feature.list', { partId })).value).toEqual(featuresBefore)
  const again = join(dir, 'lid-reopened.nc')
  await ok('plan.export', { planId, setupId: setup.id, target: again })
  expect(readFileSync(again, 'utf8')).toBe(program)

  // ── Criterion (test-only): the geometry check of the evaluated part ──────────────────────
  // on the saved part: agent results carry compact quantities, the evaluation needs exact DTOs
  const saved = expectOk(await loadArchive(nodeFs, file)).doc
  const savedPart = saved.parts[partId]!
  await geometryCheck(savedPart as unknown as PartDTO, saved.snapshots[savedPart.stock])

  return { program, stats: { calls, polls, largest, bytesByTool } }
}

/** Positions (face frame) against layout points (from the centre), same order, within 0.01 mm. */
function expectPositions(got: readonly Vec2[], want: readonly (readonly [number, number])[]) {
  expect(got).toHaveLength(want.length)
  got.forEach((p, k) => {
    const w = onBoard(want[k] as Vec2)
    expect(Math.abs(p[0] - w[0]), `u of ${k}`).toBeLessThanOrEqual(0.01)
    expect(Math.abs(p[1] - w[1]), `v of ${k}`).toBeLessThanOrEqual(0.01)
  })
}

/** Position tolerance of the geometry check (mm, the criteria's). */
const POSITION_TOL = 0.01

/**
 * Test-only: the saved part evaluated in-process with the core code the geometry worker runs,
 * sectioned just below the top face and at mid-thickness. The loops through the board (not the
 * outline's) are matched to the expected holes, cutout and slots by centre (within 0.01 mm) and
 * by the diameter of a circle of equal area (the mesh facets a circle: within 2 %).
 * Below the face: 4 cones (countersink diameter at that depth), 6 counterbores (M4), the cutout's
 * chamfer (its diameter at that depth),
 * 6 slots; at mid-thickness: 4 Ø 3.4 and 6 Ø 4.5 holes under the cones and counterbores.
 */
async function geometryCheck(dto: PartDTO, stockDto: unknown): Promise<void> {
  const part = expectOk(partFromDTO(dto))
  const snapshot = expectOk(Snapshot.fromDTO(stockDto as SnapshotDTO))
  if (!(snapshot.values instanceof Stock)) throw new Error('stock snapshot expected')
  const region2d = nodeRegion2d()
  const input = expectOk(toGeometryInput(part, snapshot.values, region2d))
  const kernel = expectOk(await loadManifold())
  const e = expectOk(kernel.withSolids((s) => evaluatePart(input, s, undefined, region2d)))
  const soup = new Float64Array(e.indices.length * 3)
  e.indices.forEach((v, k) => {
    for (let c = 0; c < 3; c++) soup[k * 3 + c] = e.positions[v * 3 + c]!
  })

  const cs = countersinkSizes(SCREWS.fastener)
  const m3 = countersinkSizes(SCREWS.fastener).diameter
  const m4 = counterboreSizes(BOLT_CIRCLE_EDITED)
  const near = 0.5
  // the part's top face is z = 0
  const top = sectionHoles(sliceMesh(soup, -near))
  const mid = sectionHoles(sliceMesh(soup, -m4.cbDepth - 0.5))
  const slotDiameter = Math.sqrt(
    (4 * (VENTS.width * (VENTS.length - VENTS.width) + (Math.PI * VENTS.width ** 2) / 4)) / Math.PI,
  )
  const expected = (screwD: number, boltD: number, cutoutD: number) => [
    ...EXPECTED.screws.map((p) => ({ at: p, d: screwD })),
    ...EXPECTED.boltCircle.map((p) => ({ at: p, d: boltD })),
    { at: EXPECTED.cutout, d: cutoutD },
    ...EXPECTED.vents.map((v) => ({ at: v.at, d: slotDiameter })),
  ]
  const check = (got: Hole[], want: { at: readonly [number, number]; d: number }[]) => {
    expect(got).toHaveLength(want.length)
    for (const w of want) {
      const p = onBoard(w.at as Vec2)
      const h = got.find((g) => Math.hypot(g.c[0] - p[0], g.c[1] - p[1]) <= POSITION_TOL)
      expect(h, `a hole at ${JSON.stringify(w.at)}`).toBeDefined()
      expect(h!.d / w.d).toBeGreaterThan(0.98)
      expect(h!.d / w.d).toBeLessThan(1.001)
    }
  }
  // 10 screw holes: 4 with cones (Ø at 0.5 mm deep), 6 with counterbores; the cutout's chamfer
  // (90°, Ø at 0.5 mm deep)
  check(
    top,
    expected(
      cs.csDiameter - 2 * near * Math.tan(((cs.csAngle / 2) * Math.PI) / 180),
      m4.cbDiameter,
      CUTOUT.chamfer - 2 * near,
    ),
  )
  check(mid, expected(m3, m4.diameter, CUTOUT.diameter))
}

interface Hole {
  /** Centre of area (part x, y). */
  readonly c: Vec2
  /** Diameter of the circle with the same area. */
  readonly d: number
}

/**
 * The section's loops within the layout's span (|u| ≤ 100, |v| ≤ 60 from the centre: every hole,
 * the cutout and the slots; not the outline's slot, which reaches ±124.75 × ±88.5 and splits
 * between the tabs in their height) and smaller than twice the cutout.
 */
function sectionHoles(loops: Pt[][]): Hole[] {
  const limit = 2 * Math.PI * (CUTOUT.diameter / 2) ** 2
  const centre = onBoard([0, 0])
  return loops
    .map((l) => ({ c: centroid(l), a: Math.abs(signedArea(l)) }))
    .filter(
      ({ c, a }) =>
        a < limit && Math.abs(c[0] - centre[0]) <= 100 && Math.abs(c[1] - centre[1]) <= 60,
    )
    .map(({ c, a }) => ({ c, d: Math.sqrt((4 * a) / Math.PI) }))
}

function centroid(loop: readonly Pt[]): Vec2 {
  let a = 0
  let cx = 0
  let cy = 0
  loop.forEach((p, i) => {
    const q = loop[(i + 1) % loop.length]!
    const w = p.x * q.y - q.x * p.y
    a += w
    cx += (p.x + q.x) * w
    cy += (p.y + q.y) * w
  })
  return [cx / (3 * a), cy / (3 * a)]
}

/** A compact quantity's value in its canonical unit (mm): a number, or `{ source, value }`. */
const mm = (q: Exact) => (typeof q === 'number' ? q : q.value)

type Exact = number | { source: string; value: number }
interface ShapeImport {
  shapeIds: string[]
  report: { size: { width: number; height: number } }
}
interface ShapeSummary {
  id: string
  name: string
  kind?: string
  bounds?: { min: [number, number]; max: [number, number] }
}
interface Warning {
  code: string
  operation?: string
  params: Record<string, unknown>
}
interface AddResult {
  operationId: string
  warnings: { count: number; added?: Warning[]; changed?: Warning[]; removed?: unknown[] }
}
interface FeatureResult {
  featureId: string
  operationIds: string[]
}
interface FeatureList {
  features: { feature: { id: string; kind: string }; operationIds: string[] }[]
}
interface FastenerList {
  rows: { size: string }[]
  sources: unknown[]
}
interface ClonesPreview {
  instances: { n: number; at: Vec2 }[]
  rows: { points: { at: Vec2; kind: string; n?: number }[] }[]
  warnings: Warning[]
}
interface Op {
  id: string
  kind: string
  featureId?: string
  [key: string]: unknown
}
interface PartGet {
  part: { operations: Op[] }
}
interface PlanSummary {
  plan: {
    setups: {
      id: string
      operations: { id: string; kind: string; tool: string; designOperationIds: string[] }[]
    }[]
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
  wpos: number[]
  alarm?: unknown
}
interface RunSummary {
  setupId: string
  lines: number
  toolChanges: number
}
