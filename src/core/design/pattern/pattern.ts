/**
 * The pattern feature kind (patterns P1): many copies of a cell laid on a lattice over a face,
 * cut by one pocket. The feature owns a read-only shape `<id>_cells` (its geometry fields as
 * numbers, resolved by the 2D layer without booleans, layout.ts) and the pocket `<id>_pocket`
 * that places it.
 * Doc: docs/modes/patterns.md#model, docs/modes/patterns.md#implementation-p1
 *
 * Only types come from feature.ts, which registers this kind as built in; the commands are in
 * pattern/commands.ts.
 */
import { z } from 'zod'
import type { Issue, IssuePath } from '../../../shared/errors/app-error'
import { parseWith } from '../../../shared/parse'
import { collect, fail, None, Ok, Some, type AppResult, type Option } from '../../../shared/result'
import type { Region2dPort } from '../../geometry/2d/port'
import { localStock, type Direction } from '../../geometry/face'
import type { DfmWarning } from '../../geometry/model'
import { flattenLoop } from '../../geometry/prism'
import { regionLoops } from '../../geometry/2d/model'
import { quantityDto, quantityFromDTO } from '../../library/item'
import type { QuantityDTO } from '../../quantity/quantity.dto'
import { derivedLength } from '../hole'
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
import { PATTERN_HEAVY_CHORDS } from './layout'

/** The cell: a primitive centred on its node, or a named closed shape of the part (its box centre). */
export type PatternCell = { readonly rotation: Quantity } & (
  | { readonly kind: 'circle'; readonly diameter: Quantity }
  | {
      readonly kind: 'rectangle'
      readonly length: Quantity
      readonly width: Quantity
      readonly cornerRadius: Quantity
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

export interface Pattern extends FeatureBase {
  readonly kind: 'pattern'
  readonly cell: PatternCell
  readonly lattice: PatternLattice
  /** The whole lattice (cells included) turns by it about `origin`. */
  readonly angle: Quantity
  /** `[u, v]` in the face frame; None = the centre of the face less the margin. */
  readonly origin: Option<Point>
  readonly spacing: PatternSpacing
  /** The uncut border inside the face (≥ 0). */
  readonly margin: Quantity
  /** The pocket's depth below `on`. */
  readonly depth: Quantity
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
  margin: length(),
  depth: length(),
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
  return collect([collect(cellQs), collect(spacingQs), collect(originQs), collect(rest)]).map(
    (all) => {
      const [cq, s, o, rest3] = all as [Quantity[], Quantity[], Quantity[], Quantity[]]
      const [ang, margin, depth] = rest3
      const [rot, a, b, r] = cq
      const cell: PatternCell =
        c.kind === 'circle'
          ? { kind: 'circle', rotation: rot!, diameter: a! }
          : c.kind === 'rectangle'
            ? { kind: 'rectangle', rotation: rot!, length: a!, width: b!, cornerRadius: r! }
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
        margin: margin!,
        depth: depth!,
      }
    },
  )
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
    margin: p.margin.toDTO(),
    depth: p.depth.toDTO(),
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
  if (c.kind === 'polygon') positive(c.diameter, 'cell', 'diameter')
  if (c.kind === 'shape')
    check(
      /^shape[1-9]\d*$/.test(c.shapeId),
      ['cell', 'shapeId'],
      'shapeCycle',
      "a pattern's cell is a named shape of the part, not an owned shape",
    )
  return issues
}

// ── expansion ──────────────────────────────────────────────────────────────────────────────

const MIN_ANCHOR: Anchor = Object.freeze({ u: 'min', v: 'min' })

/**
 * One owned pocket placing the owned shape: anchored at its frame's corner [0, 0] (the face
 * frame's origin), so the cells keep face-frame coordinates (placement.ts anchors a pattern by
 * its frame, the face rectangle).
 */
function expandPattern(p: Pattern, ctx: ExpansionContext): AppResult<readonly ExpandedOperation[]> {
  return derivedLength(ZERO, ctx.units).map((zero) => [
    {
      role: 'pocket',
      operation: {
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
        depth: p.depth,
        floorRadius: zero,
      },
    },
  ])
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
    boundary: faceRect(p.on, before, stock),
    margin: p.margin.canonical,
  }
}

function patternShapes(p: Pattern, ctx: ExpansionContext): AppResult<readonly ShapeDTO[]> {
  const c = p.cell
  if (c.kind === 'shape' && !ctx.shapes.some((s) => s.id === c.shapeId && s.owner === undefined))
    return fail('input.malformed', `shape ${c.shapeId} does not exist in the part`, {
      issues: [
        {
          path: ['cell', 'shapeId'],
          rule: 'unknownShape',
          message: "no such shape; design_shape_list lists the part's shapes",
        },
      ],
      data: { shapeId: c.shapeId },
    })
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

/** Owned pocket parameter → pattern field. */
function patternFieldOf(role: string, path: IssuePath): IssuePath | undefined {
  if (role !== 'pocket') return undefined
  const head = String(path[0])
  if (head === 'depth' || head === 'on') return [head, ...path.slice(1)]
  // the owned shape's resolution (layout.ts) names the pattern's own fields
  if (head === 'shapes') return path.slice(2)
  if (head === 'shape') return ['cell']
  return undefined
}

/**
 * `dfm.patternEmpty` (no cell fits the face less the margin) and `dfm.patternHeavy` (info: the
 * cells' region passes `PATTERN_HEAVY_CHORDS`), from the owned pocket's placed region in the
 * part's geometry input; `operation` = the feature id.
 */
function patternWarnings(
  p: Pattern,
  _ops: readonly Operation[],
  _stock: Stock,
  _units: unknown,
  _shapes: readonly ShapeDTO[],
  geometry: SpanGeometry,
): DfmWarning[] {
  const g = geometry.operations.find((o) => o.id === `${p.id}_pocket`)
  if (g === undefined || g.kind !== 'pocket' || g.shape === undefined) return []
  const contour = g.shape.contour
  if (contour.kind !== 'region') return []
  const pieces = contour.region.pieces.length
  if (pieces === 0)
    return [
      {
        code: 'dfm.patternEmpty',
        severity: 'warning',
        message: `${p.name}: no cell fits the face less the margin; make the cell or the margin smaller`,
        operation: p.id,
        parameter: 'margin',
        params: { feature: p.id },
      },
    ]
  const chords = regionLoops(contour.region).reduce(
    (s, l) => s + flattenLoop(l, 'shrink').points.length,
    0,
  )
  if (chords < PATTERN_HEAVY_CHORDS) return []
  // a primitive cell is one piece (cells never touch); a named shape's cell may be several
  const cells = p.cell.kind === 'shape' ? undefined : pieces
  return [
    {
      code: 'dfm.patternHeavy',
      severity: 'info',
      message: `${p.name}: ${pieces} pieces (${chords} chords): the part updates more slowly`,
      operation: p.id,
      parameter: 'spacing',
      params: { feature: p.id, chords, ...(cells === undefined ? {} : { cells }) },
    },
  ]
}

/**
 * The cells a pattern's owned shape lays out (the resolution is cached), from the part's shape
 * records; undefined when it does not resolve. The add/update result's `cells` and the
 * inspector's read-out.
 */
export function patternCells(
  featureId: string,
  shapes: readonly ShapeDTO[],
  port: Region2dPort,
): number | undefined {
  const id = ownedShapeId(featureId)
  const own = shapes.find((s) => s.id === id)
  if (own?.pattern === undefined) return undefined
  const cell = own.pattern.cell
  const loaded = new Map<string, NamedShape>()
  for (const s of shapes)
    if (s.id === id || ('shapeId' in cell && s.id === cell.shapeId)) {
      const n = shapeFromDTO(s)
      if (n.isErr()) return undefined
      loaded.set(s.id, n.unwrap())
    }
  const def = shapeDefinition({ kind: 'named', shapeId: id } as Shape, loaded)
  const r = def.andThen((d) => resolveShape(port, d))
  if (r.isErr()) return undefined
  const resolved = r.unwrap()
  return resolved.kind === 'region' ? (resolved.cells ?? 0) : undefined
}

function patternResult(
  p: Pattern,
  shapes: readonly ShapeDTO[],
  port: Region2dPort | undefined,
): Record<string, number> {
  const cells = port === undefined ? undefined : patternCells(p.id, shapes, port)
  return cells === undefined ? {} : { cells }
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
