/**
 * Persisted shape of a part's named shapes (`part.shapes[]` in `parts/<id>.json`) and the
 * command args of their items. Shape only; the rules live in shape.ts and shape-items.ts.
 * Doc: docs/modes/design-v0.3.md#shape-definition, docs/modes/design-v0.3.md#persistence,
 * docs/architecture/shapes.md#implementation-k2
 *
 * One generic item type (`ShapeItem<Q>`) serves every stage: the args (`Q` = the source string),
 * the DTO (`QuantityDTO`), the model (`Quantity`) and the resolver's numbers (mm, degrees).
 */
import { z } from 'zod'
import { NAME_MAX, quantityDto } from '../library/item'
import type { QuantityDTO } from '../quantity/quantity.dto'

/** `shape1`, `shape2`, …: immutable (design.md § Implementation). */
export const SHAPE_ID_PATTERN = /^shape[1-9][0-9]{0,5}$/
export const ShapeIdSchema = z.string().regex(SHAPE_ID_PATTERN).describe('Shape id, e.g. shape1')
/**
 * A feature's owned shape (patterns P1, docs/modes/patterns.md#owned-shape-and-operations):
 * `<featureId>_cells`. Stored and placed like a named shape, never an argument of the shape
 * tools (which take `ShapeIdSchema`).
 */
export const OWNED_SHAPE_ID_PATTERN = /^[a-z][a-zA-Z]*[1-9]\d*_cells$/
/** Any stored shape id: a named shape's or a feature's owned shape's. */
export const StoredShapeIdSchema = z
  .string()
  .regex(new RegExp(`${SHAPE_ID_PATTERN.source}|${OWNED_SHAPE_ID_PATTERN.source}`))

/** How an item combines with the items before it; the first item is always `add`. */
export const SHAPE_OPS = ['add', 'subtract', 'intersect'] as const
export type ShapeOp = (typeof SHAPE_OPS)[number]
/** A polygon's `diameter` is measured across its corners (default) or across its flats. */
export const POLYGON_ACROSS = ['corners', 'flats'] as const
export type PolygonAcross = (typeof POLYGON_ACROSS)[number]

/** Limits that keep a record and a command bounded (the SVG import limit is 20 000 elements). */
export const SHAPE_ITEMS_MAX = 1000
export const PATH_SEGMENTS_MAX = 20_000

export type ShapePoint<Q> = [Q, Q]

export type ShapeSegment<Q> =
  | { kind: 'line'; to: ShapePoint<Q> }
  | { kind: 'arc'; to: ShapePoint<Q>; radius: Q; cw: boolean; large?: boolean | undefined }
  | { kind: 'tangentArc'; to: ShapePoint<Q> }

export interface ShapeFillet<Q> {
  /** Vertex 0 is `start`, vertex i the end of segment i − 1 (a closed path's ends: vertex 0). */
  vertex: number
  radius: Q
}

/**
 * One item of a shape definition (docs/modes/design-v0.3.md#shape-definition); quantities are
 * `Q`, optional ones absent when not given (`rotation` 0, polygon `cornerRadius` 0, `across`
 * corners).
 */
export type ShapeItem<Q> =
  | {
      kind: 'rectangle'
      op: ShapeOp
      center: ShapePoint<Q>
      length: Q
      width: Q
      cornerRadius: Q
      rotation?: Q | undefined
    }
  | { kind: 'circle'; op: ShapeOp; center: ShapePoint<Q>; diameter: Q }
  | {
      kind: 'obround'
      op: ShapeOp
      center: ShapePoint<Q>
      length: Q
      width: Q
      rotation?: Q | undefined
    }
  | {
      kind: 'polygon'
      op: ShapeOp
      center: ShapePoint<Q>
      sides: Q
      diameter: Q
      across?: PolygonAcross | undefined
      cornerRadius?: Q | undefined
      rotation?: Q | undefined
    }
  | {
      kind: 'path'
      op: ShapeOp
      start: ShapePoint<Q>
      segments: ShapeSegment<Q>[]
      closed: boolean
      fillets?: ShapeFillet<Q>[] | undefined
    }

export type ShapeItemKind = ShapeItem<unknown>['kind']

/** Where an imported shape came from (information only; the SVG is not stored). */
export interface ShapeSource {
  file: string
  element?: string | undefined
}

// ── schemas ─────────────────────────────────────────────────────────────────────────────────

type QuantityField = 'length' | 'angle' | 'scalar'

/**
 * The item union for the DTO (`dto`: every default written) or the command args (`args`:
 * defaults may be left out). `q(kind)` is the quantity schema of a field.
 */
function itemSchema(q: (kind: QuantityField) => z.ZodType, mode: 'dto' | 'args') {
  const len = () => q('length')
  const point = (what: string) => z.tuple([len(), len()]).describe(`[x, y] ${what}`)
  const dflt = <T extends z.ZodType>(s: T) => (mode === 'dto' ? s : s.optional())
  const op = dflt(z.enum(SHAPE_OPS)).describe(
    'Combines with the items before: add (default), subtract, intersect; the first item adds',
  )
  const rotation = q('angle').optional().describe('Counter-clockwise about center, default 0')
  const segment = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('line'), to: point('end') }),
    z.object({
      kind: z.literal('arc'),
      to: point('end'),
      radius: len().describe('≥ half the chord'),
      cw: dflt(z.boolean()).describe('Clockwise; default false'),
      large: z.boolean().optional().describe('The arc over 180°; default false'),
    }),
    z.object({
      kind: z.literal('tangentArc'),
      to: point('end').describe('[x, y] end; tangent to the previous segment'),
    }),
  ])
  return z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('rectangle'),
      op,
      center: point('centre'),
      length: len().describe('Size along x'),
      width: len().describe('Size along y'),
      cornerRadius: dflt(len()).describe('Default 3 mm / 1/8"'),
      rotation,
    }),
    z.object({ kind: z.literal('circle'), op, center: point('centre'), diameter: len() }),
    z.object({
      kind: z.literal('obround'),
      op,
      center: point('centre'),
      length: len().describe('Overall size along x (≥ width)'),
      width: len().describe('Size along y: the end diameter'),
      rotation,
    }),
    z.object({
      kind: z.literal('polygon'),
      op,
      center: point('centre'),
      sides: q('scalar').describe('3–64'),
      diameter: len(),
      across: z.enum(POLYGON_ACROSS).optional().describe('diameter across corners (default)'),
      cornerRadius: len().optional().describe('Default 0'),
      rotation: q('angle')
        .optional()
        .describe('Counter-clockwise; at 0 a flat side is at the bottom'),
    }),
    z.object({
      kind: z.literal('path'),
      op,
      start: point('start'),
      segments: z.array(segment).min(1).max(PATH_SEGMENTS_MAX),
      closed: dflt(z.boolean()).describe(
        'Closes with a line back to start if needed; default true',
      ),
      fillets: z
        .array(
          z.object({
            vertex: z.number().int().min(0).describe('0 = start, i = end of segment i-1'),
            radius: len(),
          }),
        )
        .optional()
        .describe('Tangent arcs rounding vertices'),
    }),
  ])
}

const quantityDtoOf = (kind: QuantityField): z.ZodType => quantityDto(kind)

export const ShapeItemDtoSchema = itemSchema(quantityDtoOf, 'dto') as unknown as z.ZodType<
  ShapeItem<QuantityDTO>
>
export type ShapeItemDTO = ShapeItem<QuantityDTO>

export const ShapeSourceDtoSchema = z.object({
  file: z.string().min(1).max(1024),
  element: z.string().min(1).max(NAME_MAX).optional(),
})

// ── pattern (owned shape of a pattern feature, patterns P1) ─────────────────────────────────

/** Lattices of a pattern (docs/modes/patterns.md#model); `polar` comes with P2. */
export const PATTERN_LATTICES = ['square', 'staggered', 'hex'] as const
export type PatternLattice = (typeof PATTERN_LATTICES)[number]

/** Cell primitives of a pattern: the shape items without a centre (it sits on the node). */
export const PATTERN_PRIMITIVES = ['circle', 'rectangle', 'obround', 'polygon'] as const
export type PatternPrimitive = (typeof PATTERN_PRIMITIVES)[number]

/**
 * The pattern record of an owned shape: the feature's geometry fields resolved to numbers (mm,
 * degrees) by its expansion, so the 2D layer resolves it like any shape (shape.ts). The cell is
 * a primitive item centred on the origin, or a named shape of the part by id (resolved from the
 * part's shapes when placed, so it follows edits of that shape). `boundary` is the face rectangle
 * in the face frame; cells keep face-frame coordinates.
 */
export interface PatternRecord {
  cell: { item: ShapeItem<number> } | { shapeId: string }
  /** Degrees about the cell's box centre, before the lattice angle. */
  cellRotation: number
  lattice: PatternLattice
  /** Degrees: the whole lattice (cells included) turns about `origin`. */
  angle: number
  /** Face frame; absent = the centre of the boundary less the margin. */
  origin?: [number, number] | undefined
  spacing: { gap: number } | { pitch: [number, number] }
  boundary: { min: [number, number]; max: [number, number] }
  margin: number
}

const num = z.number().refine(Number.isFinite)
const pair = z.tuple([num, num])
export const ShapeItemNumberSchema = itemSchema(() => num, 'dto') as unknown as z.ZodType<
  ShapeItem<number>
>
export const PatternRecordSchema: z.ZodType<PatternRecord> = z.object({
  cell: z.union([z.object({ item: ShapeItemNumberSchema }), z.object({ shapeId: ShapeIdSchema })]),
  cellRotation: num,
  lattice: z.enum(PATTERN_LATTICES),
  angle: num,
  origin: pair.optional(),
  spacing: z.union([z.object({ gap: num }), z.object({ pitch: pair })]),
  boundary: z.object({ min: pair, max: pair }),
  margin: num,
}) as unknown as z.ZodType<PatternRecord>

/**
 * A part's named shape (docs/modes/design-v0.3.md#what-a-shape-is), or a feature's owned shape
 * (`owner`, patterns P1): read-only, no items, its geometry in `pattern`.
 */
export const ShapeDtoSchema = z
  .object({
    id: StoredShapeIdSchema,
    name: z.string().min(1).max(NAME_MAX),
    items: z.array(ShapeItemDtoSchema).max(SHAPE_ITEMS_MAX),
    source: ShapeSourceDtoSchema.optional().describe('Import origin, information only'),
    owner: z.string().optional().describe('The feature owning this shape (read-only)'),
    pattern: PatternRecordSchema.optional(),
  })
  .refine(
    (s) =>
      s.owner === undefined
        ? s.items.length > 0 && s.pattern === undefined && SHAPE_ID_PATTERN.test(s.id)
        : s.items.length === 0 && s.pattern !== undefined && s.id === `${s.owner}_cells`,
    'a named shape has items; an owned shape <owner>_cells has a pattern and no items',
  )
export interface ShapeDTO {
  id: string
  name: string
  items: ShapeItemDTO[]
  source?: ShapeSource | undefined
  /** A feature's owned shape (patterns P1): its id is `<owner>_cells`. */
  owner?: string | undefined
  pattern?: PatternRecord | undefined
}

/** Quantity as entered, as for operation parameters (commands.ts `Src`). */
export const ShapeSrcSchema = z.string().min(1).max(256).describe('Formulas over stock faces only')

/** An item as command args: quantities as entered, defaults may be left out. */
export const ShapeItemArgSchema = itemSchema(() => ShapeSrcSchema, 'args').describe(
  'Shape item in the shape frame (x right, y up)',
)
export type ShapeItemArgs = z.output<typeof ShapeItemArgSchema>
