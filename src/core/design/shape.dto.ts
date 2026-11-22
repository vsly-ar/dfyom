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

/** A part's named shape (docs/modes/design-v0.3.md#what-a-shape-is). */
export const ShapeDtoSchema = z.object({
  id: ShapeIdSchema,
  name: z.string().min(1).max(NAME_MAX).describe('Display label'),
  items: z.array(ShapeItemDtoSchema).min(1).max(SHAPE_ITEMS_MAX),
  source: ShapeSourceDtoSchema.optional().describe('Import origin, information only'),
})
export interface ShapeDTO {
  id: string
  name: string
  items: ShapeItemDTO[]
  source?: ShapeSource | undefined
}

/** Quantity as entered, as for operation parameters (commands.ts `Src`). */
export const ShapeSrcSchema = z
  .string()
  .min(1)
  .max(256)
  .describe('Quantity as entered: literal or formula over stock faces (`stock.side[1].x - 10`)')

/** An item as command args: quantities as entered, defaults may be left out. */
export const ShapeItemArgSchema = itemSchema(() => ShapeSrcSchema, 'args').describe(
  'Shape item in the shape frame (x right, y up)',
)
export type ShapeItemArgs = z.output<typeof ShapeItemArgSchema>
