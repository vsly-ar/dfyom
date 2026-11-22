// resolveShape: items to exact loops, booleans through the real 2D port, invariants, cache,
// summary. Doc: docs/architecture/shapes.md#resolving-a-shape, docs/modes/design-v0.3.md#shape-definition
import { describe, expect, it } from 'vitest'
import type { AppResult } from '../../shared/result'
import { closedChainCrossing } from '../geometry/2d/crossings'
import { chainBounds, line, regionLoops, type Element } from '../geometry/2d/model'
import { nodeRegion2d } from '../geometry/2d/testing/node-wasm'
import {
  resolveDefinition,
  resolveShape,
  shapeSummary,
  smallestInsideRadius,
  type ResolvedShape,
  type ShapeDefinition,
} from './shape'
import type { ShapeItem } from './shape.dto'

const port = nodeRegion2d()
type Item = ShapeItem<number>

const rect = (l: number, w: number, r = 0, extra: Partial<Item> = {}): Item =>
  ({
    kind: 'rectangle',
    op: 'add',
    center: [0, 0],
    length: l,
    width: w,
    cornerRadius: r,
    ...extra,
  }) as Item
const circle = (d: number, center: [number, number] = [0, 0], op: Item['op'] = 'add'): Item => ({
  kind: 'circle',
  op,
  center,
  diameter: d,
})
const path = (
  start: [number, number],
  segments: Extract<Item, { kind: 'path' }>['segments'],
  extra: Partial<Extract<Item, { kind: 'path' }>> = {},
): Item => ({ kind: 'path', op: 'add', start, segments, closed: true, ...extra })
const L = (x: number, y: number) => ({ kind: 'line' as const, to: [x, y] as [number, number] })

function region(def: ShapeDefinition) {
  const r = resolveDefinition(port, def)
  expect(r.isOk(), r.isErr() ? JSON.stringify(r.unwrapErr().issues) : '').toBe(true)
  const v = r.unwrap()
  if (v.kind !== 'region') throw new Error('expected a region')
  return v.region
}

function rules(r: AppResult<ResolvedShape>): { path: string; rule: string }[] {
  expect(r.isErr()).toBe(true)
  const e = r.unwrapErr()
  expect(e.code).toBe('model.invariant')
  return e.issues.map((i) => ({ path: i.path.join('.'), rule: i.rule }))
}

const area = (def: ShapeDefinition) => shapeSummary({ kind: 'region', region: region(def) }).area

describe('primitives', () => {
  it('rectangle with corner radius, rotated', () => {
    expect(area([rect(40, 20, 4)])).toBeCloseTo(800 - (4 - Math.PI) * 16, 9)
    const b = shapeSummary({ kind: 'region', region: region([rect(40, 20, 0, { rotation: 90 })]) })
    expect(b.bounds.min[0]).toBeCloseTo(-10, 9)
    expect(b.bounds.max[1]).toBeCloseTo(20, 9)
    expect(b.smallestInsideRadius).toBe(0)
    expect(
      shapeSummary({ kind: 'region', region: region([rect(40, 20, 4)]) }).smallestInsideRadius,
    ).toBeCloseTo(4, 9)
  })

  it('circle, obround, polygon', () => {
    expect(area([circle(10)])).toBeCloseTo(25 * Math.PI, 9)
    expect(
      area([{ kind: 'obround', op: 'add', center: [5, 5], length: 30, width: 10 }]),
    ).toBeCloseTo(200 + 25 * Math.PI, 9)
    // a hexagon 20 across flats: flats at the bottom and top
    const hex = region([
      { kind: 'polygon', op: 'add', center: [0, 0], sides: 6, diameter: 20, across: 'flats' },
    ])
    const s = shapeSummary({ kind: 'region', region: hex })
    expect(s.bounds.min[1]).toBeCloseTo(-10, 9)
    expect(s.area).toBeCloseTo(2 * Math.sqrt(3) * 100, 6)
    // a square with rounded corners equals the rounded rectangle
    const sq = area([
      {
        kind: 'polygon',
        op: 'add',
        center: [0, 0],
        sides: 4,
        diameter: 20,
        across: 'flats',
        cornerRadius: 3,
      },
    ])
    expect(sq).toBeCloseTo(area([rect(20, 20, 3)]), 9)
  })

  it('refuses invalid sizes with item paths', () => {
    expect(rules(resolveDefinition(port, [rect(0, 20)]))).toEqual([
      { path: 'items.0.length', rule: 'positive' },
    ])
    expect(rules(resolveDefinition(port, [rect(10, 20), rect(10, 20, 6)]))).toEqual([
      { path: 'items.1.cornerRadius', rule: 'cornerRadiusRange' },
    ])
    expect(
      rules(
        resolveDefinition(port, [
          { kind: 'obround', op: 'add', center: [0, 0], length: 5, width: 10 },
        ]),
      ),
    ).toEqual([{ path: 'items.0.length', rule: 'obroundLength' }])
    expect(
      rules(
        resolveDefinition(port, [
          { kind: 'polygon', op: 'add', center: [0, 0], sides: 2.5, diameter: 10 },
        ]),
      ),
    ).toEqual([{ path: 'items.0.sides', rule: 'range' }])
    expect(
      rules(
        resolveDefinition(port, [
          { kind: 'polygon', op: 'add', center: [0, 0], sides: 3, diameter: 10, cornerRadius: 9 },
        ]),
      ),
    ).toEqual([{ path: 'items.0.cornerRadius', rule: 'filletTooLarge' }])
  })
})

describe('paths', () => {
  it('a clockwise closed path adds its area; the closing line is implied', () => {
    expect(area([path([0, 0], [L(0, 10), L(10, 10), L(10, 0)])])).toBeCloseTo(100, 9)
    // closed by the last segment: no extra line
    const r = region([path([0, 0], [L(10, 0), L(10, 10), L(0, 10), L(0, 0)])])
    expect(r.pieces[0]!.outer.elements).toHaveLength(4)
  })

  it('arcs: radius, cw, large; tangent arcs', () => {
    // a D: line up, then a half circle back down (radius = half the chord)
    const d = area([path([0, 0], [L(0, 10), { kind: 'arc', to: [0, 0], radius: 5, cw: true }])])
    expect(d).toBeCloseTo((25 * Math.PI) / 2, 9)
    // the large arc of the same chord and radius 10 adds the major segment
    const big = area([
      path([0, 0], [L(0, 10), { kind: 'arc', to: [0, 0], radius: 10, cw: true, large: true }]),
    ])
    const minor = 50 * (Math.PI / 3 - Math.sin(Math.PI / 3))
    expect(big).toBeCloseTo(100 * Math.PI - minor, 6)
    // a slot by tangent arcs: line, half circle tangent, line back, half circle
    const slot = area([
      path(
        [0, 0],
        [
          L(20, 0),
          { kind: 'tangentArc', to: [20, 10] },
          L(0, 10),
          { kind: 'tangentArc', to: [0, 0] },
        ],
      ),
    ])
    expect(slot).toBeCloseTo(200 + 25 * Math.PI, 9)
  })

  it('fillets round vertices with tangent arcs', () => {
    const sq = [L(10, 0), L(10, 10), L(0, 10)]
    expect(area([path([0, 0], sq, { fillets: [{ vertex: 2, radius: 2 }] })])).toBeCloseTo(
      100 - (4 - Math.PI),
      9,
    )
    // vertex 0 of a closed path is its start; vertex 3 the start of the closing line
    expect(
      area([path([0, 0], sq, { fillets: [0, 1, 2, 3].map((vertex) => ({ vertex, radius: 5 })) })]),
    ).toBeCloseTo(25 * Math.PI, 6)
    // a fillet between a line and an arc
    const r = region([
      path([0, 0], [L(20, 0), { kind: 'arc', to: [0, 0], radius: 10, cw: false }], {
        fillets: [{ vertex: 1, radius: 1 }],
      }),
    ])
    expect(
      r.pieces[0]!.outer.elements.some(
        (e) =>
          e.kind === 'arc' &&
          Math.abs(Math.hypot(e.a[0] - e.centre[0], e.a[1] - e.centre[1]) - 1) < 1e-9,
      ),
    ).toBe(true)
  })

  it('refuses invalid paths', () => {
    const bowtie = path([0, 0], [L(10, 10), L(10, 0), L(0, 10)])
    expect(rules(resolveDefinition(port, [bowtie]))).toEqual([
      { path: 'items.0', rule: 'shapeSelfIntersects' },
    ])
    expect(
      rules(
        resolveDefinition(port, [
          path([0, 0], [L(10, 0), { kind: 'arc', to: [0, 0], radius: 4, cw: false }]),
        ]),
      ),
    ).toEqual([{ path: 'items.0.segments.1.radius', rule: 'arcRadius' }])
    expect(
      rules(resolveDefinition(port, [path([0, 0], [L(10, 0), L(10, 0.00001), L(0, 10)])])),
    ).toEqual([{ path: 'items.0.segments.1.to', rule: 'segmentTooShort' }])
    expect(
      rules(
        resolveDefinition(port, [path([0, 0], [{ kind: 'tangentArc', to: [10, 0] }, L(0, 10)])]),
      ),
    ).toEqual([{ path: 'items.0.segments.0', rule: 'tangentArcStart' }])
    expect(
      rules(
        resolveDefinition(port, [
          path([0, 0], [L(10, 0), L(10, 10), L(0, 10)], { fillets: [{ vertex: 1, radius: 11 }] }),
        ]),
      ),
    ).toEqual([{ path: 'items.0.fillets.0.radius', rule: 'filletTooLarge' }])
    expect(
      rules(
        resolveDefinition(port, [
          path([0, 0], [L(10, 0), L(0, 10)], {
            closed: false,
            fillets: [{ vertex: 0, radius: 1 }],
          }),
        ]),
      ),
    ).toEqual([{ path: 'items.0.fillets.0.vertex', rule: 'filletVertex' }])
    expect(rules(resolveDefinition(port, [path([0, 0], [L(10, 0), L(20, 0)])]))).toEqual([
      { path: 'items.0', rule: 'shapeSelfIntersects' },
    ])
  })

  it('an open path resolves to a path and must be alone', () => {
    const open = path([0, 0], [L(10, 0), { kind: 'tangentArc', to: [10, 10] }], { closed: false })
    const r = resolveDefinition(port, [open]).unwrap()
    expect(r.kind).toBe('path')
    expect(shapeSummary(r).length).toBeCloseTo(10 + 5 * Math.PI, 9)
    expect(rules(resolveDefinition(port, [rect(10, 10), open]))).toEqual([
      { path: 'items.1.closed', rule: 'openPathAlone' },
    ])
  })
})

describe('booleans', () => {
  it('subtract makes islands, intersect clips, nothing left is shapeEmpty', () => {
    const r = region([rect(40, 20), circle(6, [0, 0], 'subtract')])
    expect(r.pieces).toHaveLength(1)
    expect(r.pieces[0]!.holes).toHaveLength(1)
    expect(area([rect(40, 20), circle(6, [0, 0], 'subtract')])).toBeCloseTo(800 - 9 * Math.PI, 9)
    expect(area([rect(40, 20), circle(20, [20, 0], 'intersect')])).toBeCloseTo(50 * Math.PI, 6)
    // two separate outer loops are one region of two pieces
    expect(region([circle(10, [0, 0]), circle(10, [30, 0])]).pieces).toHaveLength(2)
    expect(
      rules(resolveDefinition(port, [rect(10, 10), rect(20, 20, 0, { op: 'subtract' })])),
    ).toEqual([{ path: 'items', rule: 'shapeEmpty' }])
    expect(rules(resolveDefinition(port, [circle(10, [0, 0], 'subtract')]))).toEqual([
      { path: 'items.0.op', rule: 'firstItemAdd' },
    ])
  })

  it('smallest inside radius of a region with an island', () => {
    const r = region([rect(40, 20, 3), circle(6, [0, 0], 'subtract')])
    expect(smallestInsideRadius(r)).toBeCloseTo(3, 9)
    expect(regionLoops(r)).toHaveLength(2)
  })
})

describe('cache', () => {
  it('returns the cached result for equal numbers', () => {
    const a = resolveShape(port, [rect(40, 20, 4)])
    const b = resolveShape(port, [rect(40, 20, 4)])
    expect(b === a).toBe(true)
    expect(resolveShape(port, [rect(40, 20, 5)]) === a).toBe(false)
  })
})

describe('closedChainCrossing', () => {
  const poly = (pts: [number, number][]): Element[] =>
    pts.map((p, i) => line(p, pts[(i + 1) % pts.length]!))
  it('finds transversal and vertex crossings, ignores touching', () => {
    expect(
      closedChainCrossing(
        poly([
          [0, 0],
          [10, 10],
          [10, 0],
          [0, 10],
        ]),
      ),
    ).toBeDefined()
    // a vertex on another edge, passing through it
    expect(
      closedChainCrossing(
        poly([
          [0, 0],
          [10, 0],
          [10, 10],
          [5, 0],
          [5, -5],
          [0, -5],
        ]),
      ),
    ).toBeDefined()
    // two squares touching at a vertex (a self-touching loop): not a crossing
    expect(
      closedChainCrossing(
        poly([
          [0, 0],
          [10, 0],
          [10, 10],
          [20, 10],
          [20, 20],
          [10, 20],
          [10, 10],
          [0, 10],
        ]),
      ),
    ).toBeUndefined()
    expect(
      closedChainCrossing(
        poly([
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ]),
      ),
    ).toBeUndefined()
    expect(
      chainBounds(
        poly([
          [0, 0],
          [1, 1],
          [0, 1],
        ]),
      ),
    ).toBeDefined()
  })
})
