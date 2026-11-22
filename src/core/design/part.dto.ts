/**
 * Persisted shape of a part and its v0.1 operations (record `parts/<id>.json`).
 * Shape only; constraints live in validate.ts. Doc: docs/modes/design.md#part-and-stock-v01,
 * docs/modes/design.md#operations-v01, docs/modes/design.md#implementation-task-25
 */
import { z } from 'zod'
import { NAME_MAX, quantityDto } from '../library/item'

const length = () => quantityDto('length')

/** `facing1`, `pocket2`, `drill3`, `profile1`: kind prefix + number, immutable. */
export const OPERATION_ID_PATTERN = /^(facing|pocket|drill|profile)[1-9][0-9]{0,5}$/

export const OperationIdSchema = z
  .string()
  .regex(OPERATION_ID_PATTERN)
  .describe('Operation id, e.g. pocket1 (used in surface ids)')

/**
 * `stock.top`, `stock.side[1]`, `facing1.floor`, `profile1.tab[0].top`, …
 * (docs/architecture/geometry.md); a face target, docs/modes/design-v0.2.md#face-targets-generalised-on.
 */
export const SurfaceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .describe('Surface id, e.g. stock.top or facing1.floor')

/** Point `[u, v]` in the face frame of the operation's `on` (`[x, y]` on the top face). */
export const PointDtoSchema = z.tuple([length(), length()])

export const ShapeDtoSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rectangle'),
    center: PointDtoSchema,
    length: length().describe('Size along X'),
    width: length().describe('Size along Y'),
    cornerRadius: length(),
  }),
  z.object({ kind: z.literal('circle'), center: PointDtoSchema, diameter: length() }),
])
export type ShapeDTO = z.output<typeof ShapeDtoSchema>

/** One symmetric `±` per kind; the value is the deviation (`0.1 mm` = ±0.1 mm). */
export const GeneralToleranceDtoSchema = z.object({
  length: length().optional(),
  angle: quantityDto('angle').optional(),
})
export type GeneralToleranceDTO = z.output<typeof GeneralToleranceDtoSchema>

const common = {
  id: OperationIdSchema,
  name: z.string().min(1).max(NAME_MAX).describe('Display label'),
  generalTolerance: GeneralToleranceDtoSchema.optional(),
}

export const DRILL_BOTTOMS = ['through', 'flat', 'drillPoint'] as const
export type DrillBottomKind = (typeof DRILL_BOTTOMS)[number]
export const PROFILE_SIDES = ['outside', 'inside'] as const

/** Absent on a facing or profile = `stock.top` (v0.1 records load unchanged). */
const stockFaceOn = SurfaceIdSchema.optional().describe(
  'Stock face it starts from; default stock.top',
)

export const FacingDtoSchema = z.object({
  kind: z.literal('facing'),
  ...common,
  on: stockFaceOn,
  depth: length(),
})
export const PocketDtoSchema = z.object({
  kind: z.literal('pocket'),
  ...common,
  on: SurfaceIdSchema,
  shape: ShapeDtoSchema,
  depth: length(),
  floorRadius: length(),
})
export const DrillingDtoSchema = z.object({
  kind: z.literal('drilling'),
  ...common,
  on: SurfaceIdSchema,
  center: PointDtoSchema,
  diameter: length(),
  bottom: z.enum(DRILL_BOTTOMS),
  depth: length().optional().describe('Not for through holes'),
  pointAngle: quantityDto('angle').optional().describe('drillPoint only'),
})
export const ProfileDtoSchema = z.object({
  kind: z.literal('profile'),
  ...common,
  on: stockFaceOn,
  shape: ShapeDtoSchema,
  side: z.enum(PROFILE_SIDES),
  slotWidth: length(),
  tabs: z.object({ count: quantityDto('scalar'), width: length(), thickness: length() }),
})

export const OperationDtoSchema = z.discriminatedUnion('kind', [
  FacingDtoSchema,
  PocketDtoSchema,
  DrillingDtoSchema,
  ProfileDtoSchema,
])
export type OperationDTO = z.output<typeof OperationDtoSchema>
export type OperationKind = OperationDTO['kind']

export const PartIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/)
  .describe('Part id')

export const PartDtoSchema = z.object({
  id: PartIdSchema,
  name: z.string().min(1).max(NAME_MAX),
  stock: z.string().min(1).describe('Id of the block stock snapshot (snapshots/<id>.json)'),
  generalTolerance: GeneralToleranceDtoSchema.optional(),
  operations: z.array(OperationDtoSchema).describe('Design order; references go to earlier ones'),
})
export type PartDTO = z.output<typeof PartDtoSchema>
