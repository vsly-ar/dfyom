/**
 * The pattern feature kind (patterns P1, P2): many copies of a cell laid on a lattice over a face
 * or a boundary shape, cut by one pocket (or, inverted, left standing as islands). The feature
 * owns a read-only shape `<id>_cells` (its geometry fields as numbers, resolved by the 2D layer
 * without booleans, layout.ts) and the pocket `<id>_pocket` that places it.
 * Doc: docs/modes/patterns.md#model, docs/modes/patterns.md#implementation-p1,
 * docs/modes/patterns.md#implementation-p2
 *
 * Only types come from feature.ts, which registers this kind as built in; the commands are in
 * pattern/commands.ts.
 */
import { z } from 'zod'
import type { Issue, IssuePath } from '../../../shared/errors/app-error'
import { parseWith } from '../../../shared/parse'
import { collect, fail, None, Ok, Some, type AppResult, type Option } from '../../../shared/result'
import type { Region2dPort } from '../../geometry/2d/port'
import {
  faceToFace,
  localStock,
  oppositeDirection,
  STOCK_FACE,
  stockFaceDirection,
  type Direction,
} from '../../geometry/face'
import type { DfmWarning, Vec2 } from '../../geometry/model'
import { flattenLoop } from '../../geometry/prism'
import { regionLoops } from '../../geometry/2d/model'
import { quantityDto, quantityFromDTO } from '../../library/item'
import type { QuantityDTO } from '../../quantity/quantity.dto'
import { derivedLength } from '../hole'
import { roundRadiusHolds } from '../round'
import type { Stock } from '../../library/stock'
import { Quantity } from '../../quantity/quantity'
import { Rational } from '../../quantity/rational'
import type {
  ExpandedOperation,
  ExpansionContext,
  FeatureBase,
  FeatureKindSpec,
  SpanGeometry,
} from '../feature'
import { FeatureDtoSchema, type FeatureDTO } from '../feature.dto'
import type { Anchor, Operation, Point, Shape } from '../operation'
import {
  POLYGON_ACROSS,
  PATTERN_LATTICES,
  type PatternLattice,
  type PatternRecord,
  type PolygonAcross,
  type ShapeDTO,
  type ShapeItem,
} from '../shape.dto'
import { SurfaceTable } from '../surfaces'
import { shapeDefinition } from '../placement'
import { resolveShape, shapeFromDTO, type NamedShape } from '../shape'
import { PATTERN_HEAVY_CHORDS, type PatternFacts } from './layout'
import { PATTERN_WEB_LIMIT, patternWeb, type PatternWeb, type WebInput } from './web'

/** The cell: a primitive centred on its node, or a named closed shape of the part (its box centre). */
export type PatternCell = { readonly rotation: Quantity } & (
  | { readonly kind: 'circle'; readonly diameter: Quantity }
  | {
      readonly kind: 'rectangle'
      readonly length: Quantity
      readonly width: Quantity
      readonly cornerRadius: Quantity
      /** DF120 Round: `cornerRadius` is half the narrowest side (absent = off). */
      readonly round?: true
    }
  | { readonly kind: 'obround'; readonly length: Quantity; readonly width: Quantity }
  | {
      readonly kind: 'polygon'
      readonly sides: Quantity
      readonly diameter: Quantity
      readonly across: PolygonAcross
      readonly cornerRadius: Quantity
    }
  | { readonly kind: 'shape'; readonly shapeId: string }
)

export type PatternSpacing =
  | { readonly kind: 'gap'; readonly gap: Quantity }
  | { readonly kind: 'pitch'; readonly pitch: Point }

/** A named shape as the boundary (P2): its box centre at `center` in the face frame. */
export interface PatternBoundary {
  readonly shapeId: string
  readonly center: Point
  readonly rotation: Quantity
}

export type PatternFit = 'whole' | 'clip'

export type PatternAlternate = 'none' | 'flip'

/** Which cell edges are chamfered (P5: bottom edges of through cells from a flipped setup). */
export type PatternChamferSide = 'top' | 'bottom' | 'both'

/** The optional chamfer (P3): the owned edge chamfer round every cell, one width for all. */
export interface PatternChamfer {
  readonly width: Quantity
  readonly angle: Quantity
  /** P5: `bottom` / `both` (through cells on a stock face only) add `<id>_bottomChamfer`. */
  readonly side: PatternChamferSide
}

export interface Pattern extends FeatureBase {
  readonly kind: 'pattern'
  readonly cell: PatternCell
  readonly lattice: PatternLattice
  /** The whole lattice (cells included) turns by it about `origin`. */
  readonly angle: Quantity
  /** `[u, v]` in the face frame; None = the centre of the face less the margin. */
  readonly origin: Option<Point>
  readonly spacing: PatternSpacing
  /** P5: `flip` turns every other cell 180° (triangles nest; the pitches are found for the gap). */
  readonly alternate: PatternAlternate
  /** None = the `on` face's rectangle (P2: a named closed shape, keep-outs its subtract items). */
  readonly boundary: Option<PatternBoundary>
  /** The uncut border inside the boundary (≥ 0). */
  readonly margin: Quantity
  /** Cells crossing the boundary less the margin: left out (`whole`) or cut (`clip`). */
  readonly fit: PatternFit
  /** The pocket clears the boundary less the margin minus the cells (islands). */
  readonly invert: boolean
  /** The pocket's depth below `on` (kept, unused, while `through`). */
  readonly depth: Quantity
  /**
   * P4 (Q126): every cell cut through the stock by a through pocket (each cell cleared wholly,
   * no slug); refused with `invert` (`patternThroughInvert`).
   */
  readonly through: boolean
  /** P3: Some = the owned chamfer `<id>_chamfer` on the pocket's edge (off by default). */
  readonly chamfer: Option<PatternChamfer>
  /**
   * DF108: the owned roughing pocket `<id>_roughing` before the pocket, with its own (bigger)
   * tool; the pocket then cuts only what it left (rest machining). Off by default.
   */
  readonly roughing: boolean
}

export const ownedShapeId = (featureId: string): string => `${featureId}_cells`

// ── record ─────────────────────────────────────────────────────────────────────────────────

const length = () => quantityDto('length')
const angle = () => quantityDto('angle')

const CellDtoSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('circle'), diameter: length(), rotation: angle().optional() }),
  z.object({
    kind: z.literal('rectangle'),
    length: length(),
    width: length(),
    cornerRadius: length(),
    round: z.literal(true).optional(),
    rotation: angle().optional(),
  }),
  z.object({
    kind: z.literal('obround'),
    length: length(),
    width: length(),
    rotation: angle().optional(),
  }),
  z.object({
    kind: z.literal('polygon'),
    sides: quantityDto('scalar'),
    diameter: length(),
    across: z.enum(POLYGON_ACROSS),
    cornerRadius: length(),
    rotation: angle().optional(),
  }),
  z.object({ kind: z.literal('shape'), shapeId: z.string(), rotation: angle().optional() }),
])

/** The stored pattern (`part.features[]`). */
const PatternDtoSchema = FeatureDtoSchema.extend({
  kind: z.literal('pattern'),
  cell: CellDtoSchema,
  lattice: z.enum(PATTERN_LATTICES),
  angle: angle(),
  origin: z.tuple([length(), length()]).optional(),
  spacing: z.union([
    z.object({ gap: length() }),
    z.object({ pitch: z.tuple([length(), length()]) }),
  ]),
  alternate: z.literal('flip').optional(),
  boundary: z
    .object({ shapeId: z.string(), center: z.tuple([length(), length()]), rotation: angle() })
    .optional(),
  margin: length(),
  fit: z.enum(['whole', 'clip']).optional(),
  invert: z.boolean().optional(),
  depth: length(),
  through: z.boolean().optional(),
  roughing: z.literal(true).optional(),
  chamfer: z
    .object({ width: length(), angle: angle(), side: z.enum(['bottom', 'both']).optional() })
    .optional(),
})

function patternFromDTO(raw: FeatureDTO): AppResult<Pattern> {
  const parsed = parseWith(PatternDtoSchema, raw, 'patternFromDTO')
  if (parsed.isErr()) return parsed
  const d = parsed.unwrap()
  const q = (dto: QuantityDTO, ...path: (string | number)[]) => quantityFromDTO(dto, ...path)
  const c = d.cell
  const rotation: AppResult<Quantity> =
    c.rotation === undefined
      ? Quantity.parse('0', { kind: 'angle', defaultUnit: 'deg' })
      : q(c.rotation, 'cell', 'rotation')
  const cellQs: AppResult<Quantity>[] = [rotation]
  if (c.kind === 'circle') cellQs.push(q(c.diameter, 'cell', 'diameter'))
  if (c.kind === 'rectangle' || c.kind === 'obround')
    cellQs.push(q(c.length, 'cell', 'length'), q(c.width, 'cell', 'width'))
  if (c.kind === 'rectangle') cellQs.push(q(c.cornerRadius, 'cell', 'cornerRadius'))
  if (c.kind === 'polygon')
    cellQs.push(
      q(c.sides, 'cell', 'sides'),
      q(c.diameter, 'cell', 'diameter'),
      q(c.cornerRadius, 'cell', 'cornerRadius'),
    )
  const spacingQs =
    'gap' in d.spacing
      ? [q(d.spacing.gap, 'spacing', 'gap')]
      : [q(d.spacing.pitch[0], 'spacing', 'pitch', 0), q(d.spacing.pitch[1], 'spacing', 'pitch', 1)]
  const originQs =
    d.origin === undefined ? [] : [q(d.origin[0], 'origin', 0), q(d.origin[1], 'origin', 1)]
  const rest = [q(d.angle, 'angle'), q(d.margin, 'margin'), q(d.depth, 'depth')]
  const ch = d.chamfer
  const chamferQs =
    ch === undefined ? [] : [q(ch.width, 'chamfer', 'width'), q(ch.angle, 'chamfer', 'angle')]
  const bd = d.boundary
  const boundaryQs =
    bd === undefined
      ? []
      : [
          q(bd.center[0], 'boundary', 'center', 0),
          q(bd.center[1], 'boundary', 'center', 1),
          q(bd.rotation, 'boundary', 'rotation'),
        ]
  return collect([
    collect(cellQs),
    collect(spacingQs),
    collect(originQs),
    collect(rest),
    collect(boundaryQs),
    collect(chamferQs),
  ]).map((all) => {
    const [cq, s, o, rest3, bq, chq] = all as [
      Quantity[],
      Quantity[],
      Quantity[],
      Quantity[],
      Quantity[],
      Quantity[],
    ]
    const [ang, margin, depth] = rest3
    const [rot, a, b, r] = cq
    const cell: PatternCell =
      c.kind === 'circle'
        ? { kind: 'circle', rotation: rot!, diameter: a! }
        : c.kind === 'rectangle'
          ? {
              kind: 'rectangle',
              rotation: rot!,
              length: a!,
              width: b!,
              cornerRadius: r!,
              ...(c.round === true ? { round: true as const } : {}),
            }
          : c.kind === 'obround'
            ? { kind: 'obround', rotation: rot!, length: a!, width: b! }
            : c.kind === 'polygon'
              ? {
                  kind: 'polygon',
                  rotation: rot!,
                  sides: a!,
                  diameter: b!,
                  across: c.across,
                  cornerRadius: r!,
                }
              : { kind: 'shape', rotation: rot!, shapeId: c.shapeId }
    return {
      kind: 'pattern' as const,
      id: d.id,
      name: d.name,
      on: d.on,
      cell,
      lattice: d.lattice,
      angle: ang!,
      origin: o.length === 0 ? None : Some([o[0]!, o[1]!] as const),
      spacing:
        s.length === 1
          ? { kind: 'gap' as const, gap: s[0]! }
          : { kind: 'pitch' as const, pitch: [s[0]!, s[1]!] as const },
      alternate: d.alternate ?? 'none',
      boundary:
        bd === undefined
          ? None
          : Some({ shapeId: bd.shapeId, center: [bq[0]!, bq[1]!] as const, rotation: bq[2]! }),
      margin: margin!,
      fit: d.fit ?? 'whole',
      invert: d.invert ?? false,
      depth: depth!,
      through: d.through ?? false,
      roughing: d.roughing ?? false,
      chamfer:
        chq.length === 0
          ? None
          : Some({ width: chq[0]!, angle: chq[1]!, side: d.chamfer?.side ?? 'top' }),
    }
  })
}

function cellToDTO(c: PatternCell): z.input<typeof CellDtoSchema> {
  const rotation = c.rotation.canonical === 0 ? {} : { rotation: c.rotation.toDTO() }
  switch (c.kind) {
    case 'circle':
      return { kind: 'circle', diameter: c.diameter.toDTO(), ...rotation } as never
    case 'rectangle':
      return {
        kind: 'rectangle',
        length: c.length.toDTO(),
        width: c.width.toDTO(),
        cornerRadius: c.cornerRadius.toDTO(),
        // DF120: left out when off (records without Round stay byte-identical)
        ...(c.round === true ? { round: true } : {}),
        ...rotation,
      } as never
    case 'obround':
      return {
        kind: 'obround',
        length: c.length.toDTO(),
        width: c.width.toDTO(),
        ...rotation,
      } as never
    case 'polygon':
      return {
        kind: 'polygon',
        sides: c.sides.toDTO(),
        diameter: c.diameter.toDTO(),
        across: c.across,
        cornerRadius: c.cornerRadius.toDTO(),
        ...rotation,
      } as never
    case 'shape':
      return { kind: 'shape', shapeId: c.shapeId, ...rotation } as never
  }
}

function patternToDTO(p: Pattern): FeatureDTO {
  return {
    id: p.id,
    kind: 'pattern',
    name: p.name,
    on: p.on,
    cell: cellToDTO(p.cell),
    lattice: p.lattice,
    angle: p.angle.toDTO(),
    ...(p.origin.isSome()
      ? { origin: [p.origin.unwrap()[0].toDTO(), p.origin.unwrap()[1].toDTO()] }
      : {}),
    spacing:
      p.spacing.kind === 'gap'
        ? { gap: p.spacing.gap.toDTO() }
        : { pitch: [p.spacing.pitch[0].toDTO(), p.spacing.pitch[1].toDTO()] },
    ...(p.alternate === 'flip' ? { alternate: 'flip' } : {}),
    ...(p.boundary.isSome()
      ? {
          boundary: {
            shapeId: p.boundary.unwrap().shapeId,
            center: [p.boundary.unwrap().center[0].toDTO(), p.boundary.unwrap().center[1].toDTO()],
            rotation: p.boundary.unwrap().rotation.toDTO(),
          },
        }
      : {}),
    margin: p.margin.toDTO(),
    ...(p.fit === 'clip' ? { fit: 'clip' } : {}),
    ...(p.invert ? { invert: true } : {}),
    depth: p.depth.toDTO(),
    ...(p.through ? { through: true } : {}),
    ...(p.roughing ? { roughing: true } : {}),
    ...(p.chamfer.isSome()
      ? {
          chamfer: {
            width: p.chamfer.unwrap().width.toDTO(),
            angle: p.chamfer.unwrap().angle.toDTO(),
            ...(p.chamfer.unwrap().side === 'top' ? {} : { side: p.chamfer.unwrap().side }),
          },
        }
      : {}),
  }
}

// ── invariants ─────────────────────────────────────────────────────────────────────────────

const ZERO = Rational.ZERO

/**
 * Field rules that need no geometry; the cell's closure, overlap and the cell limit are checked
 * when the cells resolve (layout.ts: `patternCellOpen`, `patternOverlap`, `patternTooMany`).
 */
function patternInvariants(p: Pattern): Issue[] {
  const issues: Issue[] = []
  const check = (ok: boolean, path: (string | number)[], rule: string, message: string) => {
    if (!ok) issues.push({ path, rule, message })
  }
  const positive = (q: Quantity, ...path: (string | number)[]) =>
    check(q.exact.compare(ZERO) > 0, path, 'positive', 'must be greater than 0')
  positive(p.depth, 'depth')
  check(
    !(p.through && p.invert),
    ['invert'],
    'patternThroughInvert',
    'an inverted pattern cut through would leave every island loose: turn off Through or Invert',
  )
  // the angle's range is the owned chamfer's rule (validate.ts), reported at chamfer.angle
  if (p.chamfer.isSome()) positive(p.chamfer.unwrap().width, 'chamfer', 'width')
  // P5: only a through cell has a bottom edge (from the opposite stock face, `expandPattern`)
  check(
    p.chamfer.mapOr(true, (c) => c.side === 'top') || patternBottomFace(p) !== undefined,
    ['chamfer', 'side'],
    'patternChamferBottom',
    p.through
      ? 'the bottom edges are chamfered from the opposite stock face: the pattern must be on a stock face'
      : 'only through cells have a bottom edge: turn on Through or chamfer the top edges',
  )
  check(p.margin.exact.compare(ZERO) >= 0, ['margin'], 'nonNegative', 'must be 0 or more')
  if (p.spacing.kind === 'gap') positive(p.spacing.gap, 'spacing', 'gap')
  else {
    positive(p.spacing.pitch[0], 'spacing', 'pitch', 0)
    positive(p.spacing.pitch[1], 'spacing', 'pitch', 1)
  }
  const c = p.cell
  if (c.kind === 'circle') positive(c.diameter, 'cell', 'diameter')
  if (c.kind === 'rectangle' || c.kind === 'obround') {
    positive(c.length, 'cell', 'length')
    positive(c.width, 'cell', 'width')
  }
  // DF120: the commands keep a Round radius derived; this guards hand-edited records
  if (c.kind === 'rectangle' && c.round === true)
    check(
      roundRadiusHolds(c.length, c.width, c.cornerRadius),
      ['cell', 'cornerRadius'],
      'roundRadius',
      'must be half the narrowest size (Round)',
    )
  if (c.kind === 'polygon') positive(c.diameter, 'cell', 'diameter')
  if (c.kind === 'shape')
    check(
      /^shape[1-9]\d*$/.test(c.shapeId),
      ['cell', 'shapeId'],
      'shapeCycle',
      "a pattern's cell is a named shape of the part, not an owned shape",
    )
  // stacking (P4, Q127) is by `on` (a pattern's floor), never an owned shape as the boundary
  if (p.boundary.isSome())
    check(
      /^shape[1-9]\d*$/.test(p.boundary.unwrap().shapeId),
      ['boundary', 'shapeId'],
      'shapeCycle',
      "a pattern's boundary is a named shape of the part, not an owned shape",
    )
  return issues
}

// ── expansion ──────────────────────────────────────────────────────────────────────────────

const MIN_ANCHOR: Anchor = Object.freeze({ u: 'min', v: 'min' })

/**
 * One owned pocket placing the owned shape: anchored at its frame's corner [0, 0] (the face
 * frame's origin), so the cells keep face-frame coordinates (placement.ts anchors a pattern by
 * its frame, the face rectangle). P3: with a chamfer, the owned edge chamfer on that pocket,
 * round every loop (EC-B).
 */
function expandPattern(p: Pattern, ctx: ExpansionContext): AppResult<readonly ExpandedOperation[]> {
  // P4: a through pocket's depth is the material below `on` (readers that matter re-read it)
  const depth = p.through ? derivedLength(materialBelow(p.on, ctx), ctx.units) : Ok(p.depth)
  if (depth.isErr()) return depth
  return derivedLength(ZERO, ctx.units).map((zero): ExpandedOperation[] => {
    const pocket = (roughing: boolean): ExpandedOperation['operation'] => ({
      kind: 'pocket' as const,
      on: p.on,
      shape: {
        kind: 'named' as const,
        center: [zero, zero] as const,
        anchor: MIN_ANCHOR,
        shapeId: ownedShapeId(p.id),
        rotation: None,
        mirror: false,
      },
      depth: depth.unwrap(),
      floorRadius: zero,
      ...(p.through ? { through: true } : {}),
      ...(roughing ? { roughing: true } : {}),
    })
    return [
      // DF108: the roughing pocket first, so the pocket's tool cuts only the rest
      ...(p.roughing ? [{ role: 'roughing', operation: pocket(true) }] : []),
      { role: 'pocket', operation: pocket(false) },
      ...chamfers(p, ctx),
    ]
  })
}

/**
 * P3: the owned edge chamfer round every cell on the top face (`<id>_chamfer`); P5: with `side`
 * `bottom` or `both`, `<id>_bottomChamfer` round the cells' bottom edges from the opposite stock
 * face (edge-chamfers.md E4b: a flipped setup). The invariants keep a bottom side to through
 * cells on a stock face (`patternChamferBottom`).
 */
function chamfers(p: Pattern, ctx: ExpansionContext): ExpandedOperation[] {
  if (p.chamfer.isNone()) return []
  const c = p.chamfer.unwrap()
  const op = (role: string, on: string): ExpandedOperation => ({
    role,
    operation: {
      kind: 'chamfer' as const,
      on,
      edgeOf: ctx.ownedId('pocket'),
      width: c.width,
      angle: c.angle,
      stepdown: None,
      sourceEdge: None,
      loops: None,
      cornerLift: false,
    },
  })
  const out: ExpandedOperation[] = []
  if (c.side !== 'bottom') out.push(op('chamfer', p.on))
  const bottom = patternBottomFace(p)
  if (c.side !== 'top' && bottom !== undefined) out.push(op('bottomChamfer', bottom))
  return out
}

/** The stock face opposite a through pattern's `on` (P5); undefined off a stock face. */
export function patternBottomFace(p: Pick<Pattern, 'on' | 'through'>): string | undefined {
  const d = stockFaceDirection(p.on)
  return p.through && d !== undefined ? STOCK_FACE[oppositeDirection(d)] : undefined
}

/** The material below the surface `on` along its normal (mm exact; the stock thickness on top). */
function materialBelow(on: string, ctx: ExpansionContext): Rational {
  const table = SurfaceTable.of(ctx.before, ctx.stock)
  return table
    .get(on)
    .mapOr(ctx.stock.thickness.exact, (e) => e.faceZ.add(table.extent(e.direction)))
}

/**
 * P4 (Q127): the owned shape of the pattern whose pocket floor `on` is (`pattern1_pocket.floor`
 * → `pattern1_cells`), so the pattern is stacked on it; undefined for any other face.
 */
export function stackedOn(on: string, before: readonly Operation[]): string | undefined {
  const m = /^(.+)\.floor$/.exec(on)
  if (m === null) return undefined
  const op = before.find((o) => o.id === m[1])
  if (op?.kind !== 'pocket' || op.through === true || op.roughing === true) return undefined
  if (op.shape.kind !== 'named') return undefined
  const owner = op.owner.isSome() ? op.owner.unwrap().featureId : undefined
  return owner !== undefined && op.shape.shapeId === ownedShapeId(owner)
    ? op.shape.shapeId
    : undefined
}

/** The face rectangle of `on` in its face frame: `[0, 0]`–`[length, width]` of its direction. */
export function faceRect(
  on: string,
  before: readonly Operation[],
  stock: Stock,
): { min: [number, number]; max: [number, number] } {
  const entry = SurfaceTable.of(before, stock).get(on)
  const direction: Direction = entry.isSome() ? entry.unwrap().direction : '+z'
  const s = localStock(direction, {
    length: stock.length.canonical,
    width: stock.width.canonical,
    thickness: stock.thickness.canonical,
  })
  return { min: [0, 0], max: [s.length, s.width] }
}

/** The cell as a shape item centred on the origin (mm, degrees), or the named shape's id. */
function cellRecord(c: PatternCell): PatternRecord['cell'] {
  const centre: [number, number] = [0, 0]
  const item = (i: ShapeItem<number>) => ({ item: i })
  switch (c.kind) {
    case 'circle':
      return item({ kind: 'circle', op: 'add', center: centre, diameter: c.diameter.canonical })
    case 'rectangle':
      return item({
        kind: 'rectangle',
        op: 'add',
        center: centre,
        length: c.length.canonical,
        width: c.width.canonical,
        cornerRadius: c.cornerRadius.canonical,
      })
    case 'obround':
      return item({
        kind: 'obround',
        op: 'add',
        center: centre,
        length: c.length.canonical,
        width: c.width.canonical,
      })
    case 'polygon':
      return item({
        kind: 'polygon',
        op: 'add',
        center: centre,
        sides: c.sides.canonical,
        diameter: c.diameter.canonical,
        across: c.across,
        cornerRadius: c.cornerRadius.canonical,
      })
    case 'shape':
      return { shapeId: c.shapeId }
  }
}

/** The pattern's owned shape record: its geometry fields as numbers (shape.dto.ts `PatternRecord`). */
export function patternRecord(
  p: Pattern,
  before: readonly Operation[],
  stock: Stock,
): PatternRecord {
  const floor = stackedOn(p.on, before)
  return {
    cell: cellRecord(p.cell),
    cellRotation: p.cell.rotation.canonical,
    lattice: p.lattice,
    angle: p.angle.canonical,
    ...(p.origin.isSome()
      ? { origin: [p.origin.unwrap()[0].canonical, p.origin.unwrap()[1].canonical] }
      : {}),
    spacing:
      p.spacing.kind === 'gap'
        ? { gap: p.spacing.gap.canonical }
        : { pitch: [p.spacing.pitch[0].canonical, p.spacing.pitch[1].canonical] },
    ...(p.alternate === 'flip' ? { alternate: 'flip' as const } : {}),
    boundary: faceRect(p.on, before, stock),
    ...(p.boundary.isSome()
      ? {
          area: {
            shapeId: p.boundary.unwrap().shapeId,
            center: [
              p.boundary.unwrap().center[0].canonical,
              p.boundary.unwrap().center[1].canonical,
            ],
            rotation: p.boundary.unwrap().rotation.canonical,
          },
        }
      : {}),
    margin: p.margin.canonical,
    ...(p.fit === 'clip' ? { fit: 'clip' as const } : {}),
    ...(p.invert ? { invert: true as const } : {}),
    ...(p.through ? { through: true as const } : {}),
    ...(floor === undefined ? {} : { floor }),
  }
}

function patternShapes(p: Pattern, ctx: ExpansionContext): AppResult<readonly ShapeDTO[]> {
  const unknown = (shapeId: string, field: 'cell' | 'boundary') =>
    fail('input.malformed', `shape ${shapeId} does not exist in the part`, {
      issues: [
        {
          path: [field, 'shapeId'],
          rule: 'unknownShape',
          message: "no such shape; design_shape_list lists the part's shapes",
        },
      ],
      data: { shapeId },
    })
  const exists = (id: string) => ctx.shapes.some((s) => s.id === id && s.owner === undefined)
  const c = p.cell
  if (c.kind === 'shape' && !exists(c.shapeId)) return unknown(c.shapeId, 'cell')
  if (p.boundary.isSome() && !exists(p.boundary.unwrap().shapeId))
    return unknown(p.boundary.unwrap().shapeId, 'boundary')
  return Ok([
    {
      id: ownedShapeId(p.id),
      name: `${p.name} · cells`,
      items: [],
      owner: p.id,
      pattern: patternRecord(p, ctx.before, ctx.stock),
    },
  ])
}

// ── checks ─────────────────────────────────────────────────────────────────────────────────

/** Owned pocket (and chamfer, P3) parameter → pattern field. */
function patternFieldOf(role: string, path: IssuePath): IssuePath | undefined {
  if (role === 'chamfer' || role === 'bottomChamfer') {
    const head = String(path[0])
    if (head === 'width' || head === 'angle') return ['chamfer', head]
    return head === 'edgeOf' || head === 'depth' ? ['chamfer', 'width'] : undefined
  }
  if (role !== 'pocket' && role !== 'roughing') return undefined
  const head = String(path[0])
  if (head === 'depth' || head === 'on') return [head, ...path.slice(1)]
  // the owned shape's resolution (layout.ts) names the pattern's own fields
  if (head === 'shapes') return path.slice(2)
  if (head === 'shape') return ['cell']
  return undefined
}
/**
 * `dfm.patternEmpty` (no cell fits the boundary less the margin), `dfm.patternHeavy` (info: the
 * cells' region passes `PATTERN_HEAVY_CHORDS`), from the owned pocket's placed region in the
 * part's geometry input, and `dfm.patternThinWeb` (P2: a web or, inverted, an island under
 * `PATTERN_WEB_LIMIT`, from the layout's facts); `operation` = the feature id. P3: the owned
 * chamfer's `dfm.chamferMeets` (`chamferMeetsOf`).
 */
function patternWarnings(
  p: Pattern,
  _ops: readonly Operation[],
  _stock: Stock,
  _units: unknown,
  shapes: readonly ShapeDTO[],
  geometry: SpanGeometry,
): DfmWarning[] {
  const g = geometry.operations.find((o) => o.id === `${p.id}_pocket`)
  if (g === undefined || g.kind !== 'pocket' || g.shape === undefined) return []
  const contour = g.shape.contour
  if (contour.kind !== 'region') return []
  const facts =
    geometry.region2d === undefined ? undefined : patternFacts(p.id, shapes, geometry.region2d)
  const pieces = contour.region.pieces.length
  if (pieces === 0 || facts?.cells === 0)
    return [
      {
        code: 'dfm.patternEmpty',
        severity: 'warning',
        message: `${p.name}: no cell fits the boundary less the margin; make the cell or the margin smaller`,
        operation: p.id,
        parameter: 'margin',
        params: { feature: p.id },
      },
    ]
  const out: DfmWarning[] = []
  const web = facts?.web
  if (web !== undefined) {
    const gap = p.spacing.kind === 'gap' ? p.spacing.gap.canonical : undefined
    const suggested =
      web.island || gap === undefined
        ? undefined
        : Math.ceil((gap + PATTERN_WEB_LIMIT - web.width) * 100) / 100
    out.push({
      code: 'dfm.patternThinWeb',
      severity: 'warning',
      message: web.island
        ? `${p.name}: an island is ${web.width} mm wide, under ${PATTERN_WEB_LIMIT} mm; make the cell larger`
        : `${p.name}: the web between cells is ${web.width} mm, under ${PATTERN_WEB_LIMIT} mm` +
          (suggested === undefined
            ? ''
            : `; a gap of ${suggested} mm makes it ${PATTERN_WEB_LIMIT} mm`),
      operation: p.id,
      parameter: web.island ? 'cell' : 'spacing',
      params: {
        feature: p.id,
        web: web.width,
        limit: PATTERN_WEB_LIMIT,
        island: web.island,
        at: web.at,
        ...(suggested === undefined ? {} : { gap: suggested }),
      },
    })
  }
  out.push(...chamferMeetsOf(p, facts, geometry.region2d, _stock))
  const chords = regionLoops(contour.region).reduce(
    (s, l) => s + flattenLoop(l, 'shrink').points.length,
    0,
  )
  if (chords < PATTERN_HEAVY_CHORDS) return out
  // a primitive cell is one piece (cells never touch); a named shape's cell may be several
  const cells = facts?.cells ?? (p.cell.kind === 'shape' || p.invert ? undefined : pieces)
  out.push({
    code: 'dfm.patternHeavy',
    severity: 'info',
    message: `${p.name}: ${pieces} pieces (${chords} chords): the part updates more slowly`,
    operation: p.id,
    parameter: 'spacing',
    params: { feature: p.id, chords, ...(cells === undefined ? {} : { cells }) },
  })
  return out
}

/** `patternWeb` at a limit, cached per resolved layout (its facts are cached with it). */
const websAt = new WeakMap<WebInput, Map<number, PatternWeb | undefined>>()

/**
 * P3: `dfm.chamferMeets` of the owned chamfer when the bevels of two cells meet: the narrowest web
 * (inverted: island) under twice the chamfer's width, measured as `dfm.patternThinWeb` (exact for
 * the lattice, a few 2D operations); the suggestion is half that web. It stands in for the edge
 * chamfer's region-wide check (`edge.pattern`), which takes minutes on hundreds of cells. P5: the
 * bottom chamfer of through cells (`<id>_bottomChamfer`) meets on the same web and has its own.
 */
function chamferMeetsOf(
  p: Pattern,
  facts: PatternFacts | undefined,
  port: Region2dPort | undefined,
  stock: Stock,
): DfmWarning[] {
  const input = facts?.webInput
  if (p.chamfer.isNone() || input === undefined || port === undefined) return []
  const { width: w, side } = p.chamfer.unwrap()
  const width = w.canonical
  const limit = 2 * width
  let byLimit = websAt.get(input)
  if (byLimit === undefined) websAt.set(input, (byLimit = new Map()))
  if (!byLimit.has(limit)) byLimit.set(limit, patternWeb(port, input, limit))
  const web = byLimit.get(limit)
  if (web === undefined) return []
  const roles =
    side === 'both'
      ? ['chamfer', 'bottomChamfer']
      : side === 'top'
        ? ['chamfer']
        : ['bottomChamfer']
  const where = web.island ? 'an island' : 'the web between cells'
  return roles.map((role): DfmWarning => {
    const id = `${p.id}_${role}`
    return {
      code: 'dfm.chamferMeets',
      severity: 'warning',
      message: `${id}: the bevels meet on ${where}, ${web.width} mm wide: its top becomes a ridge`,
      operation: id,
      parameter: 'width',
      params: { at: atOn(p, role, web.at, stock), wall: web.width, width, feature: p.id },
      suggestion: { relation: 'atMost', value: Math.floor((web.width / 2) * 100) / 100 },
    }
  })
}

/** A point of the pattern's face frame read on its bottom chamfer's face (mirrored, E4b). */
function atOn(p: Pattern, role: string, at: Vec2, stock: Stock): Vec2 {
  const from = stockFaceDirection(p.on)
  const bottom = patternBottomFace(p)
  const to = bottom === undefined ? undefined : stockFaceDirection(bottom)
  if (role !== 'bottomChamfer' || from === undefined || to === undefined) return at
  const f = faceToFace(from, to, {
    length: stock.length.canonical,
    width: stock.width.canonical,
    thickness: stock.thickness.canonical,
  })
  return [
    f.m[0][0] * at[0] + f.m[0][1] * at[1] + f.t[0] + 0,
    f.m[1][0] * at[0] + f.m[1][1] * at[1] + f.t[1] + 0,
  ]
}

/**
 * What a pattern's owned shape lays out (the resolution is cached): cells, dropped slivers, the
 * area and the thin web, from the part's shape records; undefined when it does not resolve. The
 * add/update result, the DFM and the inspector's read-out.
 */
export function patternFacts(
  featureId: string,
  shapes: readonly ShapeDTO[],
  port: Region2dPort,
): PatternFacts | undefined {
  const id = ownedShapeId(featureId)
  const own = shapes.find((s) => s.id === id)
  if (own?.pattern === undefined) return undefined
  // the cell, the boundary and (P4) the stack below, with theirs
  const refs = new Set<string>()
  const add = (sid: string) => {
    if (refs.has(sid)) return
    refs.add(sid)
    const shape = shapes.find((s) => s.id === sid)
    // a named shape's offset sources (design-llm-first.md § Offset item)
    for (const item of shape?.items ?? []) if (item.kind === 'offset') add(item.shapeId)
    const rec = shape?.pattern
    if (rec === undefined) return
    if ('shapeId' in rec.cell) add(rec.cell.shapeId)
    if (rec.area !== undefined) add(rec.area.shapeId)
    if (rec.floor !== undefined) add(rec.floor)
  }
  add(id)
  const loaded = new Map<string, NamedShape>()
  for (const s of shapes)
    if (refs.has(s.id)) {
      const n = shapeFromDTO(s)
      if (n.isErr()) return undefined
      loaded.set(s.id, n.unwrap())
    }
  const def = shapeDefinition({ kind: 'named', shapeId: id } as Shape, loaded)
  const r = def.andThen((d) => resolveShape(port, d))
  if (r.isErr()) return undefined
  const resolved = r.unwrap()
  return resolved.kind === 'region' ? resolved.pattern : undefined
}

/** The cells a pattern's owned shape lays out; undefined when it does not resolve. */
export function patternCells(
  featureId: string,
  shapes: readonly ShapeDTO[],
  port: Region2dPort,
): number | undefined {
  return patternFacts(featureId, shapes, port)?.cells
}

function patternResult(
  p: Pattern,
  shapes: readonly ShapeDTO[],
  port: Region2dPort | undefined,
): Record<string, number> {
  const f = port === undefined ? undefined : patternFacts(p.id, shapes, port)
  if (f === undefined) return {}
  return {
    cells: f.cells,
    ...(f.dropped > 0 ? { dropped: f.dropped } : {}),
    ...(f.web === undefined ? {} : { narrowestWeb: f.web.width }),
  }
}

export const patternSpec: FeatureKindSpec<Pattern> = {
  kind: 'pattern',
  idPrefix: 'pattern',
  label: 'Pattern',
  fromDTO: patternFromDTO,
  toDTO: patternToDTO,
  invariants: patternInvariants,
  expand: expandPattern,
  ownedShapes: patternShapes,
  fieldOf: patternFieldOf,
  spanWarnings: patternWarnings,
  resultOf: patternResult,
}
