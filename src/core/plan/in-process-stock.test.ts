// Cut state C5 (hardening DF135, docs/modes/cut-state.md#in-process-stock-display-c5): the
// removed-material input of the in-process stock display – only the already-cut operations'
// toolpaths, in machining order, waiting while one is missing – and its mesh: the faced top and
// the cut pocket in the material left, the bottom map mirrored, a column cut through empty.
import { describe, expect, it } from 'vitest'
import { Ok } from '../../shared/result'
import { expectOk } from '../../shared/testing/result'
import { createInProcessWorkers } from '../commands/jobs'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import { exportPlan } from '../post/plan-export'
import { createToolpathCache } from '../toolpath/cache'
import { simulateHeightmap, type CutMap } from '../toolpath/simulate'
import {
  inProcessCell,
  inProcessStockInput,
  inProcessStockMesh,
  meshVolume,
  type CutToolpathEntry,
} from './in-process-stock'
import { loadPlanDTO } from './plan'
import { planSetup } from './plan.fixture'

const region2d = nodeRegion2d()

async function cutPart() {
  const svc = {
    region2d,
    toolpaths: createToolpathCache(),
    workers: createInProcessWorkers({ region2d: () => Ok(region2d) }),
  }
  const s = await planSetup({
    part: false,
    services: svc,
    stock: {
      name: 'Block',
      shape: 'block' as const,
      length: '80',
      width: '50',
      thickness: '12',
      material: { name: 'Walnut', class: 'hardwood' as const },
    },
  })
  await s.run('design.facing.add', { partId: s.partId, depth: '0.5' })
  await s.run('design.pocket.add', {
    partId: s.partId,
    on: 'facing1.floor',
    shape: {
      kind: 'rectangle',
      center: ['40', '25'],
      length: '40',
      width: '30',
      cornerRadius: '3',
    },
    depth: '6',
  })
  await s.run('project.apply', {})
  const planId = await s.create({ machineLibraryItemId: s.machineId })
  // the real cut: every toolpath generated (the mark is not in their input hash)
  expectOk(await exportPlan(s.d.doc, planId, svc as never))
  const toolpathOf = (planOperationId: string) =>
    s.query('plan.toolpath.get', { planId, planOperationId }) as CutToolpathEntry
  const loaded = () => expectOk(loadPlanDTO(s.plan(planId), 'mm', 'test'))
  return { s, planId, toolpathOf, loaded }
}

describe('in-process stock (C5): the removed-material input', () => {
  it('takes only the already-cut operations, and draws the faced top and the cut pocket', async () => {
    const { s, planId, toolpathOf, loaded } = await cutPart()
    expect(inProcessStockInput(loaded(), toolpathOf)).toEqual({ kind: 'none' })
    await s.run('design.part.update', { partId: s.partId, alreadyCut: ['facing1', 'pocket1'] })
    // new work after the cut: a pocket in the floor, not cut, not in the input
    await s.run('design.pocket.add', {
      partId: s.partId,
      on: 'pocket1.floor',
      shape: {
        kind: 'rectangle',
        center: ['35', '25'],
        length: '20',
        width: '10',
        cornerRadius: '3',
      },
      depth: '3',
    })
    await s.run('project.apply', {})
    const ops = s.plan(planId).setups[0]!.operations
    // the new pocket has no toolpath yet: it does not hold the display back; the cut pocket's
    // is stale (the work on its floor changed its inputs) and is drawn as last generated
    const input = inProcessStockInput(loaded(), toolpathOf)
    if (input.kind !== 'ready') throw new Error(`not ready: ${JSON.stringify(input)}`)
    expect(input.operations).toEqual(ops.slice(0, 2).map((o) => o.id))
    expect(input.simulate.setups).toHaveLength(1)
    expect(input.simulate.setups[0]!.toolpaths).toHaveLength(2)
    expect(input.simulate.cell).toBe(0.5)
    expect(input.sides).toBe(false)
    expect(input.outdated).toBe(true)
    // the same toolpaths give the same key (the window's cache)
    expect(inProcessStockInput(loaded(), toolpathOf)).toMatchObject({ key: input.key })

    const t0 = performance.now()
    const maps = expectOk(simulateHeightmap(input.simulate))
    const mesh = inProcessStockMesh(maps, input.simulate.stock)
    const ms = performance.now() - t0
    const top = maps[0]!
    const h = (x: number, y: number) => top.h[Math.floor(y / 0.5) * top.nu + Math.floor(x / 0.5)]!
    expect(h(40, 25)).toBeCloseTo(-6.5, 3) // the pocket's floor
    expect(h(5, 5)).toBeCloseTo(-0.5, 3) // the faced top
    // the solid: the faced block less the pocket (R3 corners), within the wall cells' slope
    const expected = 80 * 50 * 11.5 - (40 * 30 - (4 - Math.PI) * 9) * 6
    expect(Math.abs(meshVolume(mesh) - expected) / expected).toBeLessThan(0.01)
    // 2 × 160 × 100 vertices; fast enough to run in the window (measured ~13 ms)
    expect(mesh.positions.length).toBe(2 * 160 * 100 * 3)
    expect(ms).toBeLessThan(1000)
  }, 120_000)

  it('waits while a cut operation has no toolpath', async () => {
    const { s, toolpathOf, loaded } = await cutPart()
    await s.run('design.part.update', { partId: s.partId, alreadyCut: ['pocket1'] })
    await s.run('project.apply', {})
    const plan = loaded()
    const pocket = plan.setups[0]!.operations[1]!.id
    expect(inProcessStockInput(plan, () => undefined)).toEqual({
      kind: 'waiting',
      missing: [pocket],
    })
    const none = (id: string) => ({ ...toolpathOf(id), toolpath: null })
    expect(inProcessStockInput(plan, none)).toEqual({ kind: 'waiting', missing: [pocket] })
    expect(inProcessStockInput(plan, toolpathOf)).toMatchObject({ kind: 'ready', outdated: false })
  }, 120_000)

  it('keeps the map within its cell budget', () => {
    expect(inProcessCell({ length: 100, width: 72, thickness: 12 })).toBe(0.5)
    const big = { length: 1200, width: 600, thickness: 18 }
    const cell = inProcessCell(big)
    expect(Math.ceil(big.length / cell) * Math.ceil(big.width / cell)).toBeLessThanOrEqual(150_000)
  })
})

describe('in-process stock (C5): the mesh', () => {
  const stock = { length: 10, width: 10, thickness: 5 }
  const map = (direction: CutMap['direction'], fill: number): CutMap & { h: Float32Array } => ({
    direction,
    cell: 1,
    nu: 10,
    nv: 10,
    h: new Float32Array(100).fill(fill),
    by: new Uint16Array(100),
  })

  it('is the raw block without maps, closed and wound outwards', () => {
    expect(meshVolume(inProcessStockMesh([], stock))).toBeCloseTo(500, 6)
  })

  it('raises the bottom by the bottom map and empties a column cut through, mirrored', () => {
    const top = map('+z', -0.5)
    const bottom = map('-z', -1)
    expect(meshVolume(inProcessStockMesh([top, bottom], stock))).toBeCloseTo(100 * 3.5, 4)
    // through from below at the bottom frame's cells (0..2, 0..2): the part's back left corner
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) bottom.h[j * 10 + i] = -5
    const mesh = inProcessStockMesh([top, bottom], stock)
    const n = 100
    const z = (i: number, j: number, under: boolean) =>
      mesh.positions[3 * ((under ? n : 0) + j * 10 + i) + 2]!
    expect(z(1, 8, true)).toBeCloseTo(0, 6) // at y = 8.5: bottom frame v = 1.5, cut through
    expect(z(1, 1, true)).toBeCloseTo(-4, 6) // the front left corner is not
    // no triangle touches an empty column
    const empty = new Set([n + 8 * 10 + 1, 8 * 10 + 1])
    expect([...mesh.indices].some((k) => empty.has(k))).toBe(false)
  })
})
