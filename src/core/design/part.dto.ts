/**
 * Persisted shape of a part, its operations and named shapes (record `parts/<id>.json`).
 * Shape only; constraints live in validate.ts and shape.ts. Doc: docs/modes/design.md#part-and-stock-v01,
 * docs/modes/design.md#operations-v01, docs/modes/design.md#implementation-task-25
 */
import { z } from 'zod'
import { ItemIdSchema, NAME_MAX, quantityDto } from '../library/item'
import { TOOL_TYPES } from '../library/tool.dto'
import { FeatureDtoSchema, FeatureIdSchema, FeatureRoleSchema } from './feature.dto'
import { ShapeDtoSchema, ShapeIdSchema, StoredShapeIdSchema } from './shape.dto'

const length = () => quantityDto('length')

/**
 * `facing1`, `pocket2`, `drill3`, `profile1`: kind prefix + number, immutable; an owned operation
 * of a feature (v0.4) is `<featureId>_<role>` (`hole1_drill`, `clones1_3_pocket2`,
 * docs/modes/features.md#expansion-and-owned-operations A3). Kept short: it is in many schemas.
 */
export const OPERATION_ID_PATTERN = /^[a-z][a-zA-Z]*[1-9]\d*(_\w+)*$/

// No description: the primer says once that pocket1's surfaces are pocket1.floor… (tools/list budget).
export const OperationIdSchema = z.string().regex(OPERATION_ID_PATTERN)

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

/** One coordinate of a placement anchor in the face frame (design-v0.2.md#placement-anchors). */
export const ANCHOR_POINTS = ['min', 'centre', 'max'] as const
export type AnchorPoint = (typeof ANCHOR_POINTS)[number]

/** Which of the nine points of the shape's bounding rectangle its `center` gives. */
export const AnchorDtoSchema = z.object({ u: z.enum(ANCHOR_POINTS), v: z.enum(ANCHOR_POINTS) })
export type AnchorDTO = z.output<typeof AnchorDtoSchema>

/**
 * The shape of a pocket or profile: an inline rectangle or circle, or (v0.3) a part's named shape
 * placed by the `named` kind (docs/modes/design-v0.3.md#placing-a-shape-on-a-face). `center` is
 * the anchor point of the placed (rotated, mirrored) bounding box; absent `anchor` = the centre
 * (v0.1 records load unchanged, and it is written only when it is not the centre). `rotation`
 * (counter-clockwise about the anchor point) and `mirror` are written only when set.
 */
export const OperationShapeDtoSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rectangle'),
    center: PointDtoSchema,
    anchor: AnchorDtoSchema.optional(),
    length: length().describe('Size along X'),
    width: length().describe('Size along Y'),
    cornerRadius: length(),
    // DF120: cornerRadius is half the narrowest side and follows size edits
    round: z.literal(true).optional(),
    rotation: quantityDto('angle').optional(),
  }),
  z.object({
    kind: z.literal('circle'),
    center: PointDtoSchema,
    anchor: AnchorDtoSchema.optional(),
    diameter: length(),
  }),
  z.object({
    kind: z.literal('named'),
    shapeId: StoredShapeIdSchema,
    center: PointDtoSchema,
    anchor: AnchorDtoSchema.optional(),
    rotation: quantityDto('angle').optional(),
    /** Flips the shape frame's x before rotating; absent = not mirrored. */
    mirror: z.literal(true).optional(),
  }),
])
export type OperationShapeDTO = z.output<typeof OperationShapeDtoSchema>

/** One symmetric `±` per kind; the value is the deviation (`0.1 mm` = ±0.1 mm). */
export const GeneralToleranceDtoSchema = z.object({
  length: length().optional(),
  angle: quantityDto('angle').optional(),
})
export type GeneralToleranceDTO = z.output<typeof GeneralToleranceDtoSchema>

/**
 * The operation's tool field (docs/modes/design-v0.2.md#data-model): a generalized tool (type and
 * diameter, no lengths) or a specific library tool held as a tool snapshot of the project.
 */
export const DesignToolDtoSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('generalized'),
    type: z.enum(TOOL_TYPES),
    diameter: length(),
    cornerRadius: length().optional().describe('Bull nose only'),
    angle: quantityDto('angle').optional().describe('Chamfer mill only: included angle'),
  }),
  z.object({ kind: z.literal('specific'), snapshotId: z.string().min(1) }),
])
export type DesignToolDTO = z.output<typeof DesignToolDtoSchema>

const common = {
  id: OperationIdSchema,
  name: z.string().min(1).max(NAME_MAX),
  generalTolerance: GeneralToleranceDtoSchema.optional(),
  /** Absent = auto, nothing chosen yet (v0.1 records); the next Apply chooses one. */
  tool: DesignToolDtoSchema.optional(),
  /** Set by any user choice of the tool; absent = auto. */
  toolLocked: z.literal(true).optional(),
  /** Owned operations of a feature (v0.4): both or neither (features.md#persistence-high-level). */
  featureId: FeatureIdSchema.optional(),
  featureRole: FeatureRoleSchema.optional(),
}

export const DRILL_BOTTOMS = ['through', 'flat', 'drillPoint'] as const
export type DrillBottomKind = (typeof DRILL_BOTTOMS)[number]
/** `on` (v0.3) cuts centred on the loop or open path (design-v0.3.md#cut-side-and-open-shapes). */
export const PROFILE_SIDES = ['outside', 'inside', 'on'] as const
export type ProfileSide = (typeof PROFILE_SIDES)[number]

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
  shape: OperationShapeDtoSchema,
  depth: length(),
  floorRadius: length(),
  /** Patterns P4: a through pocket (a pattern's `through`; since DF116 any pocket's). */
  through: z.literal(true).optional(),
  /** DF108: a pattern's roughing pocket (set by a pattern's `roughing` only). */
  roughing: z.literal(true).optional(),
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
  shape: OperationShapeDtoSchema,
  side: z.enum(PROFILE_SIDES),
  slotWidth: length(),
  /** A blind groove's or step's (DF53) depth below `on`; absent = through (as every v0.2 profile). */
  depth: length().optional(),
  tabs: z.object({
    count: quantityDto('scalar'),
    width: length(),
    thickness: length(),
    /** Distances along the loop from its start point; replace `count` when present (v0.3). */
    positions: z.array(length()).optional(),
  }),
})

/**
 * v0.4: a conical bevel at the mouth of an earlier circular drilling, pocket or inside profile (`edgeOf`). `on`
 * is always the edge operation's `on` (commands keep it so; it is stored so every reader sees
 * the face without the edge). docs/modes/design-v0.4.md#chamfer-operation-v04-circular-edges
 */
export const ChamferDtoSchema = z.object({
  kind: z.literal('chamfer'),
  ...common,
  on: SurfaceIdSchema,
  edgeOf: OperationIdSchema,
  /** The chamfer's width at the face (D45); diameter = edge Ø + 2 × width. */
  width: length(),
  angle: quantityDto('angle'),
  /** Present = stepped (v0.4 F7): terraces of at most this height by a flat end mill. */
  stepdown: length().optional(),
  /**
   * Written by a split only, on a piece's loop chamfer whose edge the split clipped
   * (edge-chamfers.md E2): the source's edge shape in the piece's face frame and the piece's
   * cell there (`min`, `max`). The bevel follows that shape within the cell, so the split line
   * and keys are never chamfered. Absent everywhere else.
   */
  sourceEdge: z
    .object({
      shape: OperationShapeDtoSchema,
      within: z.object({ min: PointDtoSchema, max: PointDtoSchema }),
    })
    .optional(),
  /**
   * A general edge's chosen loops (edge-chamfers.md E4a): indices into its loops, per piece the
   * outer loop then its islands; absent = every loop.
   */
  loops: z.array(z.number().int().nonnegative()).min(1).optional(),
  /** E4a: lift the V-bit into sharp inside corners (a mitre); absent = off. */
  cornerLift: z.literal(true).optional(),
})

/** The most placed shapes one Line takes (docs/modes/engraved-patterns.md#line-operation). */
export const LINE_PATHS_MAX = 50

/**
 * A named shape a Line places, as a pocket's `named` shape; E2: `scale` (absent = 1) about its
 * anchor point.
 */
export const LinePathDtoSchema = OperationShapeDtoSchema.options[2].extend({
  scale: z.number().positive().max(1000).optional(),
})

/**
 * A Line's depth below `on`: one length (constant), `{ start, end }` (linear along each line by
 * arc length) or, E2, `{ min, max }` (from the paths' levels: level 0 → `min`, 1 → `max`).
 */
export const LineDepthDtoSchema = z.union([
  length(),
  z.object({ start: length(), end: length() }),
  z.object({ min: length(), max: length() }),
])
export type LineDepthDTO = z.output<typeof LineDepthDtoSchema>

/**
 * A Line (engraved-patterns.md E1, E2): a groove along the centreline of every loop and open path
 * of its placed named shapes, at a depth that may change along the line. `blend` (E2, absent =
 * 1 mm): a level step is blended over ±`blend`.
 * Doc: docs/modes/engraved-patterns.md#line-operation
 */
export const LineDtoSchema = z.object({
  kind: z.literal('line'),
  ...common,
  on: SurfaceIdSchema,
  paths: z.array(LinePathDtoSchema).min(1).max(LINE_PATHS_MAX),
  depth: LineDepthDtoSchema,
  blend: length().optional(),
})

export const OperationDtoSchema = z.discriminatedUnion('kind', [
  FacingDtoSchema,
  PocketDtoSchema,
  DrillingDtoSchema,
  ProfileDtoSchema,
  ChamferDtoSchema,
  LineDtoSchema,
])
export type OperationDTO = z.output<typeof OperationDtoSchema>
export type OperationKind = OperationDTO['kind']

/** Part, plan, setup and plan operation ids: file-name safe. */
export const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

// No description: the primer says once that ids come from results (llm-api.md#schemas).
export const PartIdSchema = z.string().regex(RECORD_ID_PATTERN)

/** `split1`: one split per part (SP-D); generated operations are `<splitId>_<role>`. */
export const SPLIT_ID_PATTERN = /^split[1-9]\d{0,5}$/
export const SplitIdSchema = z.string().regex(SPLIT_ID_PATTERN)
/**
 * The lines' joint: butt (glue faces, no geometry), puzzle or dovetail key (split parts 4b-2,
 * docs/modes/split-parts.md#implementation-4b), finger or half lap (4d,
 * docs/modes/split-parts.md#implementation-4d).
 */
export const SPLIT_JOINTS = ['butt', 'puzzle', 'dovetail', 'finger', 'halfLap'] as const
export type SplitJoint = (typeof SPLIT_JOINTS)[number]

/**
 * A straight vertical split line through the whole part (4a): `axis` is the coordinate it fixes,
 * `{ axis: 'x', at: 125 }` is the plane x = 125 (it runs along Y).
 */
export const StraightSplitLineDtoSchema = z.object({ axis: z.enum(['x', 'y']), at: length() })
/**
 * A split line along an open named shape of the source part, read in the part frame's top view,
 * edge to edge (split parts 4e, docs/modes/split-parts.md#implementation-4e).
 */
export const ShapeSplitLineDtoSchema = z.object({ shape: ShapeIdSchema })
export const SplitLineDtoSchema = z.union([StraightSplitLineDtoSchema, ShapeSplitLineDtoSchema])
export type SplitLineDTO = z.output<typeof SplitLineDtoSchema>
export type StraightSplitLineDTO = z.output<typeof StraightSplitLineDtoSchema>
export const isShapeLine = (l: SplitLineDTO): l is z.output<typeof ShapeSplitLineDtoSchema> =>
  'shape' in l

/**
 * The split of a source part (docs/modes/split-parts.md#split): lines and levels (part-frame z,
 * between the stock bottom −T and the top 0) cut it into pieces; `margin` per side of each blank.
 */
/**
 * Dowels joining the levels (split parts 4b, docs/modes/split-parts.md#implementation-4b): the
 * dowel Ø (the hole is 0.2 mm larger, design/dowel.ts), each hole's depth in each piece, and the
 * holes: `level` indexes `split.levels` as stored, `at` is in the source part frame.
 */
export const SplitDowelsDtoSchema = z.object({
  diameter: length(),
  depth: length(),
  holes: z.array(z.object({ level: z.number().int().min(0), at: z.tuple([length(), length()]) })),
})
export type SplitDowelsDTO = z.output<typeof SplitDowelsDtoSchema>

export const SplitDtoSchema = z.object({
  id: SplitIdSchema,
  lines: z.array(SplitLineDtoSchema),
  levels: z.array(length()),
  margin: length(),
  /**
   * `kind`: the lines' joint; `clearance`: a key's socket offset (keys only, absent = 0.15 mm);
   * `dowels`: the levels' joint (absent = butt levels).
   */
  joint: z.object({
    kind: z.enum(SPLIT_JOINTS),
    clearance: length().optional(),
    dowels: SplitDowelsDtoSchema.optional(),
  }),
  /** Nest the pieces on library stocks (split parts 4c); absent = own blanks as in 4a. */
  useStocks: z.literal(true).optional(),
  /**
   * Pieces detached by their number (split parts 4d): plain parts now, no longer regenerated;
   * dropped when the lines or levels change. Absent = none.
   */
  detached: z.array(z.number().int().min(1)).optional(),
})
export type SplitDTO = z.output<typeof SplitDtoSchema>

/** A piece's source: the part, its split and the piece's number (1-based, by position). */
export const DerivedFromDtoSchema = z.object({
  partId: z.string().regex(RECORD_ID_PATTERN),
  splitId: SplitIdSchema,
  index: z.number().int().min(1),
})
export type DerivedFromDTO = z.output<typeof DerivedFromDtoSchema>

/**
 * A piece's blank (split parts 4c, docs/modes/split-parts.md#implementation-4c): the library
 * stock it is cut from (absent = own block), turned 90° about Z, and the user's choice (absent =
 * automatic), kept by the piece's number across regeneration.
 */
export const PieceBlankDtoSchema = z.object({
  libraryItemId: ItemIdSchema.optional(),
  rotation: z.literal(90).optional(),
  choice: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('own') }),
      z.object({ kind: z.literal('library'), libraryItemId: ItemIdSchema }),
    ])
    .optional(),
})
export type PieceBlankDTO = z.output<typeof PieceBlankDtoSchema>

export const PartDtoSchema = z.object({
  id: PartIdSchema,
  name: z.string().min(1).max(NAME_MAX),
  stock: z.string().min(1).describe('Id of the block stock snapshot (snapshots/<id>.json)'),
  generalTolerance: GeneralToleranceDtoSchema.optional(),
  /** Named shapes (v0.3, docs/modes/design-v0.3.md#persistence); absent = none. */
  shapes: z.array(ShapeDtoSchema).optional().describe('Named shapes operations place'),
  /** Features (v0.4, docs/modes/features.md#persistence-high-level); absent = none. */
  features: z.array(FeatureDtoSchema).optional().describe('Features owning operations'),
  /**
   * Operations and features the user switched off (hardening DF106,
   * docs/modes/design.md#disabling-operations-and-features-df106): top-level ids in design order;
   * absent = none. Their dependants are off too (design/disabled.ts, derived, never stored).
   */
  disabled: z
    .array(OperationIdSchema)
    .optional()
    .describe('Switched-off operation and feature ids'),
  operations: z.array(OperationDtoSchema).describe('Design order; references go to earlier ones'),
  /** Split parts 4a (docs/modes/split-parts.md#model): on a source part; absent = not split. */
  split: SplitDtoSchema.optional(),
  /** On a piece: its source. A piece is derived, regenerated from the source, read-only. */
  derivedFrom: DerivedFromDtoSchema.optional(),
  /** On a piece: source part frame + offset = piece frame (mm). */
  offset: z.tuple([length(), length(), length()]).optional(),
  /** On a piece: where its blank comes from (split parts 4c); absent = own block, automatic. */
  blank: PieceBlankDtoSchema.optional(),
})
export type PartDTO = z.output<typeof PartDtoSchema>
