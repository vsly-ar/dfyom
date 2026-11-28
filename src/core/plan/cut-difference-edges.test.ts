// Cut state C4 follow-up (hardening DF135): a recut Line or chamfer cuts only the difference where
// its as-cut twin is the same cut, less deep or less wide. Heightmap oracle as cut-difference.test.ts:
// the run's program, then the new one, against one program of the edited design from the raw
// stock – nothing cut that the design keeps (gouge), nothing left over, no rapid into material,
// less feed in the air of the old cut than recutting it in full.
// Doc: docs/modes/cut-state.md#edge-operations-engravings-and-through-holes-c4-follow-up
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { deg, len, libraryInput, num } from '../library/library.fixture'
import { exportPlan } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import type { Move, Toolpath, ToolpathTool } from '../toolpath/model'
import { parseGcode } from '../toolpath/testing/gcode'
import { chamferMill as cone } from '../toolpath/testing/fixtures'
import { Heightmap, samples, steps } from '../toolpath/testing/oracles'
import type { PlanDTO } from './plan.dto'
import { planSetup, type PlanSetup } from './plan.fixture'

const region2d = nodeRegion2d()

const BLOCK = {
  name: 'Block',
  shape: 'block' as const,
  length: '80',
  width: '50',
  thickness: '12',
  material: { name: 'Walnut', class: 'hardwood' as const },
}
const SIZE = { length: 80, width: 50 }

const V_BIT = {
  name: 'V-bit 60',
  type: 'chamferMill' as const,
  diameter: len('6'),
  angle: deg('60'),
  fluteLength: len('6'),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [],
}

const all = (p: PlanDTO) => p.setups.flatMap((s) => s.operations)
const opOf = (p: PlanDTO, design: string) =>
  all(p).find((o) => o.designOperationIds.includes(design))!

type Build = (s: PlanSetup) => Promise<void>

async function setup(build: Build) {
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({ part: false, services: svc, stock: BLOCK })
  await build(s)
  await s.run('project.apply', {})
  return { s, svc }
}

/**
 * The cone of this file's V-bit and chamfer mills by tool name (the G-code reader takes every
 * tool for a flat end mill or a drill).
 */
const CONES: Readonly<Record<string, ToolpathTool>> = {
  'V-bit 60': cone(6, 60),
  'Chamfer 6 tip 0': cone(6, 90, 0),
  'Chamfer 6 tip 4': cone(6, 90, 4),
}

/** A program's moves per tool in stock coordinates (Z0 = the raw top, see cut-state.test.ts). */
function programCuts(text: string): { tool: ToolpathTool; tp: Toolpath }[] {
  const below = new Map<string, number>()
  for (const m of text.matchAll(/^\(Z0 for tool (\d+): .*?([\d.]+) below the stock top\)$/gm))
    below.set(`T${m[1]}`, Number(m[2]))
  const names = new Map<string, string>()
  for (const m of text.matchAll(/^\(Tool (\d+): (.*?), dia /gm)) names.set(`T${m[1]}`, m[2]!)
  return parseGcode(text).map((p) => {
    const dz = below.get(p.tool.id) ?? 0
    const cone = CONES[names.get(p.tool.id) ?? '']
    const shift = (m: Move): Move =>
      m.kind === 'drill' ? m : { ...m, to: [m.to[0], m.to[1], m.to[2] - dz] }
    return {
      tool: cone === undefined ? p.tool : { ...cone, id: p.tool.id },
      tp: {
        ...p.toolpath,
        passes: p.toolpath.passes.map((x) => ({ ...x, moves: x.moves.map(shift) })),
      },
    }
  })
}

interface Oracle {
  /** Area (mm²) cut deeper than the one-program reference (gouge). */
  readonly gouge: number
  /** Area (mm²) left higher than the reference (material left over). */
  readonly left: number
  /** Rapid moves that would remove material. */
  readonly rapidsInMaterial: number
  /** Feed length (mm, 3D) that removes nothing. */
  readonly air: number
}

/**
 * `before` then `after` against `reference` (one program of the edited design, raw stock); `air`
 * counts the tools of `after` that `only` takes.
 */
function oracle(
  before: string,
  after: string,
  reference: string,
  only: (tool: ToolpathTool) => boolean = () => true,
): Oracle {
  const cell = 0.05
  const hm = new Heightmap(SIZE.length, SIZE.width, cell)
  for (const p of programCuts(before)) hm.sweep(p.tool, p.tp, cell)
  let rapidsInMaterial = 0
  let air = 0
  for (const p of programCuts(after)) {
    const slim = { ...p.tool, diameter: p.tool.diameter - 0.04 }
    for (const st of steps(p.tp)) {
      const pts = samples(st, cell)
      if (st.move.kind === 'rapid') {
        if (pts.some((q) => hm.probe(slim, q) > 0.02)) rapidsInMaterial++
        continue
      }
      for (let k = 1; k < pts.length; k++) {
        const q = pts[k]!
        const a = pts[k - 1]!
        if (only(p.tool) && hm.probe(slim, q) <= 0.01)
          air += Math.hypot(q[0] - a[0], q[1] - a[1], q[2] - a[2])
        hm.stamp(p.tool, q)
      }
      if (pts.length > 0) hm.stamp(p.tool, pts[0]!)
    }
  }
  const ref = new Heightmap(SIZE.length, SIZE.width, cell)
  for (const p of programCuts(reference)) ref.sweep(p.tool, p.tp, cell)
  let gouge = 0
  let left = 0
  for (let i = 0; i < hm.z.length; i++) {
    if (hm.z[i]! < ref.z[i]! - 0.02) gouge++
    if (hm.z[i]! > ref.z[i]! + 0.02) left++
  }
  return { gouge: gouge * cell * cell, left: left * cell * cell, rapidsInMaterial, air }
}

/** The run's program, the run marks `ids` (C2), `edit`, the program of the difference. */
async function recut(build: Build, ids: string[], edit: Build) {
  const { s, svc } = await setup(build)
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const before = expectOk(await exportPlan(s.d.doc, planId, svc as never)).text
  await s.run('design.part.update', { partId: s.partId, alreadyCut: ids, cutByRun: planId })
  await s.run('project.apply', {})
  await edit(s)
  await s.run('project.apply', {})
  const after = expectOk(await exportPlan(s.d.doc, planId, svc as never))
  // one program of the edited design from the raw stock, nothing marked
  const r = await setup(build)
  await edit(r.s)
  await r.s.run('project.apply', {})
  const refPlan = await r.s.create({ machineLibraryItemId: r.s.machineId })
  const reference = expectOk(await exportPlan(r.s.d.doc, refPlan, r.svc as never)).text
  const toolpath = (design: string) =>
    (
      s.query('plan.toolpath.get', {
        planId,
        planOperationId: opOf(s.plan(planId), design).id,
      }) as { toolpath: Toolpath }
    ).toolpath
  return { s, svc, planId, before, after, reference, toolpath }
}

/** A V-bit Line along an open 40 mm path and round a closed 20 × 10 loop, on the raw top. */
const engraving =
  (depth: string): Build =>
  async (s) => {
    await s.run('library.tool.add', { values: libraryInput(V_BIT) })
    const shape = async (name: string, item: object) =>
      (
        (await s.run('design.shape.add', { partId: s.partId, name, items: [item] })) as {
          shapeId: string
        }
      ).shapeId
    const flute = await shape('Flute', {
      kind: 'path',
      closed: false,
      start: ['0', '0'],
      segments: [{ kind: 'line', to: ['40', '0'] }],
    })
    const loop = await shape('Loop', {
      kind: 'path',
      closed: true,
      start: ['0', '0'],
      segments: [
        { kind: 'line', to: ['20', '0'] },
        { kind: 'line', to: ['20', '10'] },
        { kind: 'line', to: ['0', '10'] },
        { kind: 'line', to: ['0', '0'] },
      ],
    })
    await s.run('design.line.add', {
      partId: s.partId,
      paths: [
        { shapeId: flute, center: ['40', '15'] },
        { shapeId: loop, center: ['40', '35'] },
      ],
      depth,
    })
  }

const lineDepth =
  (depth: string): Build =>
  async (s) => {
    await s.run('design.line.update', { partId: s.partId, operationId: 'line1', depth })
  }

const chamferMill = (tipDiameter: string) => ({
  name: `Chamfer 6 tip ${tipDiameter}`,
  type: 'chamferMill' as const,
  diameter: len('6'),
  angle: deg('90'),
  tipDiameter: len(tipDiameter),
  fluteLength: len('8'),
  overallLength: len('50'),
  fluteCount: num('2'),
  toolMaterial: 'carbide' as const,
  presets: [],
})

/** A Ø 10 pocket 5 deep with a 0.5 mm circular chamfer, by a pointed 90° chamfer mill. */
const countersunk: Build = async (s) => {
  await s.run('library.tool.add', { values: libraryInput(chamferMill('0')) })
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: { kind: 'circle', center: ['40', '25'], diameter: '10' },
    depth: '5',
  })
  await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'pocket1', width: '0.5' })
}

/** Pocket 1 (40 × 30 R3, 6 deep) with a 1 mm edge chamfer, by a 90° chamfer mill of tip Ø 4. */
const beveled: Build = async (s) => {
  await s.run('library.tool.add', { values: libraryInput(chamferMill('4')) })
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: {
      kind: 'rectangle',
      center: ['40', '25'],
      length: '40',
      width: '30',
      cornerRadius: '3',
    },
    depth: '6',
  })
  await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'pocket1', width: '1' })
}

const chamferWidth =
  (width: string): Build =>
  async (s) => {
    await s.run('design.chamfer.update', { partId: s.partId, operationId: 'chamfer1', width })
  }

/** The V-bits and chamfer mills (the Line and chamfer tools of these tests). */
const cones = (tool: ToolpathTool) => tool.type === 'chamferMill'

/** Every Z of a toolpath's cutting moves. */
const cutZs = (tp: Toolpath) =>
  tp.passes.flatMap((p) =>
    p.moves.flatMap((m) => (m.kind === 'line' || m.kind === 'arc' ? [m.to[2]] : [])),
  )

describe('cut state C4 follow-up: recut Lines and chamfers cut the difference', () => {
  it('a Line deepened 1.5 → 4 mm cuts from the old groove down only', async () => {
    const r = await recut(engraving('1.5'), ['line1'], lineDepth('4'))
    const tp = r.toolpath('line1')
    expect(r.after.operationLines.map((l) => l.planOperationId)).toEqual([
      opOf(r.s.plan(r.planId), 'line1').id,
    ])
    // the material top is the old groove's floor (no facing: the raw top is Z0)
    const zs = cutZs(tp)
    expect(Math.min(...zs)).toBeCloseTo(-4, 6)
    // the first pass (at 1.333 mm: three even passes, DF158) is dropped: each line's only move
    // that high is its feed down to the old floor
    expect(zs.filter((z) => z > -1.5 - 1e-6)).toEqual([-1.5, -1.5])
    const o = oracle(r.before, r.after.text, r.reference)
    expect(o.gouge).toBe(0)
    expect(o.left).toBeLessThan(0.5)
    expect(o.rapidsInMaterial).toBe(0)
    // the whole Line again re-cuts its old groove in the air
    const full = oracle(r.before, r.reference, r.reference)
    expect(o.air).toBeLessThan(full.air / 4)
    await expect(r.after.lines.join('\n') + '\n').toMatchFileSnapshot(
      '__golden__/cut-deeper-engraving.nc',
    )
    // another tool than the Line's cutter (the groove may be narrower than it): cut in full
    const wide = (
      (await r.s.run('library.tool.add', {
        values: libraryInput({ ...V_BIT, name: 'V-bit 90', angle: deg('90') }),
      })) as { id: string }
    ).id
    await r.s.run('plan.tool.assign', {
      planId: r.planId,
      planOperationId: opOf(r.s.plan(r.planId), 'line1').id,
      toolLibraryItemId: wide,
    })
    const again = expectOk(await exportPlan(r.s.d.doc, r.planId, r.svc as never)).text
    expect(again).toContain('Z-1.333 F')
    expect(cutZs(r.toolpath('line1')).filter((z) => z > -1.5 - 1e-6).length).toBeGreaterThan(2)
  }, 120_000)

  it('a circular chamfer made 1 mm wider ramps from the old cone depth, not from the face', async () => {
    const r = await recut(countersunk, ['pocket1', 'chamfer1'], chamferWidth('1.5'))
    const tp = r.toolpath('chamfer1')
    expect(r.after.operationLines.map((l) => l.planOperationId)).toEqual([
      opOf(r.s.plan(r.planId), 'chamfer1').id,
    ])
    // contoured: down to the old depth (0.5 mm under the face), ramped to the new 1.5 mm
    const zs = cutZs(tp)
    expect(zs[0]).toBeCloseTo(-0.5, 6)
    expect(Math.max(...zs)).toBeCloseTo(-0.5, 6)
    expect(Math.min(...zs)).toBeCloseTo(-1.5, 6)
    const o = oracle(r.before, r.after.text, r.reference)
    expect(o.gouge).toBe(0)
    expect(o.left).toBeLessThan(0.5)
    expect(o.rapidsInMaterial).toBe(0)
    // the whole chamfer again ramps down from the face in the air (about 21 mm against 11)
    const full = oracle(r.before, r.reference, r.reference, cones)
    expect(o.air).toBeLessThan(full.air - 5)
    await expect(r.after.lines.join('\n') + '\n').toMatchFileSnapshot(
      '__golden__/cut-enlarged-chamfer.nc',
    )
  }, 120_000)

  it('an edge chamfer widened 1 → 2.5 mm in levels drops the rings in the old bevel', async () => {
    const r = await recut(beveled, ['pocket1', 'chamfer1'], chamferWidth('2.5'))
    // one rapid up to clearance per ring run; the chamfer mill is the last tool of both programs
    const rings = (text: string) =>
      programCuts(text)
        .at(-1)!
        .tp.passes.flatMap((p) => p.moves)
        .filter((m) => m.kind === 'rapid' && m.to[2] > 5).length
    expect(rings(r.after.text)).toBeLessThan(rings(r.reference))
    const o = oracle(r.before, r.after.text, r.reference)
    expect(o.gouge).toBe(0)
    expect(o.left).toBeLessThan(0.5)
    expect(o.rapidsInMaterial).toBe(0)
    const full = oracle(r.before, r.reference, r.reference, cones)
    expect(o.air).toBeLessThan(full.air)
  }, 120_000)
})
