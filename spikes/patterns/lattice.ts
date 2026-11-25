/**
 * Spike S8: lattices of cells filling a rectangle less a margin (`whole` fit), as the patterns
 * draft's `pattern` item would lay them out (docs/modes/patterns.md#model). Throwaway.
 */
import type { Element, Loop, Region } from '../../src/core/geometry/2d/model'
import type { Region2dPort } from '../../src/core/geometry/2d/port'
import type { Vec2 } from '../../src/core/geometry/model'
import { resolveDefinition, type ShapeDefinition } from '../../src/core/design/shape'

export type LatticeKind = 'hex' | 'square'

export interface Cell {
  readonly name: string
  /** Bounding box extent [x, y] (mm). */
  readonly extent: Vec2
  /** The `design.shape.add` item arg at `c` (string quantities). */
  item(c: Vec2): Record<string, unknown>
  /** The same item as a resolved definition item (numbers), for the direct resolution. */
  def(c: Vec2): ShapeDefinition[number]
}

const fmt = (v: number) => v.toFixed(6)

/** Ø 10 circle. */
export const circleCell: Cell = {
  name: 'circle Ø10',
  extent: [10, 10],
  item: (c) => ({ kind: 'circle', center: [fmt(c[0]), fmt(c[1])], diameter: '10' }),
  def: (c) => ({ kind: 'circle', op: 'add', center: [c[0], c[1]], diameter: 10 }),
}

/**
 * Hexagon 10 across the flats, R1 corners, turned 30° so its flats face ±x and ±60° (the hex
 * lattice's directions: the web is exactly the gap).
 */
const HEX_CORNERS = 10 / Math.cos(Math.PI / 6)
export const hexCell: Cell = {
  name: 'hexagon 10 AF R1',
  extent: [10, HEX_CORNERS],
  item: (c) => ({
    kind: 'polygon',
    center: [fmt(c[0]), fmt(c[1])],
    sides: '6',
    diameter: '10',
    across: 'flats',
    cornerRadius: '1',
    rotation: '30',
  }),
  def: (c) => ({
    kind: 'polygon',
    op: 'add',
    center: [c[0], c[1]],
    sides: 6,
    diameter: 10,
    across: 'flats',
    cornerRadius: 1,
    rotation: 30,
  }),
}

/**
 * Node centres of `kind` with the cell's gap, about the boundary centre (0, 0), kept where the
 * cell's box lies wholly inside the boundary `size` less `margin`.
 */
export function lattice(
  kind: LatticeKind,
  cell: Cell,
  gap: number,
  size: Vec2,
  margin: number,
): Vec2[] {
  const [w, h] = cell.extent
  // hex: rows 60° apart, pitch along x = width + gap, rows √3/2 pitch apart (shifted half a pitch)
  const px = w + gap
  const py = kind === 'hex' ? (px * Math.sqrt(3)) / 2 : h + gap
  const hx = size[0] / 2 - margin
  const hy = size[1] / 2 - margin
  const out: Vec2[] = []
  const rows = Math.ceil(hy / py) + 1
  const cols = Math.ceil(hx / px) + 1
  for (let j = -rows; j <= rows; j++) {
    const shift = kind === 'hex' && j % 2 !== 0 ? px / 2 : 0
    for (let i = -cols; i <= cols; i++) {
      const x = i * px + shift
      const y = j * py
      if (Math.abs(x) + w / 2 <= hx && Math.abs(y) + h / 2 <= hy) out.push([x, y])
    }
  }
  return out
}

/** The smallest boundary of aspect 3 : 2 whose lattice holds at least `n` cells. */
export function boundaryFor(
  kind: LatticeKind,
  cell: Cell,
  gap: number,
  margin: number,
  n: number,
): { size: Vec2; centres: Vec2[] } {
  let lo = 0
  let hi = 4000
  while (hi - lo > 0.5) {
    const m = (lo + hi) / 2
    if (lattice(kind, cell, gap, [1.5 * m, m], margin).length >= n) hi = m
    else lo = m
  }
  const size: Vec2 = [Math.ceil(1.5 * hi), Math.ceil(hi)]
  return { size, centres: lattice(kind, cell, gap, size, margin) }
}

const shift = (p: Vec2, d: Vec2): Vec2 => [p[0] + d[0], p[1] + d[1]]
const moved = (e: Element, d: Vec2): Element =>
  e.kind === 'line'
    ? { kind: 'line', a: shift(e.a, d), b: shift(e.b, d) }
    : { kind: 'arc', a: shift(e.a, d), b: shift(e.b, d), centre: shift(e.centre, d), ccw: e.ccw }

/**
 * The pattern item's resolution as P1 would do it: the cell resolved once, its loop moved to
 * every node, one `normalise` of all loops (no fold of N unions).
 */
export function patternRegion(port: Region2dPort, cell: Cell, centres: readonly Vec2[]): Region {
  const one = resolveDefinition(port, [cell.def([0, 0])]).unwrap()
  if (one.kind !== 'region') throw new Error('cell is not a region')
  const loop = one.region.pieces[0]!.outer
  const loops: Loop[] = centres.map((c) => ({ elements: loop.elements.map((e) => moved(e, c)) }))
  return port.normalise(loops).unwrap()
}

/**
 * The region built directly: cells are disjoint by construction (pitch ≥ extent, the
 * `patternOverlap` invariant), so each translated cell is a piece and no boolean is needed.
 */
export function directRegion(port: Region2dPort, cell: Cell, centres: readonly Vec2[]): Region {
  const one = resolveDefinition(port, [cell.def([0, 0])]).unwrap()
  if (one.kind !== 'region') throw new Error('cell is not a region')
  const piece = one.region.pieces[0]!
  const at = (l: Loop, c: Vec2): Loop => ({ elements: l.elements.map((e) => moved(e, c)) })
  return {
    pieces: centres.map((c) => ({
      outer: at(piece.outer, c),
      holes: piece.holes.map((h) => at(h, c)),
    })),
  }
}
