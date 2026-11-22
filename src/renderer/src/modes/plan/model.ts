// Plan mode's view of the document and of the plan queries (task 3.7), pure: which plans the
// picker shows, a plan operation's name, the statuses a plan may go to, a resolved feeds value as
// a quantity in the project units, what is stale, and each plan operation's toolpath state.
// Commands do the checking; this only builds what the UI shows and sends.
// Doc: docs/modes/plan-v0.1.md#commands-and-queries-v01, docs/conventions/ui.md#plan-mode-task-37
import type { OperationKind } from '../../../../core/design/part.dto'
import { SurfaceTable } from '../../../../core/design/surfaces'
import { loadPlanDTO } from '../../../../core/plan/plan'
import { sameValue } from '../../../../core/plan/validity'
import type { PlanWarning } from '../../../../core/plan/checks'
import type { FeedField, PlanDTO, PlanStatus } from '../../../../core/plan/plan.dto'
import { STRATEGY_KEYS, type StrategyKey } from '../../../../core/plan/strategy'
import { ALLOWED, TRANSITIONS } from '../../../../core/plan/status'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import { Quantity } from '../../../../core/quantity/quantity'
import type { QuantityKind, UnitId } from '../../../../core/quantity/units'
import type { Toolpath } from '../../../../core/toolpath/model'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { FeedSource, ToolpathState } from '../../messages/plan'
import type { DesignPart } from '../design/model'

/** Plans the picker offers: every plan of the project, archived ones last. */
export function pickerPlans(doc: ProjectDoc): PlanDTO[] {
  const all = Object.values(doc.plans)
  return [
    ...all.filter((p) => p.status !== 'archived'),
    ...all.filter((p) => p.status === 'archived'),
  ]
}

/** The plan the window shows: the chosen one if it still exists, else the first offered. */
export function chosenPlan(doc: ProjectDoc, planId: string | undefined): PlanDTO | undefined {
  const plans = pickerPlans(doc)
  return plans.find((p) => p.id === planId) ?? plans[0]
}

/** Whether a plan command is allowed in the plan's status (plan-v0.1.md#plan-status). */
export const allows = (plan: PlanDTO, command: string): boolean =>
  ALLOWED[command]?.includes(plan.status) ?? false

/** Plan edits (tool, feeds, setup, order) are allowed in draft and settled design only. */
export const editable = (plan: PlanDTO): boolean => allows(plan, 'plan.operation.update')

// ── the plan's part (plan copy, snapshot scene) ───────────────────────────────────────────

const partCache = new WeakMap<PlanDTO, DesignPart>()

/**
 * The plan's part as the shared Design field components read it: its design snapshot with the
 * plan-only edits, on the plan's stock copy (docs/modes/plan-v0.2.md#plan-only-edits-and-the-snapshot-scene).
 * Memoized per plan record (records are immutable; `doc` is not read by the field components).
 */
export function planPart(doc: ProjectDoc, plan: PlanDTO): DesignPart {
  const hit = partCache.get(plan)
  if (hit !== undefined) return hit
  const r = loadPlanDTO(plan, doc.unitSystem, 'plan UI')
  const loaded = r.isOk()
    ? {
        dto: plan.design.part,
        part: r.unwrap().part,
        stock: r.unwrap().stock,
        units: doc.unitSystem,
      }
    : undefined
  const part: DesignPart = {
    doc,
    units: doc.unitSystem,
    dto: plan.design.part,
    loaded,
    table:
      loaded === undefined ? undefined : SurfaceTable.build(loaded.part.operations, loaded.stock),
  }
  partCache.set(plan, part)
  return part
}

const editedCache = new WeakMap<PlanDTO, ReadonlySet<string>>()

/**
 * Design operations of the plan's part that differ from the design as taken (plan-only edits),
 * memoized per plan record (a stable set for the viewport tint).
 */
export function editedOperations(plan: PlanDTO): ReadonlySet<string> {
  const hit = editedCache.get(plan)
  if (hit !== undefined) return hit
  const out = new Set<string>()
  for (const op of plan.design.part.operations) {
    const taken = plan.design.taken.operations.find((o) => o.id === op.id)
    if (!sameValue(taken, op)) out.add(op.id)
  }
  editedCache.set(plan, out)
  return out
}

/** How many plan-only edits a rebuild would discard (the confirmation names it). */
export const planEditCount = (plan: PlanDTO): number => editedOperations(plan).size

/** The statuses the picker offers: the current one and its transitions. */
export function statusChoices(plan: PlanDTO): PlanStatus[] {
  return [plan.status, ...TRANSITIONS[plan.status]]
}

/** Name of a library copy in the plan (`values.name`). */
export function snapshotName(plan: PlanDTO, snapshotId: string | undefined): string | undefined {
  if (snapshotId === undefined) return undefined
  const v = plan.snapshots.find((s) => s.id === snapshotId)?.values as
    { name?: unknown } | undefined
  return typeof v?.name === 'string' ? v.name : undefined
}

/**
 * The preset the default rule picks for a tool copy (as `pickPreset` in core/plan/feeds.ts):
 * the one for the stock's material class, else one without a class, else none (auto mode).
 */
export function defaultPresetName(
  plan: PlanDTO,
  toolSnapshotId: string | undefined,
): string | null {
  const presets =
    (
      plan.snapshots.find((s) => s.id === toolSnapshotId)?.values as
        { presets?: { name: string; materialClass?: string }[] } | undefined
    )?.presets ?? []
  const stock = plan.snapshots.find((s) => s.id === plan.design.part.stock)?.values as
    { material?: { class?: string } } | undefined
  const cls = stock?.material?.class
  return (
    presets.find((p) => p.materialClass !== undefined && p.materialClass === cls)?.name ??
    presets.find((p) => p.materialClass === undefined)?.name ??
    null
  )
}

/** A plan operation's name: the names of the design operations it machines. */
export function planOperationName(plan: PlanDTO, designOperationIds: readonly string[]): string {
  const ops = plan.design.part.operations
  return designOperationIds.map((id) => ops.find((o) => o.id === id)?.name ?? id).join(', ')
}

export function planOperationKind(
  plan: PlanDTO,
  designOperationIds: readonly string[],
): OperationKind | undefined {
  return plan.design.part.operations.find((o) => o.id === designOperationIds[0])?.kind
}

// ── queries ───────────────────────────────────────────────────────────────────────────────

/** Lock of a feeds field (docs/modes/plan-v0.1.md#locks-and-auto-mode). */
export type LockView =
  | { readonly state: 'hidden' }
  | { readonly state: 'available' }
  | { readonly state: 'unavailable'; readonly rule: string; readonly reason: string }

/** One feeds field of `plan.operation.list`. */
export interface FeedView {
  readonly value: number
  readonly unit: string
  readonly source: FeedSource
  readonly locked: boolean
  /** Auto mode: the value without the field's own entry. */
  readonly recommended: { readonly value: number; readonly unit: string } | null
  readonly lock: LockView
}

/** One row of `plan.operation.list`. */
export interface PlanOperationView {
  readonly id: string
  readonly kind: OperationKind
  readonly designOperationIds: readonly string[]
  readonly tool: { snapshotId: string; libraryItemId: string; name: string } | null
  readonly presetName: string | null
  /** Auto mode (calculator): on, off (a preset is used), or unavailable with the reason. */
  readonly auto: 'on' | 'off' | { readonly unavailable: string }
  readonly stickout: number | null
  readonly feeds: Readonly<Record<FeedField, FeedView | null>>
  readonly chipLoad: number | null
  /** Resolved strategy parameters (mm, °), defaults included. */
  readonly strategy: Readonly<Record<string, number | string>>
}

/** `plan.stale.list`. */
export interface PlanStale {
  /** Its inputs have changes not applied yet: the plan updates on Apply (P2). */
  readonly pendingApply?: boolean
  readonly partRemoved: boolean
  readonly partChanged: readonly string[]
  readonly rebuildBlocked: string | null
  readonly operations: readonly {
    operationId: string
    changedInDesign: boolean
    removedFromDesign: boolean
    editedInPlan: boolean
    /** The design's tool field changed (E4); absent from plans read before it. */
    designToolChanged?: boolean
  }[]
  readonly libraryCopies: readonly {
    snapshotId: string
    kind: 'stock' | 'tool' | 'machine'
    libraryItemId: string
    status: 'libraryChanged' | 'libraryRemoved' | 'libraryUnreadable'
    blocked: string | null
  }[]
}

/** Whether the design moved on from the plan's snapshot (rebuild offered). */
export function designStale(s: PlanStale): boolean {
  return (
    s.partRemoved ||
    s.partChanged.length > 0 ||
    s.operations.some((o) => o.changedInDesign || o.removedFromDesign)
  )
}

/** The stale flag of a plan operation row (the first that applies). */
export function rowStale(
  s: PlanStale | undefined,
  designOperationIds: readonly string[],
): 'removed' | 'changed' | 'edited' | undefined {
  const mine = s?.operations.filter((o) => designOperationIds.includes(o.operationId)) ?? []
  if (mine.some((o) => o.removedFromDesign)) return 'removed'
  if (mine.some((o) => o.changedInDesign)) return 'changed'
  if (mine.some((o) => o.editedInPlan)) return 'edited'
  return undefined
}

/** `plan.toolpath.get` per plan operation. */
export interface ToolpathEntry {
  readonly toolpath: Toolpath | null
  readonly stale: boolean
  /** The plan's inputs have changes not applied yet (P2): outdated until Apply. */
  readonly pendingApply?: boolean
}

export function toolpathState(
  entry: ToolpathEntry | undefined,
  failure: AppErrorData | undefined,
): ToolpathState {
  if (failure !== undefined) return 'failed'
  if (entry === undefined || entry.toolpath === null) return 'none'
  return entry.stale || entry.pendingApply === true ? 'stale' : 'ready'
}

/** Error findings block generation and export (plan-v0.1.md: `plan.check`, `plan.order`). */
export const isError = (w: PlanWarning): boolean => w.severity === 'error'

// ── feeds and speeds ──────────────────────────────────────────────────────────────────────

export const FEED_KIND: Record<FeedField, QuantityKind> = {
  spindleSpeed: 'spindleSpeed',
  feedRate: 'feedRate',
  plungeRate: 'feedRate',
  stepdown: 'length',
  stepover: 'length',
}

/** Bare-number unit of a feeds field in the project unit system. */
export function feedUnit(field: FeedField, units: UnitSystem): UnitId {
  switch (FEED_KIND[field]) {
    case 'spindleSpeed':
      return 'rpm'
    case 'feedRate':
      return units === 'mm' ? 'mm/min' : 'in/min'
    default:
      return units === 'mm' ? 'mm' : 'in'
  }
}

/** Display precision of a feeds field (rpm whole, feeds 0.1 mm/min, lengths 0.001 mm). */
function decimals(field: FeedField, units: UnitSystem): number {
  if (field === 'spindleSpeed') return 0
  if (FEED_KIND[field] === 'feedRate') return units === 'mm' ? 1 : 2
  return units === 'mm' ? 3 : 4
}

const trim = (n: number, d: number): string =>
  n
    .toFixed(d)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '')

/**
 * A resolved value (mm, mm/min or rpm, as `plan.operation.list` returns it) as a quantity in the
 * project unit system, rounded to the field's precision, so the field shows it like a typed one.
 */
export function feedQuantity(
  field: FeedField,
  valueMm: number,
  units: UnitSystem,
): Quantity | undefined {
  const unit = feedUnit(field, units)
  const v = units === 'inch' && field !== 'spindleSpeed' ? valueMm / 25.4 : valueMm
  const q = Quantity.parse(`${trim(v, decimals(field, units))} ${unit}`, {
    kind: FEED_KIND[field],
    defaultUnit: unit,
  })
  return q.isOk() ? q.unwrap() : undefined
}

/** A length in mm as text in the project units ("6 mm", "0.236 in"). */
export function lengthText(mm: number, units: UnitSystem): string {
  return units === 'mm' ? `${trim(mm, 3)} mm` : `${trim(mm / 25.4, 4)} in`
}

/** Feeds fields a kind uses: drilling has no stepdown or stepover. */
export function feedFields(kind: OperationKind): readonly FeedField[] {
  return kind === 'drilling'
    ? ['spindleSpeed', 'feedRate', 'plungeRate']
    : ['spindleSpeed', 'feedRate', 'plungeRate', 'stepdown', 'stepover']
}

// ── strategy ──────────────────────────────────────────────────────────────────────────────

/** Strategy parameters entered as an angle (°); the other quantities are lengths. */
export const ANGLE_KEYS: ReadonlySet<StrategyKey> = new Set(['rampAngle'])
/** Strategy parameters that are a choice of a few values. */
export const CHOICE_KEYS: ReadonlySet<StrategyKey> = new Set([
  'direction',
  'pattern',
  'axis',
  'entry',
  'cycle',
])

/** A resolved strategy length (mm) or angle (°) as a quantity in the project units. */
export function strategyQuantity(
  key: StrategyKey,
  value: number,
  units: UnitSystem,
): Quantity | undefined {
  const angle = ANGLE_KEYS.has(key)
  const unit: UnitId = angle ? 'deg' : units === 'mm' ? 'mm' : 'in'
  const text = angle
    ? `${trim(value, 2)}°`
    : `${trim(units === 'mm' ? value : value / 25.4, units === 'mm' ? 3 : 4)} ${unit}`
  const q = Quantity.parse(text, { kind: angle ? 'angle' : 'length', defaultUnit: unit })
  return q.isOk() ? q.unwrap() : undefined
}

/**
 * The strategy parameters the inspector shows for a kind, in table order, given the resolved
 * values (docs/conventions/ui.md#plan-mode-task-37: only parameters that apply). `through`: a
 * drilling through the stock (breakthrough applies).
 */
export function shownStrategyKeys(
  kind: OperationKind,
  resolved: Readonly<Record<string, number | string>>,
  through: boolean,
): StrategyKey[] {
  const entry = resolved['entry']
  const cycle = resolved['cycle']
  const applies = (key: StrategyKey): boolean => {
    switch (kind) {
      case 'pocket':
        if (key === 'helixDiameter') return entry === 'helix'
        if (key === 'rampAngle') return entry !== 'plunge'
        if (key === 'finishStepdown') return Number(resolved['finishAllowance'] ?? 0) > 0
        return true
      case 'profile':
        return key !== 'rampAngle' || entry === 'ramp'
      case 'drilling':
        if (key === 'peckDepth') return cycle === 'peck' || cycle === 'chipBreak'
        if (key === 'chipBreakBack') return cycle === 'chipBreak'
        if (key === 'helixPitch' || key === 'rampAngle') return cycle === 'helix'
        if (key === 'breakthrough') return through
        return true
      case 'facing':
        return true
    }
  }
  return STRATEGY_KEYS[kind].filter(applies)
}
