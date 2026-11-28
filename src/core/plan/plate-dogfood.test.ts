// The user's whole plate job (TG #492, dogfood 2026-11-28) with the tools built for it: a 100 × 60
// × 10.1 aluminium plate, a 22 mm facing band along the front edge (DF145), an M6 90° countersunk
// bolt hole cloned ×4 (DF146: one plan operation per clone group), a straight through Line cutting
// the 22 mm part off with the 1/4" flat and a 1 mm one-sided chamfer on the part's wall (DF147).
// Planned with the user's tools and stop block; on the heightmap of every toolpath in machining
// order: the band faced and nothing else, the holes through, the countersinks' cone, the slot
// through, the bevel on the part only; no feed move meets more than its pass of uncut material
// (DF144 `deepCuts`); no move near the block. Report: docs/research/2026-11-28-plate-dogfood.md
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { partGeometryInput } from '../design/load'
import { evaluatePart } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { nodeManifoldSource } from '../geometry/testing/node-wasm'
import type { Toolpath, ToolpathTool } from '../toolpath/model'
import { createToolpathCache } from '../toolpath/cache'
import { chamferMill, endMill } from '../toolpath/testing/fixtures'
import { Heightmap, samples, steps } from '../toolpath/testing/oracles'
import { deepCuts } from '../toolpath/testing/region-coverage'
import type { PlanWarning } from './checks'
import { generated } from './line-through.fixture'
import { opsOf, planSetup } from './plan.fixture'

const region2d = nodeRegion2d()
const STOCK = {
  name: 'Aluminium 6061-T6 100 × 60 × 10.1',
  shape: 'block' as const,
  length: '100',
  width: '60',
  thickness: '10.1',
  material: { name: '6061-T6', class: 'aluminum' as const },
}
const R = 6.22 / 2
/** The part's wall: the cut-off's centreline is 22 + R from the front edge. */
const WALL = 22
const HOLES = [20, 40, 60, 80].map((x) => [x, 11] as const)
const HOLE_R = 6.6 / 2
const CS_R = 13.84 / 2
const FACE = -0.2
const BOTTOM = -10.1

describe("the user's plate job (dogfood TG #492)", () => {
  it('faces the band only, drills and countersinks ×4, cuts off through, bevels the part', async () => {
    const svc = {
      region2d,
      toolpaths: createToolpathCache(),
      workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
    }
    const s = await planSetup({ part: false, services: svc, stock: STOCK })
    const add = async (values: object) =>
      ((await s.run('library.tool.add', { values })) as { id: string }).id
    const tool = (values: object) => ({ overallLength: '50', toolMaterial: 'carbide', ...values })
    const flat = await add(
      tool({
        name: 'wexme 1/4in 1F',
        type: 'flatEndMill',
        diameter: '6.22',
        fluteLength: '20',
        fluteCount: '1',
      }),
    )
    const finish = await add(
      tool({
        name: 'Finishing 1/4in 3F',
        type: 'flatEndMill',
        diameter: '6.33',
        fluteLength: '20',
        fluteCount: '3',
      }),
    )
    const vbit = await add(
      tool({
        name: '90 V-bit 1/4in',
        type: 'chamferMill',
        diameter: '1/4"',
        angle: '90',
        fluteLength: '5',
        fluteCount: '3',
      }),
    )
    const partId = s.partId
    const specific = (id: string) => ({ kind: 'specific', toolLibraryItemId: id })
    await s.run('design.facing.add', {
      partId,
      depth: '0.2',
      region: { band: { edge: 'front', width: '22' } },
      tool: specific(finish),
    })
    // DF154: no `on`: a hole in the band stands on the band's floor by default
    await s.run('design.hole.add', {
      partId,
      center: ['20', '11'],
      type: 'countersink',
      fastener: 'M6',
    })
    await s.run('design.clones.add', {
      partId,
      source: { featureId: 'hole1' },
      rows: [{ kind: 'offset', count: 3, du: '20', dv: '0' }],
    })
    await s.run('design.line.add', {
      partId,
      paths: [{ segment: { start: ['0', '22 + 6.22/2'], end: ['100', '22 + 6.22/2'] } }],
      depth: 'through',
    })
    await s.run('design.chamfer.add', { partId, edgeOf: 'line1', width: '1', edgeSide: 'right' })
    for (const [operationId, id] of [
      ['hole1_drill', flat],
      ['hole1_countersink', vbit],
      ['line1', flat],
      ['chamfer1', vbit],
    ] as const)
      await s.run('design.operation.tool.set', { partId, operationId, tool: specific(id) })
    await s.run('project.apply', {})

    // DF160: the design's cut-off warning names the offcut (the chamfer keeps the part's side)
    const kernel = (await loadManifold(nodeManifoldSource())).unwrap()
    const input = expectOk(partGeometryInput(s.d.doc, partId, region2d))
    const solid = kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d)).unwrap()
    const cut = solid.warnings.filter((w) => w.code === 'dfm.loosePiece')
    expect(cut).toMatchObject([{ operation: 'line1', params: { cutOff: true, kept: true } }])
    expect(cut[0]!.message).toMatch(/^line1: cuts the offcut \(\d+\.\d mm³\) off the part/)
    // the offcut is the 100 × (60 − 22 − 6.22) mm side, not the kept 22 mm strip
    expect(cut[0]!.params['volume']).toBeCloseTo(100 * (60 - 22 - 6.22) * 10.1, -2)

    const planId = await s.create({ machineLibraryItemId: s.machineId })
    const setupId = s.plan(planId).setups[0]!.id
    // the user's stop block left of the stock, below its top
    await s.run('plan.workholding.set', {
      planId,
      setupId,
      items: [{ kind: 'block', center: ['-9.5', '87'], length: '18', width: '80', top: '-0.6' }],
    })
    // DF146: one plan operation per clone group, in a safe order (the cut-off last); DF152: the
    // part's one-sided chamfer before the cut-off (its bevel lies on the kept side), right after
    // the countersinks' V-bit: no tool change once the part comes loose
    const ops = opsOf(s.plan(planId))
    expect(ops.map((o) => [o.designOperationIds[0], o.designOperationIds.length])).toEqual([
      ['facing1', 1],
      ['hole1_drill', 4],
      ['hole1_countersink', 4],
      ['chamfer1', 1],
      ['line1', 1],
    ])
    for (const op of ops)
      await s.run('plan.operation.update', {
        planId,
        planOperationId: op.id,
        overrides: {
          spindleSpeed: '18000',
          feedRate: '600',
          plungeRate: '150',
          ...(op.designOperationIds[0] === 'line1' ? { stepdown: '0.5' } : {}),
        },
        ...(op.designOperationIds[0] === 'line1' ? { strategy: { breakthrough: '0.4' } } : {}),
      })
    const warnings = (s.query('plan.warning.list', { planId }) as { warnings: PlanWarning[] })
      .warnings
    expect(warnings.filter((w) => w.severity === 'error')).toEqual([])
    // the only workholding finding: the part comes loose (the block holds neither side)
    expect(
      warnings.filter((w) => w.code.startsWith('plan.workholding')).map((w) => w.rule),
    ).toEqual(['cutOffLoose'])
    const loose = warnings.find((w) => w.rule === 'cutOffLoose')!
    expect(loose.params).toMatchObject({ kept: 'right' })
    expect(loose.message).toMatch(
      /the offcut \(left of .*\) and the part \(right of .*\) are not held and come loose/,
    )
    // DF152: nothing is cut after the cut-off, so nothing on a loose piece
    expect(warnings.filter((w) => w.code === 'plan.loosePiece')).toEqual([])

    const tps: { tool: ToolpathTool; tp: Toolpath; stepdown: number; id: string }[] = []
    const T = { facing1: endMill(6.33, 20), flat: endMill(6.22, 20), vbit: chamferMill(6.35, 90) }
    for (const [id, t, stepdown] of [
      ['facing1', T.facing1, 0.2],
      // DF159: ρ 0.19 < R/4, so each helix turn descends the helix pitch (0.25 DC) at the
      // plunge rate, as the straight plunge below 0.1 mm does
      ['hole1_drill', T.flat, 0.25 * 6.22],
      // the countersink's rings by level (DF142): each meets at most its level of the cone
      ['hole1_countersink', T.vbit, 1.25],
      ['chamfer1', T.vbit, 1],
      ['line1', T.flat, 0.5],
    ] as const)
      tps.push({ id, tool: t, tp: await generated(s, planId, id), stepdown })

    // DF159: the Ø6.6 bore with the Ø6.22 flat is 7 turns (≈ 7 s per hole), not 169 (≈ 33 s)
    const bore = tps.find((x) => x.id === 'hole1_drill')!.tp.stats.estimatedSeconds
    expect(bore / 4).toBeLessThan(10)

    // DF144: no feed move buries the tool deeper than its pass, after everything cut before it
    for (const [i, x] of tps.entries())
      expect(
        deepCuts(
          x.tp,
          x.tool,
          { length: 100, width: 60 },
          { stepdown: x.stepdown, finishRadial: 0 },
          { before: tps.slice(0, i), cell: 0.1 },
        ),
        x.id,
      ).toEqual([])

    // nothing within 2 mm of the block below its top + 2 mm
    for (const x of tps)
      for (const st of steps(x.tp))
        for (const p of samples(st, 0.5)) {
          const near = p[0] > -18.5 - R - 2 && p[0] < -0.5 + R + 2 && p[1] > 47 - R - 2
          if (near) expect(p[2], `${x.id} at ${p.join(',')}`).toBeGreaterThanOrEqual(-0.6 + 2)
        }

    const hm = new Heightmap(100, 60, 0.1)
    for (const x of tps) hm.sweep(x.tool, x.tp, 0.1)
    const bad: Record<string, number> = {}
    const count = (k: string) => (bad[k] = (bad[k] ?? 0) + 1)
    for (let j = 0; j < hm.ny; j++)
      for (let i = 0; i < hm.nx; i++) {
        const [x, y] = hm.center(i, j)
        const z = hm.z[j * hm.nx + i]!
        const r = Math.min(...HOLES.map(([hx, hy]) => Math.hypot(x - hx, y - hy)))
        if (r < HOLE_R - 0.1) {
          if (z > BOTTOM) count('hole not through')
        } else if (r > HOLE_R + 0.1 && r < CS_R - 0.1) {
          // the 90° countersink cone from the hole's edge up to the faced band
          const expected = FACE - (CS_R - r)
          if (Math.abs(z - expected) > 0.08) count('countersink cone')
        } else if (r > CS_R + 0.1 && y < WALL - 1.1) {
          if (Math.abs(z - FACE) > 0.02) count('band not faced flat')
        } else if (y > WALL - 0.9 && y < WALL - 0.1) {
          // the part's bevel: 1 mm below the stock top at the wall, 45° up to the faced band
          const expected = Math.min(FACE, -(1 - (WALL - y)))
          if (Math.abs(z - expected) > 0.08) count('bevel')
        } else if (y > WALL + 0.1 && y < WALL + 2 * R - 0.1) {
          if (z > BOTTOM) count('slot not through')
        } else if (y > WALL + 2 * R + 0.1) {
          if (z < -1e-6) count('offcut touched')
        }
      }
    expect(bad).toEqual({})
  })
})
