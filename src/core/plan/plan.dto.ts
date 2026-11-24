/**
 * Persisted shape of a plan (record `plans/<id>.json`): status, design snapshot, own library
 * copies, setups and plan operations. Shape only; rules live in the plan module.
 * Doc: docs/modes/plan-v0.1.md#plan-record, docs/modes/plan-v0.1.md#plans-are-snapshots
 */
import { z } from 'zod'
import {
  PartDtoSchema,
  PartIdSchema,
  OperationIdSchema,
  RECORD_ID_PATTERN,
} from '../design/part.dto'
import { DIRECTIONS as FACE_DIRECTIONS } from '../geometry/face'
import { NAME_MAX, quantityDto } from '../library/item'
import { SnapshotDtoSchema } from '../library/snapshot'
import { ALIGNMENT_POINTS_MAX, AlignmentPointDtoSchema, SetupZeroDtoSchema } from './alignment.dto'
import { PRESET_NAME_MAX } from '../library/tool.dto'
import type { Quantity } from '../quantity/quantity'
import type { QuantityDTO } from '../quantity/quantity.dto'
import { WorkholdingItemDtoSchema } from './workholding/items'

export type LengthDTO = QuantityDTO & { kind: 'length' }

/** DTO of a length quantity (the kind is a model invariant, so the narrow type holds). */
export const lengthDTO = (q: Quantity): LengthDTO => q.toDTO() as LengthDTO

const length = () => quantityDto('length')

/** Plan ids, setup ids and plan operation ids are file-name safe like part ids. */
export const PlanIdSchema = z.string().regex(RECORD_ID_PATTERN).describe('Plan id')
export const PlanRecordIdSchema = z.string().regex(RECORD_ID_PATTERN)

/** docs/modes/plan-v0.1.md#plan-status */
export const PLAN_STATUSES = ['draft', 'settledDesign', 'finalized', 'inUse', 'archived'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]
export const PlanStatusSchema = z.enum(PLAN_STATUSES).describe('Plan status')

/**
 * The plan's copy of one part. `taken` is the part as copied from the design (its `hash` is the
 * hash of `taken`); `part` is the plan's version, which differs only by plan-only edits
 * (`plan.design.operation.update`), so `editedInPlan` is derived by comparing the two.
 * `part.stock` is the id of the stock copy in the plan's `snapshots`.
 */
export const DesignSnapshotDtoSchema = z.object({
  partId: PartIdSchema,
  takenAt: z.iso.datetime({ offset: true }).describe('When the design was copied'),
  hash: z.string().min(1).describe('Hash of `taken` (stable JSON)'),
  taken: PartDtoSchema.describe('The part as copied from the design'),
  part: PartDtoSchema.describe("The plan's version of the part (plan-only edits applied)"),
})
export type DesignSnapshotDTO = z.output<typeof DesignSnapshotDtoSchema>

/** The five feeds-and-speeds fields (docs/modes/plan-v0.1.md#feeds-and-speeds). */
export const FEED_FIELDS = [
  'spindleSpeed',
  'feedRate',
  'plungeRate',
  'stepdown',
  'stepover',
] as const
export type FeedField = (typeof FEED_FIELDS)[number]

export const OverridesDtoSchema = z
  .object({
    spindleSpeed: quantityDto('spindleSpeed').optional(),
    feedRate: quantityDto('feedRate').optional(),
    plungeRate: quantityDto('feedRate').optional(),
    stepdown: length().optional(),
    stepover: length().optional(),
  })
  .describe(
    'Per-operation feeds-and-speeds values entered by the user; they win over preset and calculator',
  )
export type OverridesDTO = z.output<typeof OverridesDtoSchema>

export const DIRECTIONS = ['climb', 'conventional'] as const
export const FACING_PATTERNS = ['zigzag', 'oneWay'] as const
export const FACING_AXES = ['x', 'y'] as const
export const POCKET_ENTRIES = ['helix', 'ramp', 'plunge'] as const
export const PROFILE_ENTRIES = ['ramp', 'plunge'] as const
/** Chamfer (v0.4 T1); absent = auto (plunge when DC covers the chamfer, else contour). */
export const CHAMFER_ENTRIES = ['plunge', 'contour'] as const
/** Every stored `entry` value; which ones a kind takes is checked in strategy.ts. */
export const ENTRIES = ['helix', 'ramp', 'plunge', 'contour'] as const
export const DRILL_CYCLES = ['simple', 'peck', 'chipBreak', 'helix'] as const

/**
 * The strategy parameters the user set (sparse: an omitted one takes its default when the plan
 * is evaluated, docs/modes/plan-v0.1.md#pass-strategies-v01). Which keys a kind accepts is in
 * strategy.ts. `stepover`/`stepdown` are feeds fields (`overrides`), not strategy parameters.
 */
export const StrategyDtoSchema = z
  .object({
    direction: z.enum(DIRECTIONS).optional(),
    pattern: z.enum(FACING_PATTERNS).optional(),
    axis: z.enum(FACING_AXES).optional(),
    overshoot: length().optional(),
    entry: z.enum(ENTRIES).optional(),
    helixDiameter: length().optional(),
    rampAngle: quantityDto('angle').optional(),
    finishAllowance: length().optional(),
    finishStepdown: length().optional(),
    cycle: z.enum(DRILL_CYCLES).optional(),
    peckDepth: length().optional(),
    chipBreakBack: length().optional(),
    helixPitch: length().optional(),
    breakthrough: length().optional(),
  })
  .describe('Pass strategy parameters set for this operation; omitted ones take defaults')
export type StrategyDTO = z.output<typeof StrategyDtoSchema>

/**
 * Where a plan operation's tool comes from (docs/modes/plan-v0.2.md#tool-resolution-from-the-design-tool-field):
 * absent on records taken before task E4, treated as `plan` (never swapped by a rebuild).
 */
export const TOOL_SOURCES = ['design', 'plan'] as const
export type ToolSource = (typeof TOOL_SOURCES)[number]

/**
 * The Z reference surface and touch-off spot the user chose for the tool run an operation starts
 * (hardening DF69, docs/modes/z-reference.md#agent-api-compact): `surface` absent = the default
 * surface with a chosen spot; `at` absent = the surface's default spot.
 */
export const ZRefDtoSchema = z.object({
  surface: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Surface id: the setup's stock face (stock.top) or <operation id>.floor"),
  at: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe('Touch-off spot X, Y in the setup WCS (mm)'),
})
export type ZRefDTO = z.output<typeof ZRefDtoSchema>

export const PlanOperationDtoSchema = z.object({
  id: PlanRecordIdSchema.describe('Plan operation id'),
  designOperationIds: z
    .array(OperationIdSchema)
    .min(1)
    .describe('Operations of the design snapshot it machines (drillings may share one)'),
  tool: z.string().min(1).optional().describe("Id of the tool copy in the plan's snapshots"),
  toolSource: z
    .enum(TOOL_SOURCES)
    .optional()
    .describe(
      'design: resolved from the design tool field (re-resolved when it changes); plan: plan.tool.assign (kept)',
    ),
  designToolChanged: z
    .literal(true)
    .optional()
    .describe("A rebuild kept this plan-assigned tool although the design's tool field changed"),
  stickout: length().optional().describe("Default: the tool's stickout, else its flute length"),
  presetName: z.string().min(1).max(PRESET_NAME_MAX).optional().describe('Default: by material'),
  auto: z
    .literal(true)
    .optional()
    .describe('Auto mode chosen: feeds from the calculator (excludes presetName)'),
  locked: z
    .array(z.enum(FEED_FIELDS))
    .optional()
    .describe('Locked feeds fields (auto mode only): the other recommendations follow them'),
  overrides: OverridesDtoSchema,
  strategy: StrategyDtoSchema,
  zRef: ZRefDtoSchema.optional().describe(
    'Z reference of the tool run this operation starts; absent = the default rule',
  ),
})
export type PlanOperationDTO = z.output<typeof PlanOperationDtoSchema>

/** Setup rotations about the spindle axis, degrees (docs/modes/plan-v0.2.md#setups-from-face-directions). */
export const SETUP_ROTATIONS = [0, 90, 180, 270] as const
export type SetupRotation = (typeof SETUP_ROTATIONS)[number]

/**
 * One setup (v0.2: one per approach direction, docs/modes/plan-v0.2.md#setups-from-face-directions).
 * `direction` and `rotation` are omitted for `+z` and 0° (v0.1 records stay valid unchanged).
 */
export const SetupDtoSchema = z.object({
  id: PlanRecordIdSchema,
  name: z.string().min(1).max(NAME_MAX),
  direction: z
    .enum(FACE_DIRECTIONS)
    .optional()
    .describe('Part direction pointing up to the spindle; absent = +z'),
  rotation: z
    .literal(SETUP_ROTATIONS)
    .optional()
    .describe('Degrees about the spindle axis; absent = 0'),
  workOffset: z.literal('G54').describe('Work coordinate system (v0.1: G54 only)'),
  clearanceHeight: length().describe('Up from the stock top'),
  clearanceHeightSet: z
    .literal(true)
    .optional()
    .describe(
      'The user set the clearance height: it stays as entered; absent = at least the top of the workholding + margin (docs/modes/workholding.md#links-and-safe-heights)',
    ),
  retractHeight: length().describe("Up from the operation's `on` surface"),
  workholding: z
    .array(WorkholdingItemDtoSchema)
    .optional()
    .describe(
      'What holds the stock in this setup (docs/modes/workholding.md#model); absent = none',
    ),
  workholdingMargin: length()
    .optional()
    .describe('Kept around every workholding item, sideways and above; absent = 2 mm / 0.08"'),
  operations: z.array(PlanOperationDtoSchema).describe('Machining order'),
  // alignment phase 1 (DF78): docs/modes/alignment.md#setup-work-zero-q61
  zero: SetupZeroDtoSchema.optional().describe(
    'Work zero X/Y; absent = front-left corner of the top',
  ),
  alignment: z
    .array(AlignmentPointDtoSchema)
    .max(ALIGNMENT_POINTS_MAX)
    .optional()
    .describe('Alignment points in cycle order (after the zero)'),
})
export type SetupDTO = z.output<typeof SetupDtoSchema>

export const PlanDtoSchema = z.object({
  id: PlanIdSchema,
  name: z.string().min(1).max(NAME_MAX),
  status: PlanStatusSchema,
  statusBeforeArchive: PlanStatusSchema.exclude(['archived'])
    .optional()
    .describe('Set while archived; un-archiving restores it'),
  design: DesignSnapshotDtoSchema,
  snapshots: z
    .array(SnapshotDtoSchema)
    .describe("The plan's own library copies: stock, machine, tools"),
  machine: z.string().min(1).optional().describe("Id of the machine copy in the plan's snapshots"),
  setups: z.array(SetupDtoSchema).min(1).describe('Setups in machining order'),
})
export type PlanDTO = z.output<typeof PlanDtoSchema>
