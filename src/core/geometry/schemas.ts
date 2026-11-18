/**
 * Zod schemas of the geometry data that crosses a worker boundary: `PartGeometryInput` (checked
 * in the worker), `PartEvaluation` and `DfmWarning` (checked in the host).
 * Doc: docs/architecture/workers.md#zod-at-the-boundary
 *
 * Each schema is typed against its interface in `model.ts` / `evaluate.ts`, so the two cannot
 * drift apart. Optional fields use `exactOptional` (the project compiles with
 * `exactOptionalPropertyTypes`).
 */
import { z } from 'zod'
import type { PartEvaluation } from './evaluate'
import {
  DFM_WARNING_CODES,
  type DfmWarning,
  type OperationGeometry,
  type PartGeometryInput,
  type StockGeometry,
} from './model'

export const Vec2Schema = z.tuple([z.number(), z.number()]).readonly()
export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]).readonly()

const ContourSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rectangle'),
    length: z.number(),
    width: z.number(),
    cornerRadius: z.number(),
  }),
  z.object({ kind: z.literal('circle'), radius: z.number() }),
])

const ShapeSchema = z.object({ center: Vec2Schema, contour: ContourSchema })

export const StockGeometrySchema: z.ZodType<StockGeometry> = z.object({
  length: z.number(),
  width: z.number(),
  thickness: z.number(),
})

const DrillBottomSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('through') }),
  z.object({ kind: z.literal('flat'), depth: z.number() }),
  z.object({ kind: z.literal('drillPoint'), depth: z.number(), pointAngle: z.number() }),
])

export const FacingGeometrySchema = z.object({
  kind: z.literal('facing'),
  id: z.string(),
  depth: z.number(),
})
export const PocketGeometrySchema = z.object({
  kind: z.literal('pocket'),
  id: z.string(),
  onZ: z.number(),
  shape: ShapeSchema,
  depth: z.number(),
  floorRadius: z.number(),
})
export const DrillingGeometrySchema = z.object({
  kind: z.literal('drilling'),
  id: z.string(),
  onZ: z.number(),
  center: Vec2Schema,
  diameter: z.number(),
  bottom: DrillBottomSchema,
})
export const ProfileGeometrySchema = z.object({
  kind: z.literal('profile'),
  id: z.string(),
  shape: ShapeSchema,
  side: z.enum(['outside', 'inside']),
  slotWidth: z.number(),
  tabs: z.object({ count: z.number(), width: z.number(), thickness: z.number() }),
})

export const OperationGeometrySchema: z.ZodType<OperationGeometry> = z.discriminatedUnion('kind', [
  FacingGeometrySchema,
  PocketGeometrySchema,
  DrillingGeometrySchema,
  ProfileGeometrySchema,
])

export const PartGeometryInputSchema: z.ZodType<PartGeometryInput> = z.object({
  stock: StockGeometrySchema,
  operations: z.array(OperationGeometrySchema).readonly(),
  references: z
    .array(z.object({ operation: z.string(), parameter: z.string(), surface: z.string() }))
    .readonly()
    .exactOptional(),
})

/** `DfmWarning` (model.ts); values in mm. Also the result schema of the design commands. */
export const DfmWarningSchema: z.ZodType<DfmWarning> = z
  .object({
    code: z.enum(DFM_WARNING_CODES),
    severity: z.enum(['warning', 'info']),
    message: z.string().describe('English, values in mm'),
    operation: z.string().describe('Id of the operation the warning is about'),
    parameter: z
      .string()
      .exactOptional()
      .describe('Its parameter to change, e.g. shape.cornerRadius'),
    params: z.record(
      z.string(),
      z.union([z.number(), z.string(), z.boolean(), z.array(z.string()).readonly()]),
    ),
    suggestion: z
      .object({ relation: z.enum(['atLeast', 'atMost']), value: z.number() })
      .exactOptional()
      .describe('Suggested value of the parameter (mm)'),
  })
  .describe('A DFM warning: never blocks, derived, never stored')

export const PartEvaluationSchema: z.ZodType<PartEvaluation> = z.object({
  positions: z.instanceof(Float32Array),
  indices: z.instanceof(Uint32Array),
  triangleSurface: z.instanceof(Uint32Array),
  surfaces: z.array(z.string()).readonly(),
  volume: z.number(),
  pieces: z.number(),
  warnings: z.array(DfmWarningSchema).readonly(),
  stats: z.object({ ms: z.number(), triangles: z.number() }),
})
