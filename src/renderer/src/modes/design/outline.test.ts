// The live outline of named and rotated shapes (task U1): placed through the renderer's 2D port
// (`placeShape`), all loops of a region at the top face and the floor, an open path marked open;
// without the port these shapes draw no outline. Patterns P5: a selected pattern's guide is its
// area, the cells left out at the border (ghosts) and a ring at the thinnest web. Engraved
// patterns: a ring at each place `dfm.lineMerge` names.
// Doc: docs/conventions/ui.md#evaluation-status-pending-outdated-failed,
// docs/modes/design-v0.3.md#placing-a-shape-on-a-face
import { describe, expect, it } from 'vitest'
import { designSetup } from '../../../../core/design/design.fixture'
import { nodeRegion2d } from '../../../../core/geometry/2d/testing/node-wasm'
import { designPart } from './model'
import { patternFacts } from '../../../../core/design/pattern/pattern'
import {
  LINE_MERGE_MARKER,
  lineMergeLoops,
  operationOutline,
  PATTERN_WEB_MARKER,
  patternGuideLoops,
  facingRegionGuide,
} from './outline'

const region2d = nodeRegion2d()

const span = (loop: readonly (readonly number[])[], axis: number): number =>
  Math.max(...loop.map((p) => p[axis]!)) - Math.min(...loop.map((p) => p[axis]!))

describe('outline of named and rotated shapes', () => {
  it('places a named shape through the 2D port; without it there is no outline', async () => {
    const s = await designSetup({ services: { region2d } })
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        { kind: 'rectangle', center: ['0', '0'], length: '20', width: '10' },
        { kind: 'circle', op: 'subtract', center: ['0', '0'], diameter: '4' },
      ],
    })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] },
      depth: '2',
    })
    const part = designPart(s.d.doc)!
    const op = part.loaded!.part.operations[0]!
    expect(operationOutline(op, part.loaded!.stock, part.table!)).toEqual([])
    const loops = operationOutline(op, part.loaded!.stock, part.table!, {
      port: region2d,
      shapes: part.loaded!.part.shapes,
    })
    // outer loop and island, at the top face and at the floor
    expect(loops).toHaveLength(4)
    const top = loops[0]!
    expect(top.every((p) => p[2] === 0)).toBe(true)
    expect(Math.min(...top.map((p) => p[0]))).toBeCloseTo(40)
    expect(span(top, 0)).toBeCloseTo(20)
    expect(span(top, 1)).toBeCloseTo(10)
    expect(loops[2]!.every((p) => p[2] === -2)).toBe(true)
    for (const p of loops[1]!) expect(Math.hypot(p[0] - 50, p[1] - 30)).toBeCloseTo(2)
  })

  it('places a rotated rectangle and marks an open path open', async () => {
    const s = await designSetup({ services: { region2d } })
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: {
        kind: 'rectangle',
        center: ['50', '30'],
        length: '20',
        width: '10',
        cornerRadius: '0',
        rotation: '90',
      },
      depth: '2',
    })
    await s.run('design.shape.add', {
      partId: s.partId,
      items: [
        {
          kind: 'path',
          start: ['0', '0'],
          closed: false,
          segments: [{ kind: 'line', to: ['30', '0'] }],
        },
      ],
    })
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { kind: 'named', shapeId: 'shape1', center: ['50', '30'] },
      side: 'on',
    })
    const part = designPart(s.d.doc)!
    const [pocket, profile] = part.loaded!.part.operations
    const ctx = { port: region2d, shapes: part.loaded!.part.shapes }
    const [top] = operationOutline(pocket!, part.loaded!.stock, part.table!, ctx)
    // turned a quarter: 10 along X, 20 along Y
    expect(span(top!, 0)).toBeCloseTo(10)
    expect(span(top!, 1)).toBeCloseTo(20)
    const [open] = operationOutline(profile!, part.loaded!.stock, part.table!, ctx)
    expect(open!.open).toBe(true)
    expect(open!.map((p) => [p[0], p[1]])).toEqual([
      [35, 30],
      [65, 30],
    ])
  })
})

describe("a pattern's guide (patterns P5)", () => {
  it('the area, a ghost per cell left out at the border and a ring at the thinnest web', async () => {
    const s = await designSetup({ services: { region2d } })
    await s.run('design.pattern.add', {
      partId: s.partId,
      lattice: 'hex',
      cell: { kind: 'circle', diameter: '6' },
      spacing: { gap: '0.6' },
      margin: '3',
    })
    const part = designPart(s.d.doc)!
    const op = part.loaded!.part.operations[0]!
    const facts = patternFacts('pattern1', part.dto.shapes ?? [], region2d)!
    expect(facts.ghosts?.pieces.length).toBeGreaterThan(0)
    expect(facts.web).toBeDefined()
    const loops = patternGuideLoops(op, part.loaded!.stock, part.table!, facts)
    expect(loops).toHaveLength(1 + facts.ghosts!.pieces.length + 1)
    // on the top face; the last loop rings the web marker
    expect(loops.every((l) => l.every((p) => Math.abs(p[2]!) < 1e-9))).toBe(true)
    const [u, v] = facts.web!.at
    for (const p of loops.at(-1)!)
      expect(Math.hypot(p[0]! - u, p[1]! - v)).toBeCloseTo(PATTERN_WEB_MARKER, 6)
  })
})

describe('thin walls between grooves (engraved patterns, dfm.lineMerge)', () => {
  it("a ring on the face at each of the finding's places", async () => {
    const s = await designSetup({
      stock: {
        name: 'Lid',
        shape: 'block',
        length: '60',
        width: '40',
        thickness: '6',
        material: { name: 'Birch plywood', class: 'sheetGood' },
      },
      services: { region2d },
    })
    const out = (await s.run('design.engraving.add', {
      partId: s.partId,
      depth: '1',
      layout: { lattice: 'square', spacing: { pitch: ['20', '1.2'] } },
    })) as { warnings: { code: string; params: Record<string, unknown> }[] }
    const merge = out.warnings.find((w) => w.code === 'dfm.lineMerge')!
    const points = merge.params['points'] as number[]
    expect(points.length).toBeGreaterThanOrEqual(2)
    const part = designPart(s.d.doc)!
    const op = part.loaded!.part.operations.find((o) => o.id === 'engraving1_line')!
    const loops = lineMergeLoops(op, part.loaded!.stock, part.table!, points)
    expect(loops).toHaveLength(points.length / 2)
    loops.forEach((l, k) => {
      for (const p of l) {
        expect(Math.hypot(p[0]! - points[2 * k]!, p[1]! - points[2 * k + 1]!)).toBeCloseTo(
          LINE_MERGE_MARKER,
          6,
        )
        expect(Math.abs(p[2]!)).toBeLessThan(1e-9)
      }
    })
  })
})

describe('facing region (DF145)', () => {
  it('a front band: its inner side solid at face and floor, the stock edges dashed', async () => {
    const s = await designSetup()
    await s.run('design.facing.add', {
      partId: s.partId,
      depth: '1',
      region: { band: { edge: 'front', width: '22' } },
    })
    const part = designPart(s.d.doc)!
    const op = part.loaded!.part.operations[0]!
    const loops = operationOutline(op, part.loaded!.stock, part.table!)
    expect(loops).toHaveLength(2)
    for (const l of loops) {
      expect(l.open).toBe(true)
      expect(l.map((p) => p[1])).toEqual([22, 22])
      expect(span(l, 0)).toBe(100)
    }
    expect(loops.map((l) => l[0]![2])).toEqual([0, -1])
    // left, front and right edges: one dashed run round the band's open sides
    const guide = facingRegionGuide(op, part.loaded!.stock, part.table!)
    expect(guide).toHaveLength(1)
    expect(guide[0]!.open).toBe(true)
    expect(guide[0]!.map((p) => [p[0], p[1]])).toEqual([
      [0, 22],
      [0, 0],
      [100, 0],
      [100, 22],
    ])
  })

  it('a shape region: inside the face all inner; across an edge that part is open', async () => {
    const s = await designSetup()
    await s.run('design.facing.add', {
      partId: s.partId,
      region: { shape: { kind: 'circle', center: ['50', '30'], diameter: '20' } },
    })
    const part = designPart(s.d.doc)!
    const stock = part.loaded!.stock
    const op = part.loaded!.part.operations[0]!
    const loops = operationOutline(op, stock, part.table!)
    expect(loops).toHaveLength(2)
    expect(loops[0]!.open).toBeUndefined()
    expect(facingRegionGuide(op, stock, part.table!)).toEqual([])
    await s.run('design.facing.update', {
      partId: s.partId,
      operationId: op.id,
      region: { shape: { kind: 'rectangle', center: ['0', '30'], length: '40', width: '20' } },
    })
    const moved = designPart(s.d.doc)!
    const op2 = moved.loaded!.part.operations[0]!
    // the three sides inside the face: one run, at the face and the floor
    const inner = operationOutline(op2, stock, moved.table!)
    expect(inner).toHaveLength(2)
    expect(span(inner[0]!, 0)).toBe(20)
    expect(span(inner[0]!, 1)).toBe(20)
    const open = facingRegionGuide(op2, stock, moved.table!)
    expect(open).toHaveLength(1)
    expect(open[0]!.every((p) => p[0] === 0)).toBe(true)
    expect(span(open[0]!, 1)).toBe(20)
  })
})
