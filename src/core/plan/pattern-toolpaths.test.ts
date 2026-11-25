// Patterns P1 exit, headless (docs/modes/patterns.md#implementation-p1): a honeycomb of rounded
// hexagons on a walnut lid's top through the real commands, evaluated (removed volume = cells ×
// cell area × depth), planned, generated, exported (GRBL, a golden) and streamed through the
// virtual machine. P2 (docs/modes/patterns.md#implementation-p2): a vent grille of hex circles
// clipped to a rounded-rectangle boundary with a round logo keep-out, the same way. P3
// (docs/modes/patterns.md#implementation-p3): the honeycomb with its chamfer on, cut by a V-bit
// after the pocket, the bevel's volume against h(P·w/2 + πw²/3) per cell, the same way. P5
// (docs/modes/patterns.md#implementation-p5): flipped triangles on the lid, and the through grille
// chamfered top and bottom (the bottom from a flipped setup), each setup exported and streamed.
import { beforeAll, describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { uiSource } from '../commands/testing'
import { partGeometryInput } from '../design/load'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import { regionArea } from '../geometry/2d/model'
import { chainLength } from '../geometry/2d/measure'
import { deg, len, libraryInput, num } from '../library/library.fixture'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import type { SolidKernel } from '../geometry/solid-port'
import { nodeManifoldSource } from '../geometry/testing/node-wasm'
import { exportPlan } from '../post/plan-export'
import { streamProgram } from '../run/grbl/sender.fixture'
import { createToolpathCache } from '../toolpath/cache'
import type { Toolpath } from '../toolpath/model'
import type { PlanWarning } from './checks'
import { loadPlan } from './plan'
import { opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const ui = uiSource()
let kernel: SolidKernel
beforeAll(async () => {
  kernel = (await loadManifold(nodeManifoldSource())).unwrap()
})

const LID = {
  name: 'Lid',
  shape: 'block' as const,
  length: '80',
  width: '50',
  thickness: '12',
  material: { name: 'Walnut', class: 'hardwood' as const },
}

/** Plans the part, generates, exports and streams; returns the program and the pocket's path. */
async function planExportRun(s: Awaited<ReturnType<typeof planSetup>>, svc: object) {
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  const errors = (
    s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }
  ).warnings.filter((w) => w.severity === 'error')
  expect(errors).toEqual([])
  const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
    .value as { jobId: string }
  const gen = expectOk(await s.d.job(jobId).unwrap().result) as {
    operations: { status: string }[]
  }
  expect(gen.operations.every((o) => o.status === 'generated')).toBe(true)
  const op = opsOf(s.plan(planId)).find((o) => o.designOperationIds.includes('pattern1_pocket'))!
  const tp = (
    s.query('plan.toolpath.get', { planId, planOperationId: op.id }) as { toolpath: Toolpath }
  ).toolpath
  const e = expectOk(await exportPlan(s.d.doc, planId, svc as never))
  const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
  const run = await streamProgram(e.lines, machine)
  expect(run.lines).toBe(e.lines.length)
  return { lines: e.lines, toolpath: tp, planId }
}

describe('patterns P1 exit', () => {
  it('a honeycomb on the lid top: volume, plan, export golden, virtual machine', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc, stock: LID })
    const out = (await s.run('design.pattern.add', {
      partId: s.partId,
      name: 'Honeycomb',
      lattice: 'hex',
      cell: {
        kind: 'polygon',
        sides: '6',
        diameter: '12',
        across: 'flats',
        cornerRadius: '2.5',
        rotation: '30',
      },
      spacing: { gap: '3' },
      margin: '5',
      depth: '2',
    })) as { cells: number; warnings: { code: string }[] }
    // rows of 4, 3 and 4 cells
    expect(out.cells).toBe(11)
    expect(out.warnings).toEqual([])
    await s.run('project.apply', {})

    // removed volume = cells × cell area × depth
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const pocket = input.operations[0]!
    if (pocket.kind !== 'pocket' || pocket.shape.contour.kind !== 'region')
      throw new Error('no region')
    const pieces = pocket.shape.contour.region.pieces
    expect(pieces).toHaveLength(11)
    const cellArea = regionArea({ pieces: [pieces[0]!] })
    const solid = kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap()
    // within the chords' shortfall on the rounded corners (0.01 mm chord tolerance)
    const want = 11 * cellArea * 2
    expect(Math.abs(80 * 50 * 12 - solid.volume - want) / want).toBeLessThan(0.002)

    // planned with no error, generated, exported, streamed
    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const errors = (
      s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] }
    ).warnings.filter((w) => w.severity === 'error')
    expect(errors).toEqual([])
    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
      .value as { jobId: string }
    const gen = expectOk(await s.d.job(jobId).unwrap().result) as {
      operations: { status: string }[]
    }
    expect(gen.operations.every((o) => o.status === 'generated')).toBe(true)
    const op = opsOf(s.plan(planId)).find((o) => o.designOperationIds.includes('pattern1_pocket'))!
    const tp = (
      s.query('plan.toolpath.get', { planId, planOperationId: op.id }) as { toolpath: Toolpath }
    ).toolpath
    const zs = tp.passes.flatMap((p) => p.moves.map((m) => (m.kind === 'drill' ? 0 : m.to[2])))
    expect(Math.min(...zs)).toBeCloseTo(-2, 9)
    const e = expectOk(await exportPlan(s.d.doc, planId, svc))
    await expect(e.lines.join('\n') + '\n').toMatchFileSnapshot(
      '__golden__/pattern-honeycomb-lid.nc',
    )
    const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
    const run = await streamProgram(e.lines, machine)
    expect(run.lines).toBe(e.lines.length)
  })
})

describe('patterns P2 exit', () => {
  it('a hex grille clipped to a rounded boundary with a logo keep-out: volume, plan, golden, machine', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc, stock: { ...LID, name: 'Panel' } })
    await s.run('design.shape.add', {
      partId: s.partId,
      name: 'Vent',
      items: [
        { kind: 'rectangle', center: ['0', '0'], length: '70', width: '40', cornerRadius: '8' },
        { kind: 'circle', op: 'subtract', center: ['0', '0'], diameter: '16' },
      ],
    })
    const out = (await s.run('design.pattern.add', {
      partId: s.partId,
      name: 'Grille',
      lattice: 'hex',
      cell: { kind: 'circle', diameter: '4' },
      spacing: { gap: '1.5' },
      boundary: { shapeId: 'shape1', center: ['40', '25'] },
      margin: '2',
      fit: 'clip',
      depth: '1.5',
    })) as { cells: number; dropped?: number; warnings: { code: string; severity: string }[] }
    expect(out.cells).toBeGreaterThan(50)
    // clipped fragments are opened to R 0.5 where they meet the boundary: the tool chosen for
    // the cells leaves its radius in those corners (an honest warning, not "no tool fits")
    const codes = new Set(out.warnings.filter((w) => w.severity === 'warning').map((w) => w.code))
    expect([...codes]).toEqual(['dfm.cornerTooSmall'])
    await s.run('project.apply', {})

    // removed volume = the cells' area (clipped) × depth; nothing in the grown keep-out
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const pocket = input.operations[0]!
    if (pocket.kind !== 'pocket' || pocket.shape.contour.kind !== 'region')
      throw new Error('no region')
    const region = pocket.shape.contour.region
    const solid = kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap()
    // within the chords' shortfall on Ø 4 cells and R 0.5 corners (0.01 mm chord tolerance)
    const want = regionArea(region) * 1.5
    expect(Math.abs(80 * 50 * 12 - solid.volume - want) / want).toBeLessThan(0.01)

    const { lines, toolpath } = await planExportRun(s, svc)
    const zs = toolpath.passes.flatMap((p) =>
      p.moves.map((m) => (m.kind === 'drill' ? 0 : m.to[2])),
    )
    expect(Math.min(...zs)).toBeCloseTo(-1.5, 9)
    // no cut inside the keep-out grown by the margin (Ø 20 about [40, 25]), below the top
    for (const p of toolpath.passes)
      for (const m of p.moves)
        if (m.kind !== 'drill' && m.to[2] < 0)
          expect(Math.hypot(m.to[0] - 40, m.to[1] - 25)).toBeGreaterThan(10)
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot(
      '__golden__/pattern-grille-keepout.nc',
    )
  })
})

describe('patterns P3 exit', () => {
  it('the honeycomb chamfered 0.5 × 90° by a V-bit: volume, plan, golden, machine', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc, stock: LID })
    await s.run('library.tool.add', {
      values: libraryInput({
        name: 'V-bit 90°',
        type: 'chamferMill' as const,
        diameter: len('6'),
        angle: deg('90'),
        fluteLength: len('8'),
        overallLength: len('50'),
        fluteCount: num('2'),
        toolMaterial: 'carbide' as const,
        presets: [],
      }),
    })
    const out = (await s.run('design.pattern.add', {
      partId: s.partId,
      name: 'Honeycomb',
      lattice: 'hex',
      cell: {
        kind: 'polygon',
        sides: '6',
        diameter: '12',
        across: 'flats',
        cornerRadius: '2.5',
        rotation: '30',
      },
      spacing: { gap: '3' },
      margin: '5',
      depth: '2',
      chamfer: { width: '0.5' },
    })) as { cells: number; operationIds: string[]; warnings: { code: string }[] }
    expect(out.cells).toBe(11)
    expect(out.operationIds).toEqual(['pattern1_pocket', 'pattern1_chamfer'])
    expect(out.warnings).toEqual([])
    await s.run('project.apply', {})

    // the bevel of a convex cell, 90° (h = w): h·(P·w/2 + π·w²/3) per cell, beyond the pocket
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const pocket = input.operations[0]!
    if (pocket.kind !== 'pocket' || pocket.shape.contour.kind !== 'region')
      throw new Error('no region')
    const pieces = pocket.shape.contour.region.pieces
    const area = regionArea({ pieces: [pieces[0]!] })
    const P = chainLength(pieces[0]!.outer)
    const w = 0.5
    const solid = kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap()
    const want = 11 * (area * 2 + w * ((P * w) / 2 + (Math.PI * w * w) / 3))
    expect(Math.abs(80 * 50 * 12 - solid.volume - want) / want).toBeLessThan(0.002)

    // the chamfer after the pocket, with the V-bit, one ring per cell at the bevel's depth
    const { lines, planId } = await planExportRun(s, svc)
    const ops = opsOf(s.plan(planId))
    expect(ops.map((o) => o.designOperationIds.join('+'))).toEqual([
      'pattern1_pocket',
      'pattern1_chamfer',
    ])
    const chamfer = ops[1]!
    const tp = (
      s.query('plan.toolpath.get', { planId, planOperationId: chamfer.id }) as {
        toolpath: Toolpath
      }
    ).toolpath
    const zs = tp.passes.flatMap((p) => p.moves.map((m) => (m.kind === 'drill' ? 0 : m.to[2])))
    expect(Math.min(...zs)).toBeCloseTo(-0.5, 9)
    // one plunge to the bevel's depth per cell
    let z = Infinity
    let plunges = 0
    for (const m of tp.passes.flatMap((p) => p.moves)) {
      if (m.kind === 'drill') continue
      if (m.kind === 'line' && Math.abs(m.to[2] + 0.5) < 1e-9 && z > m.to[2] + 1e-9) plunges++
      z = m.to[2]
    }
    expect(plunges).toBe(11)
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot(
      '__golden__/pattern-honeycomb-chamfer.nc',
    )
  })
})

/** The lowest Z of a plan operation's toolpath for `designId`. */
function lowestZ(s: Awaited<ReturnType<typeof planSetup>>, planId: string, designId: string) {
  const op = s
    .plan(planId)
    .setups.flatMap((x) => x.operations)
    .find((o) => o.designOperationIds.includes(designId))!
  const tp = (
    s.query('plan.toolpath.get', { planId, planOperationId: op.id }) as {
      toolpath: Toolpath
    }
  ).toolpath
  return {
    tp,
    z: Math.min(
      ...tp.passes.flatMap((p) => p.moves.map((m) => (m.kind === 'drill' ? 0 : m.to[2]))),
    ),
  }
}

describe('patterns P4 exit', () => {
  it("cnc-code's lace on a grid: a pattern stacked on another's floor, volume, plan, golden, machine", async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc, stock: LID })
    const grid = (await s.run('design.pattern.add', {
      partId: s.partId,
      name: 'Grid',
      lattice: 'square',
      cell: { kind: 'rectangle', length: '30', width: '30', cornerRadius: '4' },
      spacing: { gap: '6' },
      origin: ['22', '25'],
      margin: '4',
      depth: '3',
    })) as { cells: number }
    expect(grid.cells).toBe(2)
    const lace = (await s.run('design.pattern.add', {
      partId: s.partId,
      name: 'Lace',
      on: 'pattern1_pocket.floor',
      lattice: 'hex',
      cell: { kind: 'circle', diameter: '5' },
      spacing: { gap: '1.5' },
      margin: '1.5',
      depth: '1.5',
    })) as { cells: number; warnings: { code: string; severity: string }[] }
    expect(lace.cells).toBe(18)
    expect(lace.warnings.filter((w) => w.severity !== 'info')).toEqual([])
    await s.run('project.apply', {})

    // removed volume = the grid's cells × 3 + the lace's cells × 1.5
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const area = (id: string) => {
      const op = input.operations.find((o) => o.id === id)!
      if (op.kind !== 'pocket' || op.shape.contour.kind !== 'region') throw new Error('no region')
      return op.shape.contour.region
    }
    const below = area('pattern1_pocket')
    const cells = area('pattern2_pocket')
    expect(cells.pieces).toHaveLength(lace.cells)
    // the lace lies within the grid's cells less its margin
    const out = expectOk(region2d.difference(cells, expectOk(region2d.offset(below, 1.5))))
    expect(regionArea(out)).toBeLessThan(1e-6)
    const solid = kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap()
    const want = regionArea(below) * 3 + regionArea(cells) * 1.5
    expect(Math.abs(80 * 50 * 12 - solid.volume - want) / want).toBeLessThan(0.002)

    // the lace after the grid, from the grid's floor down 1.5 mm
    const { lines, planId } = await planExportRun(s, svc)
    expect(opsOf(s.plan(planId)).map((o) => o.designOperationIds.join('+'))).toEqual([
      'pattern1_pocket',
      'pattern2_pocket',
    ])
    expect(lowestZ(s, planId, 'pattern1_pocket').z).toBeCloseTo(-3, 9)
    expect(lowestZ(s, planId, 'pattern2_pocket').z).toBeCloseTo(-4.5, 9)
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('__golden__/pattern-lace-stack.nc')
  })

  it('a through grille in a 6 mm panel: no slug, cut through + breakthrough, golden, machine', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const panel = {
      ...LID,
      name: 'Panel',
      thickness: '6',
      material: { name: 'Birch plywood', class: 'sheetGood' as const },
    }
    const s = await planSetup({ part: false, services: svc, stock: panel })
    const out = (await s.run('design.pattern.add', {
      partId: s.partId,
      name: 'Grille',
      lattice: 'hex',
      cell: { kind: 'circle', diameter: '6' },
      spacing: { gap: '2' },
      margin: '5',
      through: true,
    })) as { cells: number; warnings: { code: string; severity: string }[] }
    expect(out.cells).toBeGreaterThan(20)
    expect(out.warnings.filter((w) => w.severity !== 'info')).toEqual([])
    await s.run('project.apply', {})

    // every cell cleared through the 6 mm, no floor and so no slug: cells' area × 6 removed
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const pocket = input.operations[0]!
    if (pocket.kind !== 'pocket' || pocket.shape.contour.kind !== 'region')
      throw new Error('no region')
    expect(pocket).toMatchObject({ depth: 6, through: true })
    const solid = kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap()
    const want = regionArea(pocket.shape.contour.region) * 6
    expect(Math.abs(80 * 50 * 6 - solid.volume - want) / want).toBeLessThan(0.006)

    // cut to the thickness + the 0.5 mm breakthrough
    const { lines, planId, toolpath } = await planExportRun(s, svc)
    const zs = toolpath.passes.flatMap((p) =>
      p.moves.map((m) => (m.kind === 'drill' ? 0 : m.to[2])),
    )
    expect(Math.min(...zs)).toBeCloseTo(-6.5, 9)
    const op = opsOf(s.plan(planId))[0]!
    expect(op.strategy).not.toHaveProperty('breakthrough')
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot(
      '__golden__/pattern-through-grille.nc',
    )
  })
})

describe('patterns P5 exit', () => {
  const vbit = () =>
    libraryInput({
      name: 'V-bit 90°',
      type: 'chamferMill' as const,
      diameter: len('6'),
      angle: deg('90'),
      fluteLength: len('8'),
      overallLength: len('50'),
      fluteCount: num('2'),
      toolMaterial: 'carbide' as const,
      presets: [],
    })

  it('flipped triangles on the lid: nested at the gap, volume, plan, golden, machine', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc, stock: LID })
    const out = (await s.run('design.pattern.add', {
      partId: s.partId,
      name: 'Triangles',
      lattice: 'square',
      alternate: 'flip',
      cell: { kind: 'polygon', sides: '3', diameter: '14', across: 'corners', cornerRadius: '2' },
      spacing: { gap: '2' },
      margin: '4',
      depth: '1.5',
    })) as { cells: number; warnings: { code: string; severity: string }[] }
    expect(out.cells).toBeGreaterThan(15)
    expect(out.warnings.filter((w) => w.severity !== 'info')).toEqual([])
    await s.run('project.apply', {})

    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const pocket = input.operations[0]!
    if (pocket.kind !== 'pocket' || pocket.shape.contour.kind !== 'region')
      throw new Error('no region')
    // the cells keep the 2 mm web: grown by 0.99 they stay apart, by 1.01 they merge
    const region = pocket.shape.contour.region
    expect(expectOk(region2d.offset(region, -0.99)).pieces).toHaveLength(out.cells)
    expect(expectOk(region2d.offset(region, -1.01)).pieces.length).toBeLessThan(out.cells)
    const solid = kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap()
    const want = regionArea(region) * 1.5
    expect(Math.abs(80 * 50 * 12 - solid.volume - want) / want).toBeLessThan(0.002)

    const { lines, toolpath } = await planExportRun(s, svc)
    const zs = toolpath.passes.flatMap((p) =>
      p.moves.map((m) => (m.kind === 'drill' ? 0 : m.to[2])),
    )
    expect(Math.min(...zs)).toBeCloseTo(-1.5, 9)
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot(
      '__golden__/pattern-triangles-flip.nc',
    )
  })

  it('a through grille chamfered top and bottom: two setups, the bottom bevel from the flip, goldens, machine', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const panel = {
      ...LID,
      name: 'Panel',
      thickness: '6',
      material: { name: 'Birch plywood', class: 'sheetGood' as const },
    }
    const s = await planSetup({ part: false, services: svc, stock: panel })
    await s.run('library.tool.add', { values: vbit() })
    const out = (await s.run('design.pattern.add', {
      partId: s.partId,
      name: 'Grille',
      lattice: 'hex',
      cell: { kind: 'circle', diameter: '6' },
      spacing: { gap: '2' },
      margin: '5',
      through: true,
      chamfer: { width: '0.5', side: 'both' },
    })) as { cells: number; operationIds: string[]; warnings: { code: string; severity: string }[] }
    expect(out.operationIds).toEqual([
      'pattern1_pocket',
      'pattern1_chamfer',
      'pattern1_bottomChamfer',
    ])
    expect(out.warnings.filter((w) => w.severity !== 'info')).toEqual([])
    await s.run('project.apply', {})

    // both bevels: 2 × h·(P·w/2 + π·w²/3) per Ø 6 cell (90°, h = w), beyond the through cells
    const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
    const pocket = input.operations[0]!
    if (pocket.kind !== 'pocket' || pocket.shape.contour.kind !== 'region')
      throw new Error('no region')
    const w = 0.5
    const P = Math.PI * 6
    const bevels = 2 * out.cells * w * ((P * w) / 2 + (Math.PI * w * w) / 3)
    const volume = (operations: typeof input.operations) =>
      kernel
        .withSolids((x) => evaluatePart({ ...input, operations }, x, undefined, region2d))
        .unwrap().volume
    const cut = volume(input.operations.slice(0, 1)) - volume(input.operations)
    expect(Math.abs(cut - bevels) / bevels).toBeLessThan(0.002)

    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const setups = s.plan(planId).setups
    expect(setups.map((x) => [x.name, x.direction ?? '+z'])).toEqual([
      ['Top', '+z'],
      ['Bottom', '-z'],
    ])
    expect(setups[0]!.operations.flatMap((o) => o.designOperationIds)).toEqual([
      'pattern1_pocket',
      'pattern1_chamfer',
    ])
    expect(setups[1]!.operations.flatMap((o) => o.designOperationIds)).toEqual([
      'pattern1_bottomChamfer',
    ])
    const warnings = (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] })
      .warnings
    expect(warnings.filter((x) => x.severity === 'error')).toEqual([])
    // plan.operation.list: the through pocket's material, 6 mm
    const listed = (
      s.query('plan.operation.list', { planId }) as {
        operations: { designOperationIds: string[]; throughDepth: number | null }[]
      }
    ).operations
    const through = (id: string) => listed.find((o) => o.designOperationIds.includes(id))
    expect(through('pattern1_pocket')?.throughDepth).toBe(6)
    expect(through('pattern1_chamfer')?.throughDepth).toBeNull()

    const { jobId } = expectOk(await s.d.dispatch('plan.toolpath.generate', { planId }, ui))
      .value as { jobId: string }
    const gen = expectOk(await s.d.job(jobId).unwrap().result) as {
      operations: { status: string }[]
    }
    expect(gen.operations.every((o) => o.status === 'generated')).toBe(true)
    // the bottom bevel: tip at Z −0.5 below the bottom face, one ring per cell
    expect(lowestZ(s, planId, 'pattern1_bottomChamfer').z).toBeCloseTo(-0.5, 9)
    const machine = loadPlan(s.d.doc, planId, 'test').unwrap().machine.unwrap()
    for (const [i, setup] of setups.entries()) {
      const e = expectOk(await exportPlan(s.d.doc, planId, svc as never, { setupId: setup.id }))
      const run = await streamProgram(e.lines, machine)
      expect(run.lines).toBe(e.lines.length)
      await expect(e.lines.join('\n') + '\n').toMatchFileSnapshot(
        `__golden__/pattern-through-grille-chamfer-${i === 0 ? 'top' : 'bottom'}.nc`,
      )
    }
  })
})
