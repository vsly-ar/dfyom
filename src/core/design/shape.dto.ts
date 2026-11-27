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
// No description: ids come from results (primer, tools/list budget).
export const ShapeIdSchema = z.string().regex(SHAPE_ID_PATTERN)
/**
 * A feature's owned shape (patterns P1, docs/modes/patterns.md#owned-shape-and-operations):
 * `<featureId>_cells`; an engraved pattern's (engraved-patterns.md E3) `<featureId>_lines`.
 * Stored and placed like a named shape, never an argument of the shape tools (which take
 * `ShapeIdSchema`).
 */
export const OWNED_SHAPE_ID_PATTERN = /^[a-z][a-zA-Z]*[1-9]\d*_(cells|lines)$/
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
/** An offset item grows (`outward`) or shrinks (`inward`) its source (design-llm-first.md DL-A). */
export const OFFSET_DIRECTIONS = ['outward', 'inward'] as const
export type OffsetDirection = (typeof OFFSET_DIRECTIONS)[number]

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
      /** DF120 Round: `cornerRadius` is half the narrowest side (kept by the commands). */
      round?: true | undefined
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
      /**
       * Engraving levels 0..1 (engraved-patterns.md E2, § Levels on shapes): one for the path, or
       * one per vertex (`segments.length + 1`), linear by arc length between vertices. Read by a
       * Line with `{ min, max }` depth; booleans ignore them.
       */
      levels?: number | number[] | undefined
    }
  | {
      /**
       * Another named shape of the part offset by `distance` (docs/modes/design-llm-first.md#offset-item):
       * stores the reference, so the item follows edits of the source.
       */
      kind: 'offset'
      op: ShapeOp
      shapeId: string
      distance: Q
      direction: OffsetDirection
      /**
       * Resolver stage only (never stored): the source's definition inlined by
       * `withOffsetSources` (shape.ts), or why it could not be (no such shape, a cycle). It is
       * part of the definition, so caches and staleness key on the source too.
       */
      source?: OffsetSource | undefined
    }

/** An offset item's inlined source: its definition (numbers), or the refusal rule. */
export type OffsetSource = ShapeItem<number>[] | 'unknownShape' | 'shapeCycle'

export type ShapeItemKind = ShapeItem<unknown>['kind']

/** Where an imported shape came from (information only; the SVG is not stored). */
export interface ShapeSource {
  file: string
  element?: string | undefined
}

// ── schemas ─────────────────────────────────────────────────────────────────────────────────

type QuantityField = 'length' | 'angle' | 'scalar'

/**
 * A rectangle's `cornerRadius` arg (pockets, profiles, shape items): `"round"` (DF120); the primer's
 * operation-args line explains Round once (docs/modes/hole-slots-and-round-corners.md#agent-api,
 * tools/list budget).
 */
export const ROUND_DESCRIPTION = 'Default 3 mm / 1/8", or "round"'

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
      cornerRadius: dflt(len()).describe(
        mode === 'dto' ? 'Default 3 mm / 1/8"' : ROUND_DESCRIPTION,
      ),
      round: mode === 'dto' ? z.literal(true).optional() : z.boolean().optional(),
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
      // E2: stored only (set by the SVG import, kept by item edits); not a command arg, so
      // design.shape.add/item.update stay as listed (tools/list budget, engraved-patterns.md)
      ...(mode === 'dto'
        ? {
            levels: z
              .union([z.number(), z.array(z.number()).max(PATH_SEGMENTS_MAX + 1)])
              .optional(),
          }
        : {}),
    }),
    z.object({
      kind: z.literal('offset'),
      op,
      shapeId: ShapeIdSchema.describe('Source shape; follows its edits'),
      distance: len(),
      direction: z.enum(OFFSET_DIRECTIONS),
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

/** Lattices of an engraved pattern's tiles (engraved-patterns.md E4): Pattern's first four. */
export const ENGRAVING_LATTICES = ['square', 'staggered', 'hex', 'polar'] as const
export type EngravingLattice = (typeof ENGRAVING_LATTICES)[number]

/**
 * Lattices of a pattern (docs/modes/patterns.md#model; `polar` since P2; `radial` since heatsink
 * H3: `count` cells on one circle of `radius`, each turned to face out,
 * docs/modes/pattern-presets.md#model-changes).
 */
export const PATTERN_LATTICES = [...ENGRAVING_LATTICES, 'radial'] as const
export type PatternLattice = (typeof PATTERN_LATTICES)[number]

/** Cell primitives of a pattern: the shape items without a centre (it sits on the node). */
export const PATTERN_PRIMITIVES = ['circle', 'rectangle', 'obround', 'polygon'] as const
export type PatternPrimitive = (typeof PATTERN_PRIMITIVES)[number]

/**
 * The pattern record of an owned shape: the feature's geometry fields resolved to numbers (mm,
 * degrees) by its expansion, so the 2D layer resolves it like any shape (shape.ts). The cell is
 * a primitive item centred on the origin, or a named shape of the part by id (resolved from the
 * part's shapes when placed, so it follows edits of that shape). `boundary` is the face rectangle
 * in the face frame (the frame placement anchors by); cells keep face-frame coordinates. P2
 * (docs/modes/patterns.md#implementation-p2): `area` a named boundary shape placed in the face
 * frame, `fit`, `invert`, and `clip` (a split piece's cell rectangle). P4
 * (docs/modes/patterns.md#implementation-p4): `through` and `floor` (stacking). Absent optional
 * fields keep a P1 record unchanged.
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
  /**
   * H3 (`lattice: 'radial'` only; absent on other lattices): the cells on the circle and its
   * radius about `origin`, the first cell at `angle`. Doc: docs/modes/pattern-presets.md#model-changes
   */
  count?: number | undefined
  radius?: number | undefined
  /** P5: every other cell turned 180° (absent = none). */
  alternate?: 'flip' | undefined
  boundary: { min: [number, number]; max: [number, number] }
  /** A named shape as the boundary: its box centre at `center` (face frame), turned by `rotation`. */
  area?: { shapeId: string; center: [number, number]; rotation: number } | undefined
  /**
   * The uncut border inside the boundary; H1 (docs/modes/pattern-presets.md#model-changes): or
   * `[u, v]` in the face frame (the boundary eroded by an axis-aligned box of those half-sizes).
   */
  margin: number | [number, number]
  /** Absent = `whole`. */
  fit?: 'clip' | undefined
  invert?: true | undefined
  /** A split piece's cell rectangle (face frame): the cells are cut by it (split/pieces.ts). */
  clip?: { min: [number, number]; max: [number, number] } | undefined
  /** P4: cut through the stock (a cell with holes would leave them loose: refused). */
  through?: true | undefined
  /**
   * P4 (stacking): the owned shape of the pattern whose floor this one stands on; the area is
   * that pattern's region (face frame, same direction) less the margin, within `area` if given.
   */
  floor?: string | undefined
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
  count: num.optional(),
  radius: num.optional(),
  alternate: z.literal('flip').optional(),
  boundary: z.object({ min: pair, max: pair }),
  area: z.object({ shapeId: ShapeIdSchema, center: pair, rotation: num }).optional(),
  margin: z.union([num, pair]),
  fit: z.literal('clip').optional(),
  invert: z.literal(true).optional(),
  clip: z.object({ min: pair, max: pair }).optional(),
  through: z.literal(true).optional(),
  floor: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9]*_cells$/)
    .optional(),
}) as unknown as z.ZodType<PatternRecord>

// ── engraving (owned shape of an engraved pattern, engraved-patterns.md E3) ──────────────────

/**
 * The engraving record of an owned shape `<featureId>_lines`: the feature's motif and placement
 * resolved to numbers (mm, degrees) by its expansion, read by the Line's geometry (engraving/
 * resolve.ts: the motif's lines placed in the face frame). `motif` is a preset id or named shapes
 * of the part (their joint bounding box is the motif's frame, so they follow edits). `boundary`
 * is the face rectangle (face frame), `area` a named closed boundary shape placed as a pattern's.
 * The motif's frame centre goes to `center` (absent: the centre of the boundary less the margin),
 * turned by `rotation`, at `size` (the frame's width; absent: its own) or, with `fit: 'boundary'`,
 * scaled so its lines fit the boundary less the margin, centred. E4: with `layout` the motif is a
 * tile repeated at the nodes of Pattern's lattice (the frame's centre on each node, the pitch the
 * frame plus the gap), `radial` turns each polar tile to face away from the origin, and
 * `fit: 'clip'` cuts lines at the boundary less the margin (absent fit with a lattice: whole
 * tiles only).
 */
export interface EngravingRecord {
  motif: { preset: string } | { shapeIds: string[] }
  boundary: { min: [number, number]; max: [number, number] }
  area?: { shapeId: string; center: [number, number]; rotation: number } | undefined
  margin: number
  center?: [number, number] | undefined
  size?: number | undefined
  rotation: number
  fit?: 'boundary' | 'clip' | undefined
  /** E4: absent = `single`. */
  layout?: EngravingLayoutRecord | undefined
  /** E4: polar tiles turned to face away from the origin. */
  radial?: true | undefined
}

/** An engraved pattern's lattice (E4): Pattern's fields; a gap may be 0 (tiles touch). */
export interface EngravingLayoutRecord {
  lattice: EngravingLattice
  /** Degrees: the lattice (tiles included) turns about `origin`; polar: the rings' start. */
  angle: number
  /** Face frame; absent = the centre of the boundary less the margin. */
  origin?: [number, number] | undefined
  spacing: { gap: number } | { pitch: [number, number] }
  alternate?: 'flip' | undefined
}

export const EngravingRecordSchema: z.ZodType<EngravingRecord> = z.object({
  motif: z.union([
    z.object({ preset: z.string().min(1).max(64) }),
    z.object({ shapeIds: z.array(ShapeIdSchema).min(1).max(50) }),
  ]),
  boundary: z.object({ min: pair, max: pair }),
  area: z.object({ shapeId: ShapeIdSchema, center: pair, rotation: num }).optional(),
  margin: num,
  center: pair.optional(),
  size: num.optional(),
  rotation: num,
  fit: z.enum(['boundary', 'clip']).optional(),
  layout: z
    .object({
      lattice: z.enum(ENGRAVING_LATTICES),
      angle: num,
      origin: pair.optional(),
      spacing: z.union([z.object({ gap: num }), z.object({ pitch: pair })]),
      alternate: z.literal('flip').optional(),
    })
    .optional(),
  radial: z.literal(true).optional(),
}) as unknown as z.ZodType<EngravingRecord>

/**
 * A part's named shape (docs/modes/design-v0.3.md#what-a-shape-is), or a feature's owned shape
 * (`owner`, patterns P1): read-only, no items, its geometry in `pattern` (`<owner>_cells`) or
 * `engraving` (`<owner>_lines`, engraved-patterns.md E3).
 */
export const ShapeDtoSchema = z
  .object({
    id: StoredShapeIdSchema,
    name: z.string().min(1).max(NAME_MAX),
    items: z.array(ShapeItemDtoSchema).max(SHAPE_ITEMS_MAX),
    source: ShapeSourceDtoSchema.optional().describe('Import origin, information only'),
    owner: z.string().optional().describe('The feature owning this shape (read-only)'),
    pattern: PatternRecordSchema.optional(),
    engraving: EngravingRecordSchema.optional(),
  })
  .refine(
    (s) =>
      s.owner === undefined
        ? s.items.length > 0 &&
          s.pattern === undefined &&
          s.engraving === undefined &&
          SHAPE_ID_PATTERN.test(s.id)
        : s.items.length === 0 &&
          (s.pattern !== undefined
            ? s.engraving === undefined && s.id === `${s.owner}_cells`
            : s.engraving !== undefined && s.id === `${s.owner}_lines`),
    'a named shape has items; an owned shape has no items and a pattern (<owner>_cells) or an engraving (<owner>_lines)',
  )
export interface ShapeDTO {
  id: string
  name: string
  items: ShapeItemDTO[]
  source?: ShapeSource | undefined
  /** A feature's owned shape (patterns P1): its id is `<owner>_cells` (engraving: `_lines`). */
  owner?: string | undefined
  pattern?: PatternRecord | undefined
  engraving?: EngravingRecord | undefined
}

/** Quantity as entered, as for operation parameters (commands.ts `Src`). */
export const ShapeSrcSchema = z.string().min(1).max(256).describe('Formulas over stock faces only')

/** An item as command args: quantities as entered, defaults may be left out. */
export const ShapeItemArgSchema = itemSchema(() => ShapeSrcSchema, 'args').describe(
  'Shape item in the shape frame (x right, y up)',
)
export type ShapeItemArgs = z.output<typeof ShapeItemArgSchema>
