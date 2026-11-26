// Test-only: the v0.4-llm-first exit-criteria script (task X1), run headless through the bundled
// CLI by both agent transports (exit-criteria.mcp.test.ts, exit-criteria.batch.test.ts). The exit
// part is the black-box test's enclosure base (src/core/design/enclosure-exit.testing.ts, X0): its
// STL in a 250 × 200 × 40 hardwood block, rebuilt only from what the reference tools return, held
// by four toe clamps on both setups, checked by an independent G-code oracle and the deviation
// job. Not app code.
// Docs: docs/plans/v0.4-llm-first.md#exit-criteria, docs/conventions/testing.md#end-to-end
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import {
  EXIT_CLAMP_REACH,
  EXIT_CLAMPS,
  EXIT_FINDINGS,
  EXIT_HOLES,
  EXIT_LEVELS,
  EXIT_MARGIN,
  EXIT_PLACED,
  EXIT_SECTIONS,
  EXIT_STOCK,
} from '../../core/design/enclosure-exit.testing'
import { gcodeClearance, type OracleBox } from '../../core/plan/workholding/gcode-oracle.testing'
import { withoutAppVersion } from '../../core/post/plan-export'
import { parseGcode } from '../../core/toolpath/testing/gcode'
import { agentSession, type Call, type CallResult } from './exit-criteria.fixture'
import { ENCLOSURE_STL } from './exit-criteria.v02.fixture'

/**
 * The golden programs of the two setups in machining order (paths relative to the test files).
 * Update after an intended post or generator change with
 * `npx vitest run src/main/cli/exit-criteria -u` and review the diff.
 */
export const GOLDEN_LLM_FIRST = [
  './__golden__/exit-criteria-llm-first-1-bottom.nc',
  './__golden__/exit-criteria-llm-first-2-top.nc',
] as const

/** The exit numbers (plans/v0.4-llm-first.md § Exit criteria, Q44). */
export const EXIT_NUMBERS = {
  /** Tool calls of the scripted flow, every call counted (job waits too). */
  calls: 100,
  /** The largest single result, bytes. */
  resultBytes: 64 * 1024,
  /** |deviation| outside the edge band, per face, mm. */
  p95: 0.05,
  p99: 0.1,
  /** Every region deeper than this has a cause, mm. */
  explainOver: 0.5,
  /** The G-code oracle's gap to every clamp, mm. */
  clampClearance: 2,
} as const

const hardwood = (name: string, values: Record<string, string>) => ({
  name,
  materialClass: 'hardwood',
  ...values,
})

/**
 * Library tools: the black-box test's long 6 mm flat (45 mm flutes: the 34.8 mm cavity and the
 * 40 mm outline), a 2 mm flat that bores the foot holes flat-bottomed (a pointed drill's point
 * would break through the 0.241 mm web under the cavity floor, X0 finding 1) and an 82° chamfer
 * mill for their countersinks. Hardwood presets (quantity strings, mm), chip loads inside the
 * calculator's range (no `feeds.*` findings).
 */
export const TOOLS = [
  {
    name: 'Long flat 6',
    type: 'flatEndMill',
    diameter: '6',
    fluteLength: '45',
    overallLength: '80',
    fluteCount: '2',
    toolMaterial: 'carbide',
    presets: [
      hardwood('Hardwood', {
        spindleSpeed: '18000',
        feedRate: '3200',
        plungeRate: '600',
        stepdown: '4',
        stepover: '3',
      }),
    ],
  },
  {
    name: 'Flat 2',
    type: 'flatEndMill',
    diameter: '2',
    fluteLength: '8',
    overallLength: '50',
    fluteCount: '2',
    toolMaterial: 'carbide',
    presets: [
      hardwood('Hardwood', {
        spindleSpeed: '20000',
        feedRate: '2100',
        plungeRate: '300',
        stepdown: '0.5',
        stepover: '0.8',
      }),
    ],
  },
  {
    name: 'Chamfer 82',
    type: 'chamferMill',
    diameter: '12',
    angle: '82',
    fluteLength: '8',
    overallLength: '50',
    fluteCount: '2',
    toolMaterial: 'carbide',
    presets: [hardwood('Hardwood', { spindleSpeed: '12000', feedRate: '2000', plungeRate: '400' })],
  },
] as const

/** A GRBL router with room for the 40 mm block, the 25 mm clamps and the long tool. */
export const MACHINE = {
  name: 'Router',
  controller: 'grbl',
  travel: { x: '800', y: '800', z: '200' },
  maxFeedRate: { x: '5000', y: '5000', z: '1000' },
  spindle: { control: 'manual', maxSpeed: '24000' },
  programUnits: 'mm',
  toolChanger: 'none',
  noseToTable: '215',
  spoilboardThickness: '15',
}

/**
 * The agent's own choices, not dimensions of the part: the outline's tabs (8 mm up from the part's
 * bottom, 1 mm above the stock bottom, so 3.8 mm stay above the 5.185 mm bottom steps that cut
 * through their lower part). Every other design value comes from a tool result.
 */
const TABS = { count: '4', width: '8', thickness: '8' } as const

export interface CallStats {
  /** Every call the flow made, job waits included. */
  readonly calls: number
  /** `job.wait` calls (toolpaths, the runs, the compare jobs). */
  readonly waits: number
  /** The largest result (value or error JSON): its tool and size in bytes. */
  readonly largest: { readonly name: string; readonly bytes: number }
  /** Calls per tool. */
  readonly byTool: Readonly<Record<string, number>>
}

/** Wraps a transport's call: counts calls and result sizes (llm-api.md#result-size). */
function countingCall(rawCall: Call): { call: Call; stats: () => CallStats } {
  let calls = 0
  let largest = { name: '', bytes: 0 }
  const byTool: Record<string, number> = {}
  const call: Call = async (name, args) => {
    const r: CallResult = await rawCall(name, args)
    calls++
    byTool[name] = (byTool[name] ?? 0) + 1
    const bytes = Buffer.byteLength(JSON.stringify(r.ok ? (r.value ?? null) : r.error))
    if (bytes > largest.bytes) largest = { name, bytes }
    return r
  }
  const stats = () => ({ calls, waits: byTool['job.wait'] ?? 0, largest, byTool: { ...byTool } })
  return { call, stats }
}

/** What the flow measured against the exit numbers, for the plan's record. */
export interface FlowLlmFirstResult {
  /** The text `plan.export` wrote for each setup, in machining order. */
  readonly programs: readonly string[]
  readonly stats: CallStats
  /** The oracle's smallest gap to a clamp per program (mm, 0.001). */
  readonly clearance: readonly number[]
  /** `design.reference.compare { source: plan }` per face: p95, p99 (mm); unexplained regions. */
  readonly deviation: {
    readonly faces: readonly { face: string; p95: number; p99: number; max: number }[]
    readonly regions: number
    readonly unexplained: number
  }
  /** `design.reference.compare { source: part }`: regions over the threshold, largest gaps. */
  readonly partDeviation: { regions: number; maxMissing: number; maxExtra: number }
}

/** Every number in a result (numbers and quantity strings such as "36.469 mm"), mm. */
function numbersIn(v: unknown, into: Set<number>): Set<number> {
  if (typeof v === 'number') into.add(Math.round(v * 1000) / 1000)
  else if (typeof v === 'string') {
    const m = /^(-?[\d.]+)\s*(mm|°)?$/.exec(v)
    if (m !== null) into.add(Math.round(Number(m[1]) * 1000) / 1000)
  } else if (Array.isArray(v)) for (const x of v) numbersIn(x, into)
  else if (typeof v === 'object' && v !== null)
    for (const x of Object.values(v as object)) numbersIn(x, into)
  return into
}

/**
 * Runs the v0.4-llm-first exit-criteria flow as an agent would, using only values the tools
 * return: library → project with the 250 × 200 × 40 hardwood block → the STL as reference
 * (default fit) → `design.reference.find` levels (both sides), holes from both faces and the
 * sections of the bottom steps → the outline and the cavity from a top section, the outline from
 * a bottom one (`design.shape.import { from }`) → cavity pocket, outline profile with tabs, the
 * bottom facing, the two steps as blind outside profiles of inward offsets of the outline, the
 * four countersunk holes as suggested (on the facing's floor) with their Clones grid → plan (two
 * setups) → toolpaths → `auto: 'toeClamps'` on the first setup, `copyFrom` on the second →
 * toolpaths → no error findings, no collision → export both (goldens), the G-code oracle and the
 * depths → virtual run of both setups as `job.wait` says → deviation from the plan and from the
 * part → save. The test asserts the exit numbers on the result.
 */
export async function exitCriteriaLlmFirstFlow(
  rawCall: Call,
  dir: string,
): Promise<FlowLlmFirstResult> {
  const counted = countingCall(rawCall)
  const { ok, waitJob } = agentSession(counted.call)
  /** Every number the reference tools returned (find results, section imports). */
  const fromTools = new Set<number>()
  /** Values the script derived from those numbers (with the numbers they came from). */
  const derived = new Map<number, number[]>()
  /** The args of every design call, checked against `fromTools` at the end. */
  const designArgs: { name: string; args: Record<string, unknown> }[] = []
  const design = async <T>(name: string, args: Record<string, unknown>) => {
    designArgs.push({ name, args })
    return (await ok<T>(name, args)).value
  }

  // ── Library ──────────────────────────────────────────────────────────────────────────────
  const stock = (await ok<{ id: string }>('library.stock.add', { values: EXIT_STOCK })).value.id
  for (const t of TOOLS) await ok('library.tool.add', { values: t })
  const machine = (await ok<{ id: string }>('library.machine.add', { values: MACHINE })).value.id

  // ── Criterion: stock and reference ───────────────────────────────────────────────────────
  const created = await ok<{ key: string; revision: number }>('project.create', {
    name: 'Enclosure base',
    unitSystem: 'mm',
  })
  const { partId } = (
    await ok<{ partId: string }>('design.part.add', {
      name: 'Base',
      stockLibraryItemId: stock,
      expectedRevision: created.value.revision,
    })
  ).value
  const imported = (
    await ok<{ placed: Box3 }>('design.reference.import', {
      partId,
      path: ENCLOSURE_STL,
      sourceUnit: 'mm',
    })
  ).value
  // the default fit: centred, top on the stock top (X0's placement)
  for (const k of ['min', 'max'] as const)
    for (const a of ['x', 'y', 'z'] as const)
      expect(imported.placed[k][a]).toBeCloseTo(EXIT_PLACED[k][a], 3)

  const find = async <T>(args: object) => {
    const v = (await ok<T>('design.reference.find', { partId, ...args })).value
    numbersIn(v, fromTools)
    return v
  }

  // ── Criterion: levels from the top and the bottom (one call, both sides) ────────────────
  const { levels } = await find<Levels>({ kind: 'levels' })
  expect(levels.map((l) => [l.depth, l.facing, l.depthFromOpposite])).toEqual(
    EXIT_LEVELS.map((l) => [l.depth, l.facing, l.depthFromOpposite]),
  )
  const fromTop = levels.filter((l) => l.facing === 'face')
  const fromBottom = levels
    .filter((l) => l.facing === 'opposite')
    .sort((a, b) => a.depthFromOpposite! - b.depthFromOpposite!)
  // the deepest floor seen from the top is the cavity's; the shallowest from the bottom is the
  // part's bottom (the facing); the stock thickness is a level's depth from both faces
  const cavityFloor = Math.max(...fromTop.map((l) => l.depth))
  const facingDepth = fromBottom[0]!.depthFromOpposite!
  const thickness = fromBottom[0]!.depth + facingDepth
  derived.set(thickness, [fromBottom[0]!.depth, facingDepth])

  // ── Criterion: holes from both faces (none from the top; four countersunk from the bottom)
  const topHoles = await find<Holes>({ kind: 'holes' })
  expect(topHoles.holeCount).toBe(EXIT_HOLES.top.holeCount)
  const holes = await find<Holes>({ kind: 'holes', face: 'stock.bottom' })
  expect(holes.holeCount).toBe(EXIT_HOLES.bottom.holeCount)
  expect(holes.groups).toHaveLength(1)
  const group = holes.groups[0]!
  expect(group.size).toMatchObject({
    diameter: EXIT_HOLES.bottom.group.size.diameter,
    depth: EXIT_HOLES.bottom.group.size.depth,
    top: EXIT_HOLES.bottom.group.size.top,
    mouth: EXIT_HOLES.bottom.group.size.mouth,
  })
  expect(group.holes).toEqual(EXIT_HOLES.bottom.group.holes)
  expect(group.suggest.note).toBe(EXIT_HOLES.bottom.note)
  // the steps from the bottom: every level but the facing and the holes' flat ends
  const steps = fromBottom
    .slice(1)
    .map((l) => l.depthFromOpposite!)
    .filter((d) => d !== group.size.depth)

  // ── Criterion: the bottom steps' sections, each in the middle of its band ───────────────
  const mid = (a: number, b: number) => {
    const m = Math.round(((a + b) / 2) * 1000) / 1000
    derived.set(m, [a, b])
    return m
  }
  const section = (face: string, depth: number) =>
    find<Section>({ kind: 'section', face, depth: String(depth) })
  const bottomDepths = [facingDepth, ...steps]
  const stepLoops: Loop[] = []
  for (let k = 0; k < steps.length; k++) {
    const lo = bottomDepths[k]!
    const next = fromBottom.find((l) => l.depthFromOpposite! > lo)!.depthFromOpposite!
    const depth = mid(lo, next)
    const s = await section('stock.bottom', depth)
    const expected = EXIT_SECTIONS.find((e) => e.face === 'stock.bottom' && e.depth === depth)
    expect(expected, `X0 has the section at ${depth}`).toBeDefined()
    stepLoops.push(s.loops.find((l) => l.role === 'outer')!)
    expect(stepLoops[k]!.bounds).toEqual(expected!.loops.find((l) => l.role === 'outer')!.bounds)
  }
  // the outline from the bottom, in the wall band (between the rim's underside and the top)
  const outlineDepth = mid(steps.at(-1)!, thickness)
  const outlineLoop = (await section('stock.bottom', outlineDepth)).loops.find(
    (l) => l.role === 'outer',
  )!

  // ── Criterion: outline and cavity by section → shape ─────────────────────────────────────
  const shapeFrom = async (from: Record<string, unknown>) => {
    designArgs.push({ name: 'design.shape.import', args: from })
    const v = (await ok<Imported>('design.shape.import', { partId, from })).value
    numbersIn(v.section, fromTools)
    return v
  }
  const topBand = mid(0, cavityFloor)
  const outline = await shapeFrom({ depth: String(topBand), loops: 'outer' })
  const cavity = await shapeFrom({ depth: String(topBand), loops: 'holes' })
  const outlineBelow = await shapeFrom({
    face: 'stock.bottom',
    depth: String(outlineDepth),
    loops: 'outer',
  })
  expect(cavity.section.shapes[0]!.sharpCount).toBe(2)

  /** A section-made shape at its `placeAt` (moved by `inset` for an inward offset of it). */
  const placed = (r: Imported, shapeId = r.shapeIds[0]!, inset = 0) => {
    const at = r.section.shapes[0]!.placeAt
    const center = at.center.map((c) => {
      const v = Math.round((c + inset) * 1000) / 1000
      if (inset !== 0) derived.set(v, [c, inset])
      return String(v)
    })
    return { shape: { kind: 'named', shapeId, center }, anchor: at.anchor }
  }

  // ── Top: the cavity pocket, the outline as an outside profile with tabs ────────────────
  const pocket = await design<AddResult>('design.pocket.add', {
    partId,
    ...placed(cavity),
    depth: String(cavityFloor),
  })
  const profile = await design<AddResult>('design.profile.add', {
    partId,
    side: 'outside',
    ...placed(outline),
    tabs: TABS,
  })

  // ── Bottom: the facing, the steps as partial-depth outside profiles of offset items ────
  const facing = await design<AddResult>('design.facing.add', {
    partId,
    on: 'stock.bottom',
    depth: String(facingDepth),
  })
  const stepOps: AddResult[] = []
  for (const [k, loop] of stepLoops.entries()) {
    // the step's inset from the outline: the mean gap of the four sides of their bounds
    const gaps = [
      loop.bounds[0][0] - outlineLoop.bounds[0][0],
      loop.bounds[0][1] - outlineLoop.bounds[0][1],
      outlineLoop.bounds[1][0] - loop.bounds[1][0],
      outlineLoop.bounds[1][1] - loop.bounds[1][1],
    ]
    const inset = Math.round((gaps.reduce((a, b) => a + b, 0) / 4) * 1000) / 1000
    derived.set(inset, [...loop.bounds.flat(), ...outlineLoop.bounds.flat()])
    const offset = await design<{ shapeId: string }>('design.shape.add', {
      partId,
      name: `Step ${k + 1}`,
      items: [
        {
          kind: 'offset',
          op: 'add',
          shapeId: outlineBelow.shapeIds[0],
          distance: String(inset),
          direction: 'inward',
        },
      ],
    })
    const step = await design<AddResult>('design.profile.add', {
      partId,
      side: 'outside',
      on: 'stock.bottom',
      ...placed(outlineBelow, offset.shapeId, inset),
      depth: String(steps[k]),
    })
    // the offset item lands on the step's loop (its placed box) within 0.01 mm
    step.placed.min.forEach((v, i) => expect(Math.abs(v - loop.bounds[0][i]!)).toBeLessThan(0.01))
    step.placed.max.forEach((v, i) => expect(Math.abs(v - loop.bounds[1][i]!)).toBeLessThan(0.01))
    stepOps.push(step)
  }

  // ── Criterion: the four holes as countersunk hole features at the detected sizes ────────
  // the suggestion as it is, but `on` the facing's floor: the mouth is 1 mm under the stock
  // bottom (`belowFace`), the depths are from it
  const suggest = group.suggest
  expect(suggest.command).toBe('design.hole.add')
  expect(suggest.args).toMatchObject({ type: 'countersink', bottom: 'flat' })
  const hole = await design<{ featureId: string }>(suggest.command, {
    partId,
    ...suggest.args,
    on: `${facing.operationId}.floor`,
  })
  await design('design.clones.add', {
    partId,
    source: { featureId: hole.featureId },
    rows: suggest.clones!.rows,
  })
  const warnings = (await ok<{ warnings: Finding[] }>('design.warning.list', { partId })).value
  expect(warnings.warnings.filter((w) => w.severity === 'error')).toEqual([])

  // ── The script's values: each read from the reference tools (or derived from them) ──────
  const part = (await ok<PartGet>('design.part.get', { partId })).value.part
  const ops = new Map(part.operations.map((o) => [o.id, o]))
  // X0's values (EXIT_LEVELS, EXIT_HOLES): the cavity floor, the facing, the two steps, the holes
  expect(ops.get(pocket.operationId)).toMatchObject({ depth: 34.815 })
  expect(ops.get(facing.operationId)).toMatchObject({ depth: 1 })
  expect(stepOps.map((o) => ops.get(o.operationId)!['depth'])).toEqual([2.771, 5.185])
  const drills = part.operations.filter((o) => o.kind === 'drilling')
  expect(drills.map((o) => [o['center'], o['diameter'], o['bottom'], o['depth'], o['on']])).toEqual(
    EXIT_HOLES.bottom.group.holes.map((c) => [
      c,
      EXIT_HOLES.bottom.group.size.diameter,
      'flat',
      EXIT_HOLES.bottom.group.size.depth - EXIT_HOLES.bottom.group.size.top,
      `${facing.operationId}.floor`,
    ]),
  )
  expect(ops.get(profile.operationId)).toMatchObject({ side: 'outside', tabs: { thickness: 8 } })
  // every number the script sent but the tabs (its own choice): from a result or derived
  for (const { name, args } of designArgs) {
    const { tabs, ...dimensions } = args
    expect(tabs ?? TABS).toBe(TABS)
    for (const n of numbersIn(dimensions, new Set()))
      expect(
        fromTools.has(n) ||
          [...derived].some(
            ([v, from]) => v === n && from.every((f) => fromTools.has(f) || derived.has(f)),
          ),
        `${name}: ${n} is read from a reference tool result`,
      ).toBe(true)
  }

  // ── Criterion: plan, toolpaths ───────────────────────────────────────────────────────────
  const { planId } = (
    await ok<{ planId: string }>('plan.create', { partId, machineLibraryItemId: machine })
  ).value
  const { plan } = (await ok<PlanSummary>('plan.get', { planId })).value
  expect(plan.setups.map((s) => [s.name, s.direction])).toEqual([
    ['Bottom', '-z'],
    ['Top', '+z'],
  ])
  const generate = async () => {
    const gen = await ok<{ jobId: string }>('plan.toolpath.generate', { planId })
    const r = (await waitJob(gen.value.jobId)) as { ok: boolean; value: Generated }
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.value.operations.every((o) => o.status === 'generated')).toBe(true)
  }
  await generate()

  // ── Criterion: plan.workholding.set on both setups (W6 auto, then copyFrom) ─────────────
  const [first, second] = plan.setups as [Setup, Setup]
  const auto = (
    await ok<SetResult>('plan.workholding.set', {
      planId,
      setupId: first.id,
      auto: 'toeClamps',
    })
  ).value
  // four clamps where the black-box test put them (X0): front and back, X45 and X205
  const summaries = EXIT_CLAMPS.map(
    (c) => `${c.edge === 'vMin' ? 'front' : 'back'} X${c.at} grip ${c.grip} top Z${c.top}`,
  )
  expect(auto.items.map((i) => i.summary)).toEqual(summaries)
  expect(auto.clearanceHeight).toBe(`${Number(EXIT_CLAMPS[0].top) + EXIT_MARGIN} mm`)
  const copied = (
    await ok<SetResult>('plan.workholding.set', {
      planId,
      setupId: second.id,
      copyFrom: first.id,
    })
  ).value
  expect(copied.items.map((i) => i.summary)).toEqual(summaries)
  for (const r of [auto, copied])
    expect(r.findings.filter((f) => f.code === 'plan.workholding.collision')).toEqual([])
  await generate()

  // ── Criterion: no error findings, no plan.workholding.collision ─────────────────────────
  const findings = (
    await ok<{ warnings: Finding[] }>('plan.warning.list', { planId, detail: 'full' })
  ).value.warnings
  expect(findings.filter((f) => f.severity === 'error')).toEqual([])
  expect(findings.filter((f) => f.code === 'plan.workholding.collision')).toEqual([])

  // ── Criterion: export both setups (goldens) ──────────────────────────────────────────────
  await ok('run.connection.open', { target: 'virtual', planId, timeScale: 'max', prepare: true })
  const programs: string[] = []
  const exports: ExportResult[] = []
  for (const [i, setup] of plan.setups.entries()) {
    const target = join(dir, `enclosure-base-${i + 1}.nc`)
    const exported = (await ok<ExportResult>('plan.export', { planId, setupId: setup.id, target }))
      .value
    expect(exported).toMatchObject({
      setupId: setup.id,
      softLimitChecked: true,
      warnings: [],
      regenerated: [],
    })
    const program = readFileSync(target, 'utf8')
    await expect(withoutAppVersion(program)).toMatchFileSnapshot(GOLDEN_LLM_FIRST[i]!)
    expect(program).toContain('(Every move checked: 2 mm clear of the workholding)')
    for (const [n, s] of summaries.entries())
      expect(program).toContain(`(Workholding: Toe clamp ${n + 1}: ${s})`)
    programs.push(program)
    exports.push(exported)
  }

  // ── Criterion: the independent G-code oracle (true arcs) against the clamps ─────────────
  // the clamps' boxes from X0's positions (pads to `reach`), not from the app's results
  const boxes: OracleBox[] = EXIT_CLAMPS.map((c) => {
    const at = Number(c.at)
    const half = Number(c.width) / 2
    const grip = Number(c.grip)
    const width = Number(EXIT_STOCK.width)
    return {
      x: [at - half, at + half],
      y: c.edge === 'vMin' ? [-EXIT_CLAMP_REACH, grip] : [width - grip, width + EXIT_CLAMP_REACH],
      top: Number(c.top),
    }
  })
  const clearance = programs.map(
    (p) => Math.round(gcodeClearance(p, boxes, 3, EXIT_MARGIN) * 1000) / 1000,
  )
  for (const c of clearance) expect(c).toBeGreaterThanOrEqual(EXIT_NUMBERS.clampClearance)
  // not X0's second defect: the saved bottom program came within 1.172 mm (and crossed above)
  expect(clearance[0]).toBeGreaterThan(EXIT_FINDINGS.savedClearance.bottomBelowZ26)

  // ── Criterion: depths against the fixture (Z0 on each setup's face) ─────────────────────
  /** Per tool diameter: the deepest tip below the stock top (a later tool's own Z0 added). */
  const deepest = (text: string) => {
    const z0 = new Map<number, number>()
    for (const m of text.matchAll(/^\(Z0 for tool (\d+): .*, ([\d.]+) below the stock top\)$/gm)) {
      const dia = new RegExp(`^\\(Tool ${m[1]}: .*, dia ([\\d.]+) mm`, 'm').exec(text)![1]
      z0.set(Number(dia), Number(m[2]))
    }
    const tipOf = (p: ReturnType<typeof parseGcode>[number]) =>
      Math.min(
        ...p.toolpath.passes.flatMap((q) =>
          q.moves.map((m) => (m.kind === 'drill' ? m.bottom : m.to[2])),
        ),
      )
    return Object.fromEntries(
      parseGcode(text).map((p) => {
        const depth = (z0.get(p.tool.diameter) ?? 0) - tipOf(p)
        return [p.tool.diameter, Math.round(depth * 1000) / 1000]
      }),
    ) as Record<number, number>
  }
  const bottom = deepest(programs[0]!)
  const fromBelow = (depth: number) =>
    EXIT_LEVELS.find((l) => l.facing === 'opposite' && l.depthFromOpposite === depth)!
  const f = EXIT_FINDINGS.drillBreakthrough
  // the 6 mm flat: the outer step down to the rim's underside, no deeper
  expect(bottom[6]).toBe(fromBelow(f.cavityFloor).depthFromOpposite)
  // the 2 mm flat: the holes' flat ends; the 0.241 mm web under the cavity floor stays (X0's
  // first defect, the drill point's pinhole, is not repeated)
  expect(bottom[2]).toBe(fromBelow(f.holeEnd).depthFromOpposite)
  expect(Math.round((f.cavityFloor - bottom[2]!) * 1000) / 1000).toBe(f.web)
  // the chamfer mill stays in the countersinks, above the holes' ends
  expect(bottom[12]).toBeLessThan(f.holeEnd)
  // from the top: the outline through what the bottom's facing left (the cavity floor is the
  // deviation check's)
  expect(deepest(programs[1]!)[6]).toBeGreaterThan(thickness - facingDepth)

  // ── Criterion: virtual run of both setups, tool changes and setups as job.wait says ─────
  let start: { name: string; args: object } | undefined = {
    name: 'run.job.start',
    args: { planId, setupId: first.id },
  }
  const runs: RunSummary[] = []
  const continued: unknown[] = []
  while (start !== undefined) {
    const { jobId }: { jobId: string } = (await ok<{ jobId: string }>(start.name, start.args)).value
    // a tool change or a pause: continue as the wait says; the run's end: the next setup, if any
    let w: JobWait = (await ok<JobWait>('job.wait', { jobId, timeoutSeconds: 120 })).value
    while (w.state !== 'finished') {
      if (w.waiting !== undefined) {
        continued.push(w.waiting.next.args)
        await ok(w.waiting.next.name, w.waiting.next.args)
      }
      w = (await ok<JobWait>('job.wait', { jobId, timeoutSeconds: 120 })).value
    }
    expect(w.outcome?.ok, JSON.stringify(w.outcome)).toBe(true)
    runs.push(w.outcome!.value as RunSummary)
    start = w.waiting?.next
  }
  expect(runs.map((r) => [r.setupId, r.lines, r.toolChanges, r.warnings])).toEqual(
    plan.setups.map((s, i) => [s.id, exports[i]!.lines, exports[i]!.stats.toolChanges, []]),
  )
  expect(continued.filter((a) => 'toolChange' in (a as object))).toHaveLength(
    exports.reduce((n, e) => n + e.stats.toolChanges, 0),
  )
  await ok('run.connection.close')

  // ── Criterion: design.reference.compare, the plan source (Q44) and the part source ──────
  const compare = async <T>(source: object) => {
    const { jobId } = (await ok<{ jobId: string }>('design.reference.compare', { partId, source }))
      .value
    const r = (await waitJob(jobId)) as { ok: boolean; value: T }
    expect(r.ok, JSON.stringify(r)).toBe(true)
    return r.value
  }
  const byPlan = await compare<PlanCompare>({ kind: 'plan', planId })
  for (const face of byPlan.faces) {
    expect(face.p95, face.face).toBeLessThanOrEqual(EXIT_NUMBERS.p95)
    expect(face.p99, face.face).toBeLessThanOrEqual(EXIT_NUMBERS.p99)
  }
  const unexplained = byPlan.regions.filter(
    (g) => g.cause === undefined && g.maxDev > EXIT_NUMBERS.explainOver,
  )
  expect(unexplained).toEqual([])
  expect(byPlan.unexplained).toBe(0)
  // what remains: the outline's tabs (seen from both faces) and the cavity's two sharp corners
  expect([...new Set(byPlan.regions.map((g) => g.cause))].sort()).toEqual(['tab', 'toolRadius'])
  // no over-cut anywhere (the drill points of X0 broke through the floor)
  expect(byPlan.regions.filter((g) => g.sign === 'overcut')).toEqual([])
  const byPart = await compare<PartCompare>({ kind: 'part' })
  expect(byPart.regions.filter((g) => g.maxDev > EXIT_NUMBERS.explainOver)).toEqual([])

  // the agent saves its work (nothing left for recovery)
  await ok('project.save', { target: join(dir, 'enclosure-base.dfyom') })

  return {
    programs,
    stats: counted.stats(),
    clearance,
    deviation: {
      faces: byPlan.faces.map(({ face, p95, p99, max }) => ({ face, p95, p99, max })),
      regions: byPlan.regions.length,
      unexplained: byPlan.unexplained,
    },
    partDeviation: {
      regions: byPart.regions.length,
      maxMissing: byPart.stats.maxMissing,
      maxExtra: byPart.stats.maxExtra,
    },
  }
}

interface Box3 {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}
interface Level {
  depth: number
  facing: 'face' | 'opposite'
  area: number
  bounds: [[number, number], [number, number]]
  depthFromOpposite?: number
}
interface Levels {
  levels: Level[]
}
interface Loop {
  role: 'outer' | 'hole'
  area: number
  bounds: [[number, number], [number, number]]
}
interface Section {
  loops: Loop[]
}
interface Holes {
  holeCount: number
  groups: {
    count: number
    holes: [number, number][]
    size: { diameter: number; top: number; depth: number; mouth?: unknown }
    suggest: {
      command: string
      args: Record<string, unknown>
      note?: string
      clones?: { rows: unknown[] }
    }
  }[]
}
interface Imported {
  shapeIds: string[]
  section: {
    shapes: {
      shapeId: string
      sharpCount: number
      placeAt: { center: [number, number]; anchor: unknown }
    }[]
  }
}
interface AddResult {
  operationId: string
  placed: { min: [number, number]; max: [number, number] }
}
interface Finding {
  code: string
  severity: string
}
interface PartGet {
  part: { operations: ({ id: string; kind: string } & Record<string, unknown>)[] }
}
interface Setup {
  id: string
  name: string
  direction?: string
}
interface PlanSummary {
  plan: { setups: Setup[] }
}
interface Generated {
  operations: { status: string }[]
}
interface SetResult {
  items: { id: string; summary: string }[]
  clearanceHeight: string
  findings: Finding[]
}
interface ExportResult {
  setupId: string
  lines: number
  stats: { toolChanges: number }
}
interface JobWait {
  state: string
  outcome?: { ok: boolean; value?: unknown }
  waiting?: { kind: string; next: { name: string; args: object } }
}
interface RunSummary {
  setupId: string
  lines: number
  toolChanges: number
  warnings: unknown[]
}
interface PlanCompare {
  faces: { face: string; p95: number; p99: number; max: number }[]
  regions: { maxDev: number; cause?: string; sign: string }[]
  unexplained: number
}
interface PartCompare {
  stats: { maxMissing: number; maxExtra: number }
  regions: { maxDev: number }[]
}
