/**
 * Zod schemas of the toolpath data that crosses a worker boundary: the generator inputs
 * (checked in the worker) and `Toolpath` (checked in the host, and the result of
 * `plan.toolpath.get`). Typed against the interfaces in `model.ts` so they cannot drift apart.
 * Doc: docs/architecture/workers.md#zod-at-the-boundary
 */
import { z } from 'zod'
import {
  ChamferGeometrySchema,
  LoopChamferGeometrySchema,
  LineGeometrySchema,
  DrillingGeometrySchema,
  FacingGeometrySchema,
  AnalyticPocketGeometrySchema,
  AnalyticProfileGeometrySchema,
  LoopSchema,
  RegionSchema,
  StockGeometrySchema,
  Vec2Schema,
  Vec3Schema,
} from '../geometry/schemas'
import type {
  ChamferInput,
  DrillingInput,
  FacingInput,
  Move,
  PocketInput,
  ProfileInput,
  Toolpath,
  ToolpathTool,
} from './model'
import type { EdgeChamferInput } from './edge-chamfer'
import type { MarkInput } from './mark'
import type { LineInput } from './line'
import type { RegionPocketInput } from './region-pocket'
import type { RegionProfileInput } from './region-profile'

const MoveSchema: z.ZodType<Move> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rapid'), to: Vec3Schema }),
  z.object({ kind: z.literal('line'), to: Vec3Schema, feed: z.number() }),
  z.object({
    kind: z.literal('arc'),
    to: Vec3Schema,
    center: Vec2Schema,
    cw: z.boolean(),
    feed: z.number(),
  }),
  z.object({
    kind: z.literal('drill'),
    at: Vec2Schema,
    top: z.number(),
    bottom: z.number(),
    cycle: z.enum(['simple', 'peck', 'chipBreak']),
    peck: z.number().exactOptional(),
    back: z.number().exactOptional(),
    retract: z.number(),
    feed: z.number(),
  }),
])

export const ToolpathStatsSchema = z.object({
  cutLength: z.number(),
  rapidLength: z.number(),
  estimatedSeconds: z.number(),
})

const PassSchema = z.object({
  kind: z.enum(['rough', 'finish', 'drill']),
  moves: z.array(MoveSchema).readonly(),
  operationId: z.string().exactOptional(),
})

/** Full check of every move. */
export const ToolpathSchema: z.ZodType<Toolpath> = z
  .object({
    planOperationId: z.string(),
    tool: z.string().describe('Tool snapshot id'),
    spindleSpeed: z.number().describe('rpm'),
    passes: z.array(PassSchema).readonly(),
    stats: ToolpathStatsSchema,
  })
  .describe('Toolpath of one plan operation: float64 mm in the setup WCS, feeds in mm/min')

/**
 * Envelope plus spot checks: every field but the moves, and the first and last move of each
 * pass (docs/architecture/workers.md#zod-at-the-boundary; used if the full check exceeds 5 ms).
 */
export const ToolpathSpotSchema: z.ZodType<Toolpath> = z.object({
  planOperationId: z.string(),
  tool: z.string(),
  spindleSpeed: z.number(),
  passes: z
    .array(
      z.object({
        kind: z.enum(['rough', 'finish', 'drill']),
        moves: z
          .array(z.unknown())
          .readonly()
          .superRefine((moves, ctx) => {
            for (const i of moves.length === 0 ? [] : [0, moves.length - 1]) {
              const r = MoveSchema.safeParse(moves[i])
              if (!r.success) ctx.addIssue({ code: 'custom', path: [i], message: 'malformed move' })
            }
          }) as unknown as z.ZodType<readonly Move[]>,
        operationId: z.string().exactOptional(),
      }),
    )
    .readonly(),
  stats: ToolpathStatsSchema,
})

export const ToolpathToolSchema: z.ZodType<ToolpathTool> = z.object({
  id: z.string(),
  type: z.enum(['flatEndMill', 'bullNoseEndMill', 'ballEndMill', 'drill', 'chamferMill']),
  diameter: z.number(),
  cornerRadius: z.number(),
  fluteLength: z.number(),
  pointAngle: z.number().exactOptional(),
  angle: z.number().exactOptional(),
  tipDiameter: z.number().exactOptional(),
})

const CuttingSchema = z.object({
  spindleSpeed: z.number(),
  feedRate: z.number(),
  plungeRate: z.number(),
  stepdown: z.number(),
  stepover: z.number(),
  finishFeedRate: z.number().exactOptional(),
})
const DrillCuttingSchema = CuttingSchema.pick({
  spindleSpeed: true,
  feedRate: true,
  plungeRate: true,
})
const Direction = z.enum(['climb', 'conventional'])

const base = {
  planOperationId: z.string(),
  tool: ToolpathToolSchema,
  heights: z.object({ clearanceHeight: z.number(), retractHeight: z.number() }),
  stock: StockGeometrySchema,
  maxFeedRate: Vec3Schema.exactOptional(),
  material: z
    .object({ top: z.number().exactOptional(), bottom: z.number().exactOptional() })
    .exactOptional(),
}

export const FacingInputSchema: z.ZodType<FacingInput> = z.object({
  ...base,
  cutting: CuttingSchema,
  operation: FacingGeometrySchema,
  strategy: z.object({
    pattern: z.enum(['zigzag', 'oneWay']),
    axis: z.enum(['x', 'y']),
    overshoot: z.number(),
    direction: Direction,
  }),
})

const PocketStrategySchema = z.object({
  entry: z.enum(['helix', 'ramp', 'plunge']),
  helixDiameter: z.number(),
  rampAngle: z.number(),
  finishAllowance: z.number(),
  finishStepdown: z.number(),
  direction: Direction,
})

export const PocketInputSchema: z.ZodType<PocketInput> = z.object({
  ...base,
  cutting: CuttingSchema,
  operation: AnalyticPocketGeometrySchema,
  strategy: PocketStrategySchema,
})

/** A pocket of a general region (v0.3 T1): the region placed in the face frame. */
export const RegionPocketInputSchema: z.ZodType<RegionPocketInput> = z.object({
  ...base,
  cutting: CuttingSchema,
  operation: z.object({
    region: RegionSchema,
    onZ: z.number(),
    depth: z.number(),
    // DF108/DF122: a roughing pocket; rest machining after it
    roughing: z.literal(true).optional(),
    restAfter: z
      .object({
        radius: z.number(),
        cornerRadius: z.number(),
        wall: z.number(),
        floorDepth: z.number(),
      })
      .optional(),
  }),
  strategy: PocketStrategySchema,
})

export const DrillingInputSchema: z.ZodType<DrillingInput> = z.object({
  ...base,
  cutting: DrillCuttingSchema,
  operation: DrillingGeometrySchema,
  strategy: z.discriminatedUnion('cycle', [
    z.object({ cycle: z.literal('simple'), breakthrough: z.number() }),
    z.object({ cycle: z.literal('peck'), breakthrough: z.number(), peckDepth: z.number() }),
    z.object({
      cycle: z.literal('chipBreak'),
      breakthrough: z.number(),
      peckDepth: z.number(),
      chipBreakBack: z.number(),
    }),
    z.object({
      cycle: z.literal('helix'),
      breakthrough: z.number(),
      helixPitch: z.number(),
      rampAngle: z.number(),
      direction: Direction,
    }),
  ]),
})

const ProfileStrategySchema = z.object({
  entry: z.enum(['ramp', 'plunge']),
  rampAngle: z.number(),
  breakthrough: z.number(),
  finishAllowance: z.number(),
  finishStepdown: z.number().exactOptional(),
  direction: Direction,
})

export const ProfileInputSchema: z.ZodType<ProfileInput> = z.object({
  ...base,
  cutting: CuttingSchema,
  operation: AnalyticProfileGeometrySchema,
  strategy: ProfileStrategySchema,
})

/** A profile of a general loop or open path (v0.3 T2), placed in the face frame. */
export const RegionProfileInputSchema: z.ZodType<RegionProfileInput> = z.object({
  ...base,
  cutting: CuttingSchema,
  operation: z.object({
    chain: LoopSchema,
    closed: z.boolean(),
    side: z.enum(['outside', 'inside', 'on']),
    slotWidth: z.number(),
    onZ: z.number(),
    depth: z.number(),
    through: z.boolean(),
    tabs: z.object({
      positions: z.array(z.number()).readonly(),
      width: z.number(),
      thickness: z.number(),
    }),
    // DF122 R4: a roughing profile; rest machining after it
    roughing: z.literal(true).optional(),
    restAfter: z
      .object({
        radius: z.number(),
        cornerRadius: z.number(),
        wall: z.number(),
        floorDepth: z.number(),
        slotWidth: z.number(),
      })
      .optional(),
  }),
  strategy: ProfileStrategySchema.extend({ leadRadius: z.number() }),
})

/** A circular chamfer (v0.4 T1), placed in the face frame; `entry` resolved by the plan. */
export const ChamferInputSchema: z.ZodType<ChamferInput> = z.object({
  ...base,
  cutting: DrillCuttingSchema,
  operation: ChamferGeometrySchema.omit({ direction: true }),
  strategy: z.object({
    entry: z.enum(['plunge', 'contour', 'stepped']),
    rampAngle: z.number(),
    direction: Direction,
  }),
})

/** An edge chamfer along a general edge (E1), placed in the face frame. */
export const EdgeChamferInputSchema: z.ZodType<EdgeChamferInput> = z.object({
  ...base,
  cutting: DrillCuttingSchema,
  operation: LoopChamferGeometrySchema.omit({ direction: true }),
  strategy: z.object({ direction: Direction }),
})

/** A Line (engraved-patterns.md E1), in the face frame; `entry`/`rampAngle` resolved by the plan. */
export const LineInputSchema: z.ZodType<LineInput> = z.object({
  ...base,
  cutting: CuttingSchema.pick({
    spindleSpeed: true,
    feedRate: true,
    plungeRate: true,
    stepdown: true,
  }),
  operation: LineGeometrySchema.omit({ direction: true }),
  strategy: z.object({ entry: z.enum(['ramp', 'plunge']), rampAngle: z.number() }),
})

/** A witness mark (alignment aid, S14): a spot (`from` = `to`) or a line at `depth`, face frame. */
export const MarkInputSchema: z.ZodType<MarkInput> = z.object({
  ...base,
  cutting: DrillCuttingSchema,
  operation: z.object({ id: z.string(), from: Vec2Schema, to: Vec2Schema, depth: z.number() }),
  strategy: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
})
