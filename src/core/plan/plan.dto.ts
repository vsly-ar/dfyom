/**
 * Persisted shape of a plan (record `plans/<id>.json`): status, design snapshot, own library
 * copies, setups and plan operations. Shape only; rules live in the plan module.
 * Doc: docs/modes/plan-v0.1.md#plan-record, docs/modes/plan-v0.1.md#plans-are-snapshots
 */
import { z } from 'zod'
import { PartDtoSchema, PartIdSchema, OperationIdSchema } from '../design/part.dto'
import { NAME_MAX, quantityDto } from '../library/item'
import { SnapshotDtoSchema } from '../library/snapshot'
import { PRESET_NAME_MAX } from '../library/tool.dto'
import type { Quantity } from '../quantity/quantity'
import type { QuantityDTO } from '../quantity/quantity.dto'

export type LengthDTO = QuantityDTO & { kind: 'length' }

/** DTO of a length quantity (the kind is a model invariant, so the narrow type holds). */
export const lengthDTO = (q: Quantity): LengthDTO => q.toDTO() as LengthDTO

const length = () => quantityDto('length')

/** Plan ids, setup ids and plan operation ids are file-name safe like part ids. */
export const PlanIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/)
  .describe('Plan id')
export const PlanRecordIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

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
    entry: z.enum(POCKET_ENTRIES).optional(),
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

export const PlanOperationDtoSchema = z.object({
  id: PlanRecordIdSchema.describe('Plan operation id'),
  designOperationIds: z
    .array(OperationIdSchema)
    .min(1)
    .describe('Operations of the design snapshot it machines (drillings may share one)'),
  tool: z.string().min(1).optional().describe("Id of the tool copy in the plan's snapshots"),
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
})
export type PlanOperationDTO = z.output<typeof PlanOperationDtoSchema>

export const SetupDtoSchema = z.object({
  id: PlanRecordIdSchema,
  name: z.string().min(1).max(NAME_MAX),
  workOffset: z.literal('G54').describe('Work coordinate system (v0.1: G54 only)'),
  clearanceHeight: length().describe('Up from the stock top'),
  retractHeight: length().describe("Up from the operation's `on` surface"),
  operations: z.array(PlanOperationDtoSchema).describe('Machining order'),
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
  setups: z.array(SetupDtoSchema).min(1).max(1).describe('v0.1: one setup'),
})
export type PlanDTO = z.output<typeof PlanDtoSchema>
