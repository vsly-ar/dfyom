/**
 * Construction surfaces and `dfm.surfaceCutAway` on parts built through the design commands
 * (DF118): a surface its own dependants cut away is silent, an unrelated later cut warns.
 * Doc: docs/modes/construction-surfaces.md#check-dfmsurfacecutaway
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../shared/testing/result'
import { evaluatePart, type PartEvaluation } from '../geometry/evaluate'
import { loadManifold } from '../geometry/manifold'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import type { SolidKernel } from '../geometry/solid-port'
import { designSetup, type DesignSetup } from './design.fixture'
import { partGeometryInput } from './load'

let kernel: SolidKernel
const port = nodeRegion2d()

beforeAll(async () => {
  kernel = expectOk(await loadManifold())
})

const evaluate = (s: DesignSetup): PartEvaluation => {
  const input = expectOk(partGeometryInput(s.d.doc, s.partId, port))
  return expectOk(kernel.withSolids((solids) => evaluatePart(input, solids, undefined, port)))
}

const cutAway = (e: PartEvaluation) => e.warnings.filter((w) => w.code === 'dfm.surfaceCutAway')

/**
 * The user's clamps_40 (TG #369): facings on both faces, the recess "Pocket for M5" on the bottom
 * facing's floor, the slot "M5 long hole" and its countersink "Chamfer 1" on the recess floor.
 * A chamfer 2.85 mm wide leaves a 0.05 mm rim of recess floor; 3.2 mm leaves none.
 */
async function clamps(chamferWidth: string): Promise<DesignSetup> {
  const s = await designSetup({
    stock: {
      name: 'Al',
      shape: 'block',
      length: '80',
      width: '40.35',
      thickness: '10.11',
      material: { name: '6061-T6', class: 'aluminum' },
    },
  })
  const partId = s.partId
  await s.run('design.facing.add', { partId, depth: '0.3' })
  await s.run('design.facing.add', { partId, on: 'stock.bottom', depth: '0.3' })
  await s.run('design.pocket.add', {
    partId,
    on: 'facing2.floor',
    depth: '2',
    shape: {
      kind: 'rectangle',
      center: ['30', '22'],
      length: '11.3',
      width: '31.0',
      cornerRadius: '5.6',
    },
  })
  await s.run('design.pocket.add', {
    partId,
    on: 'pocket1.floor',
    depth: '7.8',
    shape: {
      kind: 'rectangle',
      center: ['30', '22'],
      length: '5.5',
      width: '25',
      cornerRadius: '2.5',
    },
  })
  await s.run('design.chamfer.add', {
    partId,
    edgeOf: 'pocket2',
    on: 'pocket1.floor',
    width: chamferWidth,
    angle: '90',
  })
  return s
}

describe('construction surfaces (DF118)', { timeout: 60_000 }, () => {
  it('clamps_40 with a 0.05 mm rim: the recess floor keeps triangles, nothing to report', async () => {
    const e = evaluate(await clamps('5.7/2'))
    expect(e.surfaces).toContain('pocket1.floor')
    expect(e.construction).toEqual([])
    expect(cutAway(e)).toEqual([])
  })

  it('clamps_40 without the rim: the slot and the chamfer consume their own floor, no warning', async () => {
    const e = evaluate(await clamps('3.2'))
    expect(e.surfaces).not.toContain('pocket1.floor')
    expect(cutAway(e)).toEqual([])
    expect(e.warnings.map((w) => w.code)).not.toContain('dfm.surfaceCutAway')
    expect(e.construction).toHaveLength(1)
    const c = e.construction[0]!
    expect(c.surface).toBe('pocket1.floor')
    expect(c.consumedBy).toEqual(['pocket2', 'chamfer1'])
    expect(c.referencedBy).toEqual([
      { operationId: 'pocket2', param: 'on' },
      { operationId: 'chamfer1', param: 'on' },
    ])
    // the recess outline at its level, seen from the bottom face: 2 mm under the 0.3 mm facing
    expect(c.patch.direction).toBe('-z')
    expect(c.patch.z).toBeCloseTo(-2.3, 6)
    expect(c.patch.loops).toHaveLength(1)
    const us = c.patch.loops[0]!.map((p) => p[0])
    expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(11.3, 6)
  })

  it('a later facing that erases the floor a pocket stands on warns, naming the facing', async () => {
    const s = await designSetup()
    const partId = s.partId
    await s.run('design.facing.add', { partId, depth: '0.3' })
    await s.run('design.pocket.add', {
      partId,
      on: 'facing1.floor',
      depth: '5',
      shape: { kind: 'rectangle', center: ['50', '30'], length: '40', width: '20' },
    })
    await s.run('design.facing.add', { partId, depth: '2' })
    const e = evaluate(s)
    expect(cutAway(e)).toEqual([
      expect.objectContaining({
        operation: 'pocket1',
        parameter: 'on',
        severity: 'warning',
        params: { surface: 'facing1.floor', by: ['facing2'] },
      }),
    ])
    expect(e.construction.map((c) => [c.surface, c.consumedBy])).toEqual([
      ['facing1.floor', ['pocket1', 'facing2']],
    ])
  })

  it('a stepped pocket of the same outline consumes its own floor: no warning', async () => {
    const s = await designSetup()
    const partId = s.partId
    const shape = { kind: 'rectangle', center: ['50', '30'], length: '40', width: '20' }
    await s.run('design.facing.add', { partId, depth: '0.3' })
    await s.run('design.pocket.add', { partId, on: 'facing1.floor', depth: '2', shape })
    await s.run('design.pocket.add', { partId, on: 'pocket1.floor', depth: '2', shape })
    const e = evaluate(s)
    expect(cutAway(e)).toEqual([])
    expect(e.construction.map((c) => [c.surface, c.consumedBy])).toEqual([
      ['pocket1.floor', ['pocket2']],
    ])
  })
})
