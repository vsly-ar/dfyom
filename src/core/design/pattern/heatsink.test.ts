// Heatsink presets H1 (docs/modes/pattern-presets.md#implementation-h1): `margin: [u, v]` against
// the box-erosion oracle (a rectangle: the area less u and v; a circle: four shifted circles), one
// value byte-equal to today, the exact fit of 11 slots in 37 mm; the Straight fins step (count,
// even-count origin shift, the args of one update, the read-out) and the slot/tool notes (Q206);
// `dfm.patternTallWeb` at 1:8 ± ε.
import { describe, expect, it } from 'vitest'
import { regionArea } from '../../geometry/2d/model'
import { nodeRegion2d } from '../../geometry/2d/testing/node-wasm'
import { translateRegion } from '../../geometry/2d/place'
import { designSetup } from '../design.fixture'
import { resolveDefinition } from '../shape'
import type { ShapeItem } from '../shape.dto'
import {
  slotCut,
  straightFins,
  straightFinsArgs,
  straightFinsReadout,
  type FinsFields,
} from './heatsink'
import { resolvePattern, type PatternDefinition } from './layout'

const port = nodeRegion2d()

/** The user's slot cell: 2 × 40, turned 90° (it runs along v). */
const SLOT: ShapeItem<number> = {
  kind: 'rectangle',
  op: 'add',
  center: [0, 0],
  length: 40,
  width: 2,
  cornerRadius: 0,
}
const def = (over: Partial<PatternDefinition> = {}): PatternDefinition => ({
  kind: 'pattern',
  op: 'add',
  cell: [SLOT],
  cellRotation: 90,
  lattice: 'square',
  angle: 0,
  spacing: { gap: 1.5 },
  boundary: { min: [0, 0], max: [40, 40] },
  margin: [1.5, 0],
  ...over,
})
const resolve = (over: Partial<PatternDefinition> = {}) =>
  resolvePattern(port, def(over), (d) => resolveDefinition(port, d)).unwrap()

describe('margin [u, v]', () => {
  it('the face rectangle less u and v; 11 slots fit 37 mm exactly, open at both ends', () => {
    const p = resolve()
    expect(regionArea(p.area)).toBeCloseTo(37 * 40, 9)
    expect(p.cells).toBe(11)
    const xs = p.region.pieces.map((x) => x.outer.elements.flatMap((e) => [e.a[0]]))
    expect(Math.min(...xs.flat())).toBeCloseTo(1.5, 9)
    expect(Math.max(...xs.flat())).toBeCloseTo(38.5, 9)
    const ys = p.region.pieces.flatMap((x) => x.outer.elements.map((e) => e.a[1]))
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([0, 40])
    // a hair less room: 10
    expect(resolve({ margin: [1.5001, 0] }).cells).toBe(9)
  })

  it('one value is the round offset as before; [m, m] on a rectangle is the same area', () => {
    const one = resolve({ margin: 2, cell: [{ ...SLOT, length: 10 }] })
    const pair = resolve({ margin: [2, 2], cell: [{ ...SLOT, length: 10 }] })
    expect(regionArea(pair.area)).toBeCloseTo(regionArea(one.area), 9)
    expect(pair.cells).toBe(one.cells)
  })

  it('a circle boundary: the intersection of four shifted circles', () => {
    const circle: ShapeItem<number> = { kind: 'circle', op: 'add', center: [0, 0], diameter: 30 }
    const p = resolve({
      cell: [{ kind: 'circle', op: 'add', center: [0, 0], diameter: 2 }],
      cellRotation: 0,
      area: { items: [circle], center: [20, 20], rotation: 0 },
      margin: [3, 1],
    })
    const disc = resolveDefinition(port, [circle]).unwrap()
    if (disc.kind !== 'region') throw new Error('no region')
    const at = (dx: number, dy: number) => translateRegion(disc.region, [20 + dx, 20 + dy])
    // erosion by the 6 × 2 box: the circle moved to the box's four corners
    const want = [at(3, 1), at(-3, 1), at(3, -1), at(-3, -1)].reduce((a, b) =>
      port.intersect(a, b).unwrap(),
    )
    expect(regionArea(p.area)).toBeCloseTo(regionArea(want), 6)
  })
})

describe('Straight fins step', () => {
  const STEP = { fin: 1.5, slot: 2, height: 10, wall: 1.5, across: 40, along: 40, thickness: 14 }

  it("the user's heatsink: 11 slots, 12 fins, walls 1.5, 1:6.7, base 4", () => {
    expect(straightFins(STEP)).toEqual({
      slots: 11,
      fins: 12,
      wall: 1.5,
      pitch: 3.5,
      ratio: 6.7,
      base: 4,
    })
  })

  it('an even count moves the origin half a pitch; walls take the rest', () => {
    const l = straightFins({ ...STEP, across: 37 })!
    // n·2 + (n − 1)·1.5 ≤ 34 → 10 slots, walls (37 − 33.5) / 2
    expect(l).toMatchObject({ slots: 10, fins: 11, wall: 1.75, origin: [20.25, 20], ratio: 6.7 })
    // walls thinner than the fins set the ratio
    expect(straightFins({ ...STEP, across: 36.6 })).toMatchObject({ slots: 10, wall: 1.55 })
    expect(straightFins({ ...STEP, wall: 1, across: 36 })).toMatchObject({ wall: 1.25, ratio: 8 })
    expect(straightFins({ ...STEP, across: 4 })).toBeUndefined()
    expect(straightFins({ ...STEP, fin: 0 })).toBeUndefined()
  })

  it('fills the fields in one update', () => {
    expect(straightFinsArgs(STEP, straightFins(STEP)!)).toEqual({
      cell: {
        kind: 'rectangle',
        length: '40 mm',
        width: '2 mm',
        cornerRadius: '0 mm',
        rotation: '90°',
      },
      lattice: 'square',
      spacing: { gap: '1.5 mm' },
      alternate: 'none',
      angle: '0°',
      origin: null,
      boundary: null,
      margin: ['1.5 mm', '0 mm'],
      fit: 'whole',
      invert: false,
      through: false,
      depth: '10 mm',
    })
  })

  it('reads a pattern back as straight fins, else not', () => {
    const fields: FinsFields = {
      cell: { kind: 'rectangle', length: 40, width: 2, cornerRadius: 0, rotation: 90 },
      lattice: 'square',
      alternate: 'none',
      invert: false,
      through: false,
      gap: 1.5,
      angle: 0,
      depth: 10,
      cells: 11,
      area: { min: [1.5, 0], max: [38.5, 40] },
      margin: [1.5, 0],
      thickness: 14,
    }
    expect(straightFinsReadout(fields)).toEqual({
      slots: 11,
      fins: 12,
      fin: 1.5,
      height: 10,
      ratio: 6.7,
      base: 4,
    })
    expect(straightFinsReadout({ ...fields, lattice: 'hex' })).toBeUndefined()
    expect(straightFinsReadout({ ...fields, invert: true })).toBeUndefined()
    expect(
      straightFinsReadout({ ...fields, cell: { ...fields.cell, length: 8 } as FinsFields['cell'] }),
    ).toBeUndefined()
  })

  it('says how a tool cuts the slot (Q206)', () => {
    expect(slotCut(2, 2, 0.2)).toBe('onePass')
    expect(slotCut(2.02, 2, 0.2)).toBe('onePass')
    expect(slotCut(2.4, 2, 0.2)).toBe('finishing')
    expect(slotCut(2.2, 2, 0.2)).toBe('thinFinish')
    expect(slotCut(2, 3, 0.2)).toBe('tooWide')
  })
})

/** A 40 × 40 × 20 aluminium block with the 2D port. */
const block = () =>
  designSetup({
    stock: {
      name: 'Block',
      shape: 'block',
      length: '40',
      width: '40',
      thickness: '20',
      material: { name: '6061-T6', class: 'aluminum' },
    },
    services: { region2d: port },
  })

describe('margin [u, v] through the commands', () => {
  it('sets, keeps, undoes and refuses a pair', async () => {
    const s = await block()
    await s.run('design.pattern.add', { partId: s.partId })
    await s.run('design.pattern.update', {
      partId: s.partId,
      featureId: 'pattern1',
      margin: ['1.5 mm', '0'],
    })
    const own = () => s.part().shapes?.find((x) => x.id === 'pattern1_cells')?.pattern
    expect(own()?.margin).toEqual([1.5, 0])
    // another field keeps the pair
    await s.run('design.pattern.update', { partId: s.partId, featureId: 'pattern1', depth: '2' })
    expect(own()?.margin).toEqual([1.5, 0])
    await s.undo()
    await s.undo()
    expect(own()?.margin).toBe(5)
    await s.fail(
      'design.pattern.update',
      { partId: s.partId, featureId: 'pattern1', margin: ['1 mm', '-1 mm'] },
      'model.invariant',
    )
  })
})

describe('dfm.patternTallWeb', () => {
  /** Fins 1.5 mm at `depth` on a 40 × 40 × 20 block. */
  async function fins(depth: string) {
    const s = await block()
    const step = { fin: 1.5, slot: 2, height: 10, wall: 1.5, across: 40, along: 40 }
    await s.run('design.pattern.add', { partId: s.partId })
    const out = (await s.run('design.pattern.update', {
      partId: s.partId,
      featureId: 'pattern1',
      ...straightFinsArgs(step, straightFins(step)!),
      depth,
    })) as { warnings: { code: string; parameter?: string; params?: object }[] }
    return out.warnings.find((w) => w.code === 'dfm.patternTallWeb')
  }

  it('warns above 1:8 at Depth, not at 1:8', async () => {
    expect(await fins('12')).toBeUndefined()
    const w = await fins('12.1')
    expect(w?.parameter).toBe('depth')
    expect(w?.params).toMatchObject({ web: 1.5, depth: 12.1, ratio: 8.1, suggestedDepth: 12 })
  })
})
