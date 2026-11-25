// The pattern's roughing (hardening DF108) through its commands: `roughing: true` adds the owned
// `<id>_roughing` before the pocket (same `on`, shape, depth and through, `roughing: true`), stored
// only when on, removed when off, one undo step. Its floor is no face target and it removes no
// material of its own. Its tool fits a cell and is at most 0.6 × the widest cell's width (rule
// `roughingWidth`), so the auto choice takes a Ø 6 in 10 mm hexagons while the pocket takes a
// Ø 2 for their R 1 corners, and no rest or corner finding is reported for the roughing.
// Spec: docs/modes/patterns.md#roughing-df108
import { beforeAll, describe, expect, it } from 'vitest'
import { expectOk } from '../../../shared/testing/result'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { evaluatePart } from '../../geometry/evaluate'
import { loadManifold } from '../../geometry/manifold'
import type { SolidKernel } from '../../geometry/solid-port'
import { uiSource } from '../../commands/testing'
import { designSetup, type DesignSetup } from '../design.fixture'
import { partGeometryInput } from '../load'

const region2d = nodeRegion2d()
const setup = () => designSetup({ services: { region2d } })
let kernel: SolidKernel
beforeAll(async () => {
  kernel = expectOk(await loadManifold())
})

interface Result {
  featureId: string
  operationIds: string[]
  warnings: { code: string; operation: string; parameter?: string; params: { rule?: string } }[]
}

const HONEYCOMB = {
  lattice: 'hex',
  cell: {
    kind: 'polygon',
    sides: '6',
    diameter: '10',
    across: 'flats',
    cornerRadius: '1',
    rotation: '30',
  },
  spacing: { gap: '2' },
  depth: '3',
}

const add = async (s: DesignSetup, args: object = {}) =>
  (await s.run('design.pattern.add', { partId: s.partId, ...HONEYCOMB, ...args })) as Result
const update = async (s: DesignSetup, args: object) =>
  (await s.run('design.pattern.update', {
    partId: s.partId,
    featureId: 'pattern1',
    ...args,
  })) as Result
const ops = (s: DesignSetup) => s.part().operations.map((o) => o.id)
const op = (s: DesignSetup, id: string) =>
  s.part().operations.find((o) => o.id === id) as unknown as Record<string, unknown>
const toolDiameter = (s: DesignSetup, id: string) =>
  (op(s, id)['tool'] as { diameter?: { source?: string } } | undefined)?.diameter?.source

describe('roughing (DF108)', () => {
  it('adds the owned roughing pocket before the pocket, stored only when on; off removes it; undo', async () => {
    const s = await setup()
    const plain = await add(s)
    expect(plain.operationIds).toEqual(['pattern1_pocket'])
    expect(s.part().features?.[0]).not.toHaveProperty('roughing')
    const on = await update(s, { roughing: true })
    expect(on.operationIds).toEqual(['pattern1_roughing', 'pattern1_pocket'])
    expect(ops(s)).toEqual(['pattern1_roughing', 'pattern1_pocket'])
    expect(s.part().features?.[0]).toMatchObject({ roughing: true })
    const r = op(s, 'pattern1_roughing')
    const p = op(s, 'pattern1_pocket')
    expect(r).toMatchObject({ kind: 'pocket', roughing: true, on: p['on'], shape: p['shape'] })
    expect(r['depth']).toEqual(p['depth'])
    expect(p).not.toHaveProperty('roughing')
    // a depth edit moves both
    await update(s, { depth: '4' })
    expect((op(s, 'pattern1_roughing')['depth'] as { source: string }).source).toBe('4')
    await update(s, { roughing: false })
    expect(ops(s)).toEqual(['pattern1_pocket'])
    expect(s.part().features?.[0]).not.toHaveProperty('roughing')
    await s.undo()
    expect(ops(s)).toEqual(['pattern1_roughing', 'pattern1_pocket'])
    await s.undo()
    await s.undo()
    expect(ops(s)).toEqual(['pattern1_pocket'])
  })

  it('through cells: the roughing pocket is through too', async () => {
    const s = await setup()
    await add(s, { through: true, roughing: true })
    expect(op(s, 'pattern1_roughing')).toMatchObject({ through: true, roughing: true })
  })

  it('auto tools: a Ø 6 roughs the 10 mm hexagons, a Ø 2 cuts their R 1 corners; no rest finding', async () => {
    const s = await setup()
    const out = await add(s, { roughing: true })
    expect(out.warnings.filter((w) => w.operation === 'pattern1_roughing')).toEqual([])
    await s.run('project.apply', {})
    expect(toolDiameter(s, 'pattern1_roughing')).toBe('6 mm')
    expect(toolDiameter(s, 'pattern1_pocket')).toBe('2 mm')
  })

  it('a roughing tool over 0.6 × the cell width is unfit (roughingWidth); one that fits no cell (width)', async () => {
    const s = await setup()
    await add(s, { roughing: true })
    const set = async (diameter: string) =>
      (await s.run('design.operation.tool.set', {
        partId: s.partId,
        operationId: 'pattern1_roughing',
        tool: { kind: 'generalized', type: 'flatEndMill', diameter },
      })) as Result
    const rule = (r: Result) =>
      r.warnings.find((w) => w.code === 'dfm.toolUnfit' && w.operation === 'pattern1_roughing')
        ?.params.rule
    expect(rule(await set('8'))).toBe('roughingWidth')
    expect(rule(await set('12'))).toBe('width')
    expect(rule(await set('6'))).toBeUndefined()
  })

  it('its floor is no face target and it removes nothing of its own (same volume)', async () => {
    const s = await setup()
    await add(s, { roughing: true })
    const refused = await s.d.dispatch(
      'design.pattern.add',
      { partId: s.partId, ...HONEYCOMB, on: 'pattern1_roughing.floor' },
      uiSource(),
    )
    expect(refused.isErr()).toBe(true)
    const volume = () => {
      const input = expectOk(partGeometryInput(s.d.doc, s.partId, region2d))
      return expectOk(kernel.withSolids((x) => evaluatePart(input, x, undefined, region2d))).volume
    }
    const withRoughing = volume()
    expect(expectOk(partGeometryInput(s.d.doc, s.partId, region2d)).operations[0]).toMatchObject({
      id: 'pattern1_roughing',
      roughing: true,
    })
    await update(s, { roughing: false })
    expect(Math.abs(volume() - withRoughing)).toBeLessThan(1e-6)
  })
})
