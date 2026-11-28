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
import { DIRECTIONS } from './face'
import type { Element, Loop, Region } from './2d/model'
import {
  DFM_WARNING_CODES,
  type DfmWarning,
  type OperationGeometry,
  type PartGeometryInput,
  type StockGeometry,
} from './model'

export const Vec2Schema = z.tuple([z.number(), z.number()]).readonly()
export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]).readonly()

/** 2D elements, loops and regions (src/core/geometry/2d/model.ts) for v0.3 shape contours. */
const ElementSchema: z.ZodType<Element> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('line'), a: Vec2Schema, b: Vec2Schema }),
  z.object({
    kind: z.literal('arc'),
    a: Vec2Schema,
    b: Vec2Schema,
    centre: Vec2Schema,
    ccw: z.boolean(),
  }),
])
export const LoopSchema: z.ZodType<Loop> = z.object({ elements: z.array(ElementSchema).readonly() })
export const RegionSchema: z.ZodType<Region> = z.object({
  pieces: z
    .array(z.object({ outer: LoopSchema, holes: z.array(LoopSchema).readonly() }))
    .readonly(),
})

const ContourSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rectangle'),
    length: z.number(),
    width: z.number(),
    cornerRadius: z.number(),
  }),
  z.object({ kind: z.literal('circle'), radius: z.number() }),
  z.object({ kind: z.literal('region'), region: RegionSchema }),
  z.object({ kind: z.literal('path'), path: LoopSchema }),
])

const ShapeSchema = z.object({ center: Vec2Schema, contour: ContourSchema })
/** v0.1 contours only: what the v0.1 pocket and profile generators take. */
const AnalyticShapeSchema = z.object({
  center: Vec2Schema,
  contour: z.discriminatedUnion('kind', [ContourSchema.options[0], ContourSchema.options[1]]),
})

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

const direction = z.enum(DIRECTIONS).exactOptional()

export const FacingGeometrySchema = z.object({
  kind: z.literal('facing'),
  id: z.string(),
  direction,
  depth: z.number(),
})
export const PocketGeometrySchema = z.object({
  kind: z.literal('pocket'),
  id: z.string(),
  direction,
  onZ: z.number(),
  shape: ShapeSchema,
  depth: z.number(),
  floorRadius: z.number(),
  through: z.literal(true).exactOptional(),
  throughDepth: z.number().exactOptional(),
})
export const DrillingGeometrySchema = z.object({
  kind: z.literal('drilling'),
  id: z.string(),
  direction,
  onZ: z.number(),
  center: Vec2Schema,
  diameter: z.number(),
  bottom: DrillBottomSchema,
  throughDepth: z.number().exactOptional(),
})
export const ProfileGeometrySchema = z.object({
  kind: z.literal('profile'),
  id: z.string(),
  direction,
  shape: ShapeSchema,
  side: z.enum(['outside', 'inside', 'on']),
  slotWidth: z.number(),
  depth: z.number().exactOptional(),
  throughDepth: z.number().exactOptional(),
  tabs: z.object({
    count: z.number(),
    width: z.number(),
    thickness: z.number(),
    positions: z.array(z.number()).readonly().exactOptional(),
  }),
})

/** The generator input of `generatePocket` (v0.1 contours). */
export const AnalyticPocketGeometrySchema = PocketGeometrySchema.extend({
  shape: AnalyticShapeSchema,
})
/** The generator input of `generateProfile` (v0.1 contours, outside / inside through). */
export const AnalyticProfileGeometrySchema = ProfileGeometrySchema.omit({ depth: true }).extend({
  shape: AnalyticShapeSchema,
  side: z.enum(['outside', 'inside']),
  tabs: z.object({ count: z.number(), width: z.number(), thickness: z.number() }),
})

export const ChamferGeometrySchema = z.object({
  kind: z.literal('chamfer'),
  id: z.string(),
  direction,
  onZ: z.number(),
  center: Vec2Schema,
  edgeOf: z.string(),
  edgeDiameter: z.number(),
  diameter: z.number(),
  angle: z.number(),
  stepdown: z.number().exactOptional(),
  edgeCore: z.literal(true).exactOptional(),
})

/** Edge chamfer (E1, E2): a bevel along a general edge (docs/modes/edge-chamfers.md#implementation-e1). */
export const LoopChamferGeometrySchema = z.object({
  kind: z.literal('chamfer'),
  id: z.string(),
  direction,
  onZ: z.number(),
  edgeOf: z.string(),
  edge: z.object({
    shape: ShapeSchema,
    side: z.enum(['inside', 'outside']),
    depth: z.number().exactOptional(),
    within: z.object({ min: Vec2Schema, max: Vec2Schema }).exactOptional(),
    loops: z.array(z.number().int().nonnegative()).readonly().exactOptional(),
    tabs: z
      .array(z.object({ at: Vec2Schema, width: z.number() }))
      .readonly()
      .exactOptional(),
    pattern: z.literal(true).exactOptional(),
  }),
  width: z.number(),
  angle: z.number(),
  cornerLift: z.literal(true).exactOptional(),
})

/** Line (engraved-patterns.md E1): docs/modes/engraved-patterns.md#implementation-e1. */
export const LineGeometrySchema = z.object({
  kind: z.literal('line'),
  id: z.string(),
  direction,
  onZ: z.number(),
  paths: z.array(ShapeSchema).readonly(),
  depth: z.union([
    z.object({ start: z.number(), end: z.number() }),
    z.object({ min: z.number(), max: z.number() }),
  ]),
  levels: z
    .array(
      z
        .discriminatedUnion('kind', [
          z.object({
            kind: z.literal('path'),
            u: z.array(z.number()).readonly(),
            level: z.array(z.number()).readonly(),
          }),
          z.object({ kind: z.literal('loops'), level: z.number() }),
        ])
        .nullable(),
    )
    .readonly()
    .exactOptional(),
  blend: z.number().exactOptional(),
  cutter: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('vBit'),
      diameter: z.number(),
      angle: z.number(),
      tipDiameter: z.number(),
    }),
    z.object({
      kind: z.literal('taperedBall'),
      diameter: z.number(),
      tipDiameter: z.number(),
      taperAngle: z.number(),
    }),
    z.object({ kind: z.literal('ball'), diameter: z.number() }),
    z.object({ kind: z.literal('flat'), diameter: z.number() }),
  ]),
  through: z.literal(true).exactOptional(),
})

// two chamfer shapes share `kind`: the circular one first (it needs `center`), then the loop one
export const OperationGeometrySchema: z.ZodType<OperationGeometry> = z.union([
  z.discriminatedUnion('kind', [
    FacingGeometrySchema,
    PocketGeometrySchema,
    DrillingGeometrySchema,
    ProfileGeometrySchema,
    ChamferGeometrySchema,
    LineGeometrySchema,
  ]),
  LoopChamferGeometrySchema,
])

export const PartGeometryInputSchema: z.ZodType<PartGeometryInput> = z.object({
  stock: StockGeometrySchema,
  operations: z.array(OperationGeometrySchema).readonly(),
  references: z
    .array(z.object({ operation: z.string(), parameter: z.string(), surface: z.string() }))
    .readonly()
    .exactOptional(),
  dependants: z.record(z.string(), z.array(z.string()).readonly()).readonly().exactOptional(),
  cloneGroups: z.array(z.array(z.string()).readonly()).readonly().exactOptional(),
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
      z.union([
        z.number(),
        z.string(),
        z.boolean(),
        z.array(z.string()).readonly(),
        z.array(z.number()).readonly(),
      ]),
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
  construction: z
    .array(
      z.object({
        surface: z.string(),
        consumedBy: z.array(z.string()).readonly(),
        referencedBy: z
          .array(z.object({ operationId: z.string(), param: z.string() }).readonly())
          .readonly(),
        patch: z.object({
          direction: z.enum(DIRECTIONS),
          z: z.number(),
          loops: z
            .array(z.array(z.tuple([z.number(), z.number()]).readonly()).readonly())
            .readonly(),
        }),
      }),
    )
    .readonly(),
  stats: z.object({ ms: z.number(), triangles: z.number() }),
})
