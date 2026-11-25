// Edge chamfers E1 through the plan (docs/modes/edge-chamfers.md#implementation-e1): a chamfer on
// the rim of a named-shape pocket with an island, its tool chosen (a chamfer mill), entry contour,
// F10 feeds at the bevel's depth, the plunge refused (`loopEntry`), the slant check; and the E1
// exit-style flow headless: planned, generated, exported (GRBL) and streamed through the virtual
// machine, the bevel's tip Z in the program. E2: the enclosure outline (the split fixture)
// chamfered on its faced top, planned after its profile, exported and run per setup; and a split
// piece whose chamfer follows only the source's outline, never the split line.
import { describe, expect, it } from 'vitest'
import { ENCLOSURE_STOCK, enclosureCommands } from '../design/split/split.fixture'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { deg, len, libraryInput, num } from '../library/library.fixture'
import { exportPlan } from '../post/plan-export'
import { streamProgram } from '../run/grbl/sender.fixture'
import { createToolpathCache } from '../toolpath/cache'
import type { Toolpath } from '../toolpath/model'
import type { PlanWarning } from './checks'
import { loadPlan } from './plan'
import { designIds, flat6, opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()

const chamferMill = (diameter: string, extra: object = {}) => ({
  name: `Chamfer ${diameter}`,
  type: 'chamferMill' as const,
  diameter: len(diameter),
  angle: deg('90'),
  fluteLength: len('8'),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [],
  ...extra,
})

interface OpView {
  id: string
  tool: unknown
  strategy: Record<string, number | string>
  feeds: Record<string, { value: number; source: string } | null>
}

/** A 40 × 24 R3 pocket with a Ø 8 island at (50, 30), 4 deep, its rim chamfered 1 × 45°. */
async function edgePlan(chamferArgs: object = {}) {
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({ part: false, services: svc })
  const partId = s.partId
  const cm = (
    (await s.run('library.tool.add', { values: libraryInput(chamferMill('6')) })) as {
      id: string
    }
  ).id
  await s.run('design.shape.add', {
    partId,
    items: [
      { kind: 'rectangle', center: ['0', '0'], length: '40', width: '24', cornerRadius: '3' },
      { kind: 'circle', center: ['0', '0'], diameter: '8', op: 'subtract' },
    ],
  })
  await s.run('design.pocket.add', {
    partId,
    shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] },
    depth: '4',
  })
  await s.run('design.chamfer.add', { partId, edgeOf: 'pocket1', width: '1', ...chamferArgs })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const planOp = (design: string) =>
    opsOf(s.plan(planId)).find((o) => o.designOperationIds.includes(design))!.id
  const chamfer = planOp('chamfer1')
  const view = () =>
    (s.query('plan.operation.list', { planId }) as { operations: OpView[] }).operations.find(
      (o) => o.id === chamfer,
    )!
  const errors = () =>
    (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }).warnings.filter(
      (w) => w.severity === 'error',
    )
  const generate = async () => {
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
      .value as { jobId: string }
    return expectOk(await s.d.job(jobId).unwrap().result) as {
      operations: { planOperationId: string; status: string }[]
    }
  }
  const toolpath = () =>
    (s.query('plan.toolpath.get', { planId, planOperationId: chamfer }) as { toolpath: Toolpath })
      .toolpath
  return { s, svc, planId, cm, chamfer, planOp, view, errors, generate, toolpath }
}

describe('edge chamfers in a plan (E1)', () => {
  it('chooses the chamfer mill, contours at the bevel depth, F10 feeds; the plunge is refused', async () => {
    const t = await edgePlan()
    expect(designIds(t.s.plan(t.planId))).toEqual(['pocket1', 'chamfer1'])
    expect(t.s.op('chamfer1').tool).toMatchObject({ kind: 'specific' })
    expect(t.errors()).toEqual([])
    const v = t.view()
    expect(v.strategy).toMatchObject({ entry: 'contour' })
    expect(v.strategy['cutDepth']).toBeCloseTo(1, 9)
    for (const f of ['spindleSpeed', 'feedRate', 'plungeRate']) expect(v.feeds[f], f).not.toBeNull()
    const e = await t.s.failWith(
      'plan.operation.update',
      { planId: t.planId, planOperationId: t.chamfer, strategy: { entry: 'plunge' } },
      'model.invariant',
    )
    expect(e.issues.map((i) => i.rule)).toEqual(['loopEntry'])
  })

  it('no library mill covers a 3.5 bevel (none chosen); the 6 mm one assigned: slant', async () => {
    const t = await edgePlan({ width: '3.5' })
    expect(t.errors().map((w) => `${w.field}:${w.rule}`)).toEqual(['tool:noTool'])
    await t.s.run('plan.tool.assign', {
      planId: t.planId,
      planOperationId: t.chamfer,
      toolLibraryItemId: t.cm,
    })
    expect(t.errors().map((w) => `${w.field}:${w.rule}`)).toContain('tool:slant')
  })

  it('E1 exit: generated, exported and streamed through the virtual machine', async () => {
    const t = await edgePlan()
    const generated = await t.generate()
    expect(generated.operations.every((o) => o.status === 'generated')).toBe(true)
    const tp = t.toolpath()
    // one ring around the rim, one around the island, at tip Z = −1
    const zs = tp.passes.flatMap((p) => p.moves.map((m) => (m.kind === 'drill' ? 0 : m.to[2])))
    expect(Math.min(...zs)).toBeCloseTo(-1, 9)
    const e = expectOk(await exportPlan(t.s.d.doc, t.planId, t.svc))
    expect(e.regenerated).toEqual([])
    expect(e.lines.some((l) => /Z-1(\.0+)?\b/.test(l))).toBe(true)
    const machine = loadPlan(t.s.d.doc, t.planId, 'test').unwrap().machine.unwrap()
    const run = await streamProgram(e.lines, machine)
    expect(run.lines).toBe(e.lines.length)
  })
})

// ── E2: outside edges (docs/modes/edge-chamfers.md#implementation-e2) ─────────────────────────

type Setup = Awaited<ReturnType<typeof planSetup>>

const services = () => ({
  region2d,
  toolpaths: createToolpathCache(),
  workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
})

/** The enclosure (split fixture) with a 90° Ø 6 chamfer mill, its outline chamfered 1.5 × 45°. */
async function enclosurePlan() {
  const svc = services()
  const s = await planSetup({ part: false, services: svc, stock: ENCLOSURE_STOCK })
  // Ø 6: its touch-off spot fits the enclosure's 11 mm back rim, all the top left by then
  await s.run('library.tool.add', { values: libraryInput(chamferMill('6')) })
  // a 6 mm flat that reaches through the 60.5 mm part (the split exit flow's is for 40 mm pieces)
  await s.run('library.tool.add', {
    values: libraryInput({
      ...flat6(),
      name: 'Flat 6 long',
      fluteLength: len('75'),
      overallLength: len('110'),
    }),
  })
  for (const [name, args] of enclosureCommands(s.partId)) await s.run(name, args)
  const outline = s.part().operations.find((o) => o.kind === 'profile')!.id
  await s.run('design.chamfer.add', { partId: s.partId, edgeOf: outline, width: '1.5' })
  await s.run('project.apply', {})
  return { s, svc, outline }
}

async function generateAll(s: Setup, planId: string): Promise<void> {
  const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
    .value as { jobId: string }
  const generated = expectOk(await s.d.job(jobId).unwrap().result) as {
    operations: { planOperationId: string; status: string }[]
  }
  expect(generated.operations.every((o) => o.status === 'generated')).toBe(true)
}

const chamferToolpath = (s: Setup, planId: string): Toolpath => {
  const op = s
    .plan(planId)
    .setups.flatMap((x) => x.operations)
    .find((o) => o.designOperationIds.includes('chamfer1'))!
  return (
    s.query('plan.toolpath.get', { planId, planOperationId: op.id }) as { toolpath: Toolpath }
  ).toolpath
}

const mmOf = (q: { exact: { num: string; den: string } }) =>
  Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))

describe('edge chamfers in a plan (E2, outside edges)', () => {
  it('E2 exit: the enclosure outline 1.5 × 45° after its profile, exported and run per setup', async () => {
    const { s, svc, outline } = await enclosurePlan()
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const ids = s
      .plan(planId)
      .setups.flatMap((x) => x.operations.map((o) => o.designOperationIds.join('+')))
    expect(ids.indexOf('chamfer1')).toBeGreaterThan(ids.indexOf(outline))
    const errors = (
      s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }
    ).warnings.filter((w) => w.severity === 'error')
    expect(errors).toEqual([])
    await generateAll(s, planId)
    // the bevel sits on the faced top (−9.738), not on the stock top the outline starts from
    const tp = chamferToolpath(s, planId)
    const zs = tp.passes.flatMap((p) => p.moves.map((m) => (m.kind === 'drill' ? 0 : m.to[2])))
    expect(Math.min(...zs)).toBeCloseTo(-9.738 - 1.5, 6)
    const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
    const lines: string[] = []
    for (const setup of s.plan(planId).setups) {
      const e = expectOk(await exportPlan(s.d.doc, planId, svc, { setupId: setup.id }))
      expect(e.regenerated).toEqual([])
      const run = await streamProgram(e.lines, machine)
      expect(run.lines).toBe(e.lines.length)
      lines.push(...e.lines)
    }
    // the chamfer mill touches off on the faced top: the bevel's tip is Z−1.5 in its program
    expect(lines.some((l) => /Z-1\.5\b/.test(l))).toBe(true)
  })

  it('a split piece chamfers only the source outline, never the split line', async () => {
    const { s } = await enclosurePlan()
    await s.run('design.split.set', {
      partId: s.partId,
      split: { lines: [{ axis: 'x', at: '125' }] },
    })
    const pieces = Object.values(s.d.doc.parts)
      .filter((p) => p.derivedFrom?.partId === s.partId)
      .sort((a, b) => a.derivedFrom!.index - b.derivedFrom!.index)
    expect(pieces).toHaveLength(2)
    for (const p of pieces)
      expect(
        p.operations.find((o) => o.kind === 'chamfer'),
        p.name,
      ).toMatchObject({
        edgeOf: 'split1_outline',
        on: 'stock.top',
        sourceEdge: { shape: { kind: 'rectangle' } },
      })
    // piece 1 (x < 125): its bevel stays left of the split line plus the tool's reach, and runs
    // the source's left edge
    const piece = pieces[0]!
    const dx = mmOf(piece.offset![0]!)
    const dy = mmOf(piece.offset![1]!)
    const planId = (
      (await s.run('plan.create', { partId: piece.id, machineLibraryItemId: s.machineId })) as {
        planId: string
      }
    ).planId
    await generateAll(s, planId)
    const cuts = chamferToolpath(s, planId).passes.flatMap((p) =>
      p.moves.filter((m) => m.kind === 'line' || m.kind === 'arc').map((m) => m.to),
    )
    expect(cuts.length).toBeGreaterThan(0)
    const xs = cuts.map((p) => p[0])
    expect(Math.max(...xs)).toBeLessThan(125 + dx + 1.5 + 0.1)
    expect(Math.min(...xs)).toBeLessThan(0.25 + dx + 1)
    // nothing along the split line (x = 125) between the front and back edges (y 11.5 … 188.5)
    const alongLine = cuts.filter((p) => p[0] > 125 + dx - 5 && p[1] > 30 + dy && p[1] < 170 + dy)
    expect(alongLine).toEqual([])
  })

  it('E3: a split level is checked against the bevel on the faced top, not the stock top', async () => {
    const { s } = await enclosurePlan()
    const cone = async (level: string) => {
      const r = (await s.run('design.split.set', {
        partId: s.partId,
        split: { levels: [level] },
      })) as { findings: { message: string; params: Record<string, unknown> }[] }
      return r.findings.filter((f) => f.params['reason'] === 'cone')
    }
    // the bevel runs −9.738 … −11.238: a level at −1 misses it (the `on` face's range said cut)
    expect(await cone('-1')).toEqual([])
    expect((await cone('-10.5')).map((f) => f.params['operationId'])).toEqual(['chamfer1'])
  })
})
