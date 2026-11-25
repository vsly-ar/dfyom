/**
 * A pattern's cells (patterns P1): the lattice laid over the boundary less the margin, the cell
 * placed at every node whose cell lies wholly inside (`whole` fit), emitted as region pieces with
 * no boolean (cells are disjoint: the overlap check below), so 2 000 cells resolve in
 * milliseconds (S8 finding 2).
 * Doc: docs/modes/patterns.md#owned-shape-and-operations, docs/modes/patterns.md#implementation-p1
 *
 * Pure numbers (mm, degrees) and the 2D port; the cell's own resolution is passed in (shape.ts
 * resolves named shapes and primitives), so this module has no shape-layer import.
 */
import type { Issue } from '../../../shared/errors/app-error'
import { Err, fail, Ok, type AppResult } from '../../../shared/result'
import type { Vec2 } from '../../geometry/model'
import {
  chainBounds,
  regionArea,
  type Bounds2,
  type Region,
  type RegionPiece,
} from '../../geometry/2d/model'
import { orientRegion, translateRegion } from '../../geometry/2d/place'
import type { Region2dPort } from '../../geometry/2d/port'
import type { PatternRecord, ShapeItem } from '../shape.dto'

/** Most cells of one pattern (`patternTooMany`; S8: 2 000 with the P1 changes). */
export const PATTERN_CELLS_MAX = 2000
/**
 * Region chords from which a pattern is heavy (`dfm.patternHeavy`; S8: ≈ 150 cells of a
 * rounded hexagon, ≈ 5 000 chords at the evaluation's chord tolerance).
 */
export const PATTERN_HEAVY_CHORDS = 5000
/** Cells closer than this (mm) count as touching, i.e. overlapping (`patternOverlap`). */
export const PATTERN_MIN_WEB = 0.001
/** Neighbour offsets the overlap check measures at most; more means the pitch is far too small. */
const OVERLAP_CHECKS_MAX = 64
const SLACK = 1e-9

/** A pattern as the resolver reads it: the record with the cell's definition resolved. */
export interface PatternDefinition extends Omit<PatternRecord, 'cell'> {
  readonly kind: 'pattern'
  readonly op: 'add'
  /** The cell's shape definition (a primitive item centred on the origin, or a named shape's). */
  readonly cell: readonly ShapeItem<number>[]
}

/** The resolved cells: one region of disjoint pieces, in face-frame coordinates. */
export interface PatternCells {
  readonly region: Region
  readonly cells: number
  /** The boundary rectangle: placement anchors by it, not by the cells (placement.ts). */
  readonly frame: Bounds2
  /** Pitch along the rows and between rows (mm). */
  readonly pitch: Vec2
}

type CellResult = AppResult<{ kind: 'region'; region: Region } | { kind: 'path' }>

const issue = (path: (string | number)[], rule: string, message: string, params?: object) =>
  ({
    path,
    rule,
    message,
    ...(params === undefined ? {} : { params: params as Record<string, unknown> }),
  }) satisfies Issue

function invalid(issues: Issue[]): AppResult<never> {
  return fail('model.invariant', issues.map((i) => i.message).join('; '), {
    issues,
    where: 'resolvePattern',
  })
}

const cosSin = (deg: number): Vec2 => {
  const r = (deg * Math.PI) / 180
  return [Math.cos(r), Math.sin(r)]
}
const rot = ([c, s]: Vec2, p: Vec2): Vec2 => [c * p[0] - s * p[1], s * p[0] + c * p[1]]

const boundsOf = (r: Region): Bounds2 | undefined =>
  chainBounds(r.pieces.flatMap((p) => [...p.outer.elements, ...p.holes.flatMap((h) => h.elements)]))

/**
 * The pattern's cells. Issues (`model.invariant`) at the feature's field names: `cell`
 * (`patternCellOpen`: an open path), `spacing` (`positive`, `patternOverlap`: neighbouring cells
 * overlap or touch), `spacing` (`patternTooMany`: more than `PATTERN_CELLS_MAX` cells). No cell
 * fitting is no error (`dfm.patternEmpty`).
 */
export function resolvePattern(
  port: Region2dPort,
  p: PatternDefinition,
  resolveCell: (def: readonly ShapeItem<number>[]) => CellResult,
): AppResult<PatternCells> {
  const resolved = resolveCell(p.cell)
  if (resolved.isErr()) return Err(resolved.unwrapErr().prefixIssues('cell'))
  const r = resolved.unwrap()
  if (r.kind !== 'region')
    return invalid([issue(['cell'], 'patternCellOpen', 'the cell must be a closed shape')])
  // the cell turned by its own rotation, its box centred on the origin (the node)
  const turned = orientRegion(r.region, { rotation: p.cellRotation, mirror: false })
  const tb = boundsOf(turned)!
  const centred = translateRegion(turned, [
    -(tb.min[0] + tb.max[0]) / 2,
    -(tb.min[1] + tb.max[1]) / 2,
  ])
  const ex = tb.max[0] - tb.min[0]
  const ey = tb.max[1] - tb.min[1]
  // pitch along the rows (a) and between rows (b); hex rows 60° apart
  let a: number
  let b: number
  if ('gap' in p.spacing) {
    const g = p.spacing.gap
    if (!(g > 0))
      return invalid([
        issue(['spacing', 'gap'], 'positive', 'must be greater than 0', { actual: g }),
      ])
    a = ex + g
    b = p.lattice === 'hex' ? (a * Math.sqrt(3)) / 2 : ey + g
  } else {
    ;[a, b] = p.spacing.pitch
    if (!(a > 0 && b > 0))
      return invalid([
        issue(['spacing', 'pitch'], 'positive', 'both pitches must be greater than 0', {
          actual: [a, b],
        }),
      ])
  }
  const shifted = p.lattice !== 'square'
  const overlap = cellsOverlap(port, centred, ex, ey, a, b, shifted)
  if (overlap.isErr()) return overlap
  if (overlap.unwrap())
    return invalid([
      issue(
        ['spacing'],
        'patternOverlap',
        `neighbouring cells overlap or touch (pitch ${round(a)} × ${round(b)} mm for a ${round(ex)} × ${round(ey)} mm cell): widen the spacing`,
        { pitch: [round(a), round(b)], extent: [round(ex), round(ey)] },
      ),
    ])

  // the boundary less the margin
  const lo: Vec2 = [p.boundary.min[0] + p.margin, p.boundary.min[1] + p.margin]
  const hi: Vec2 = [p.boundary.max[0] - p.margin, p.boundary.max[1] - p.margin]
  const frame: Bounds2 = { min: [...p.boundary.min], max: [...p.boundary.max] }
  const none: PatternCells = { region: { pieces: [] }, cells: 0, frame, pitch: [a, b] }
  if (!(hi[0] > lo[0] && hi[1] > lo[1])) return Ok(none)
  const origin: Vec2 = p.origin ?? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2]
  const cs = cosSin(p.angle)
  const cell = p.angle === 0 ? centred : orientRegion(centred, { rotation: p.angle, mirror: false })
  const cb = boundsOf(cell)!

  // nodes covering the boundary: its corners in the lattice frame, one pitch beyond
  const inv: Vec2 = [cs[0], -cs[1]]
  const corners = [lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]].map((c) =>
    rot(inv, [c[0] - origin[0], c[1] - origin[1]]),
  )
  const qx0 = Math.min(...corners.map((c) => c[0]))
  const qx1 = Math.max(...corners.map((c) => c[0]))
  const qy0 = Math.min(...corners.map((c) => c[1]))
  const qy1 = Math.max(...corners.map((c) => c[1]))
  const j0 = Math.floor(qy0 / b) - 1
  const j1 = Math.ceil(qy1 / b) + 1
  const nodes: Vec2[] = []
  for (let j = j0; j <= j1; j++) {
    const s = shifted && ((j % 2) + 2) % 2 === 1 ? a / 2 : 0
    const i0 = Math.floor((qx0 - s) / a) - 1
    const i1 = Math.ceil((qx1 - s) / a) + 1
    for (let i = i0; i <= i1; i++) {
      const q = rot(cs, [i * a + s, j * b])
      const n: Vec2 = [origin[0] + q[0], origin[1] + q[1]]
      const inside =
        n[0] + cb.min[0] >= lo[0] - SLACK &&
        n[0] + cb.max[0] <= hi[0] + SLACK &&
        n[1] + cb.min[1] >= lo[1] - SLACK &&
        n[1] + cb.max[1] <= hi[1] + SLACK
      if (!inside) continue
      nodes.push(n)
      if (nodes.length > PATTERN_CELLS_MAX)
        return invalid([
          issue(
            ['spacing'],
            'patternTooMany',
            `more than ${PATTERN_CELLS_MAX} cells: widen the spacing, enlarge the cell or the margin`,
            { max: PATTERN_CELLS_MAX },
          ),
        ])
    }
  }
  const pieces: RegionPiece[] = []
  for (const n of nodes) pieces.push(...translateRegion(cell, [n[0] + 0, n[1] + 0]).pieces)
  return Ok({ region: { pieces }, cells: nodes.length, frame, pitch: [a, b] })
}

const round = (x: number) => Math.round(x * 1000) / 1000

/**
 * Whether the cell overlaps (or comes within `PATTERN_MIN_WEB` of) a neighbour: every lattice
 * offset at which the cells' boxes overlap is measured with the port (the cell grown by the web
 * against the moved cell). Translation invariance makes one cell enough.
 */
function cellsOverlap(
  port: Region2dPort,
  cell: Region,
  ex: number,
  ey: number,
  a: number,
  b: number,
  shifted: boolean,
): AppResult<boolean> {
  const offsets: Vec2[] = []
  const nj = Math.ceil((ey + PATTERN_MIN_WEB) / b)
  for (let j = 0; j <= nj; j++) {
    const s = shifted && j % 2 === 1 ? a / 2 : 0
    const ni = Math.ceil((ex + PATTERN_MIN_WEB) / a) + 1
    for (let i = -ni; i <= ni; i++) {
      const dx = i * a + s
      const dy = j * b
      if (j === 0 && dx <= 0) continue
      if (Math.abs(dx) < ex + PATTERN_MIN_WEB && Math.abs(dy) < ey + PATTERN_MIN_WEB)
        offsets.push([dx, dy])
    }
  }
  if (offsets.length === 0) return Ok(false)
  if (offsets.length > OVERLAP_CHECKS_MAX) return Ok(true)
  const grown = port.offset(cell, -PATTERN_MIN_WEB)
  if (grown.isErr()) return Err(grown.unwrapErr())
  for (const d of offsets) {
    const both = port.intersect(grown.unwrap(), translateRegion(cell, d))
    if (both.isErr()) return Err(both.unwrapErr())
    if (both.unwrap().pieces.length > 0 && regionArea(both.unwrap()) > 1e-12) return Ok(true)
  }
  return Ok(false)
}
