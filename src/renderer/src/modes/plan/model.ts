// Plan mode's view of the document and of the plan queries (task 3.7), pure: which plans the
// picker shows, a plan operation's name, the statuses a plan may go to, a resolved feeds value as
// a quantity in the project units, what is stale, and each plan operation's toolpath state; the
// setups (v0.2 task F6): the window's setup, its WCS corner and frame, same-direction moves.
// Commands do the checking; this only builds what the UI shows and sends.
// Doc: docs/modes/plan-v0.1.md#commands-and-queries-v01, docs/conventions/ui.md#plan-mode-task-37
import { disabledState, unitOfOperation } from '../../../../core/design/disabled'
import type { OperationKind, PartDTO } from '../../../../core/design/part.dto'
import { SurfaceTable } from '../../../../core/design/surfaces'
import type { Direction, StockSize } from '../../../../core/geometry/face'
import type { Placement } from '../../../../core/geometry/model'
import { loadPlanDTO } from '../../../../core/plan/plan'
import { planOpLabel } from '../../../../core/plan/labels'
import { sameValue } from '../../../../core/plan/validity'
import type { PlanWarning } from '../../../../core/plan/checks'
import type {
  FeedField,
  PlanDTO,
  PlanOperationDTO,
  PlanStatus,
  SetupDTO,
} from '../../../../core/plan/plan.dto'
import { setupCorner as coreSetupCorner } from '../../../../core/plan/setup-header'
import { setupDirection, setupRotation } from '../../../../core/plan/setups'
import { STRATEGY_KEYS, type StrategyKey } from '../../../../core/plan/strategy'
import { ALLOWED, TRANSITIONS } from '../../../../core/plan/status'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import { Quantity } from '../../../../core/quantity/quantity'
import type { QuantityKind, UnitId } from '../../../../core/quantity/units'
import type { Toolpath } from '../../../../core/toolpath/model'
import { maxOverreach, type Overreach } from '../../../../core/toolpath/overreach'
import { setupFrame } from '../../../../core/toolpath/wcs'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import {
  planMessages as m,
  type FeedSource,
  type FindingNames,
  type ToolpathState,
} from '../../messages/plan'
import type { DesignPart } from '../design/model'

/** Plans the picker offers: every plan of the project, archived ones last. */
export function pickerPlans(doc: ProjectDoc): PlanDTO[] {
  const all = Object.values(doc.plans)
  return [
    ...all.filter((p) => p.status !== 'archived'),
    ...all.filter((p) => p.status === 'archived'),
  ]
}

/**
 * A plan's name in pickers: with several parts in the project, the plan's part follows it ("Plan 1
 * · Enclosure 1"; the design part's current name, else the plan's copy). Split parts S0.
 */
export function planLabel(doc: ProjectDoc, plan: PlanDTO): string {
  const part = planPartName(doc, plan)
  return part === undefined ? plan.name : m.picker.withPart(plan.name, part)
}

/** The plan's part name while the project has several parts (split parts S0), else undefined. */
export function planPartName(doc: ProjectDoc, plan: PlanDTO): string | undefined {
  if (Object.keys(doc.parts).length < 2) return undefined
  const id = plan.design.partId
  return Object.hasOwn(doc.parts, id) ? doc.parts[id]!.name : plan.design.part.name
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
        // Plan sees operations only (docs/modes/features.md#plan)
        features: [],
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

// ── setups (v0.2 task F6) ─────────────────────────────────────────────────────────────────

/** Every plan operation in machining order, across the setups. */
export const allPlanOperations = (plan: PlanDTO): PlanOperationDTO[] =>
  plan.setups.flatMap((s) => s.operations)

/** The setup a plan operation belongs to. */
export const setupOf = (plan: PlanDTO, planOperationId: string | null): SetupDTO | undefined =>
  plan.setups.find((s) => s.operations.some((o) => o.id === planOperationId))

/**
 * The setup the window works on (preview and export, docs/conventions/ui.md#design-and-plan-controls-v02):
 * the selected setup, or the setup of the selected plan operation, else the same for the last
 * selection (`last`) if the plan still has it, else the first.
 */
export function currentSetup(
  plan: PlanDTO,
  selected: string | null,
  last: string | undefined,
): SetupDTO {
  const of = (id: string | null | undefined) =>
    id === null || id === undefined
      ? undefined
      : (plan.setups.find((s) => s.id === id) ?? setupOf(plan, id))
  return of(selected) ?? of(last) ?? plan.setups[0]!
}

/** The plan's stock copy as sizes in mm, or undefined when the plan does not load. */
export function planStockSize(doc: ProjectDoc, plan: PlanDTO): StockSize | undefined {
  const s = planPart(doc, plan).loaded?.stock
  return s === undefined
    ? undefined
    : { length: s.length.canonical, width: s.width.canonical, thickness: s.thickness.canonical }
}

/**
 * A split piece's blank for its plan's summary (split parts 4c): the library stock it is cut from
 * (undefined = its own block) and the plan's stock copy in mm; undefined for a whole part.
 */
export function pieceBlank(
  doc: ProjectDoc,
  plan: PlanDTO,
): { readonly stock: string | undefined; readonly size: StockSize } | undefined {
  const part = plan.design.part
  if (part.derivedFrom === undefined) return undefined
  const s = planPart(doc, plan).loaded?.stock
  if (s === undefined) return undefined
  return {
    stock: part.blank?.libraryItemId === undefined ? undefined : s.name,
    size: {
      length: s.length.canonical,
      width: s.width.canonical,
      thickness: s.thickness.canonical,
    },
  }
}

/**
 * A setup's WCS in the part frame (`setupFrame`), for the per-setup preview: its origin at the
 * work zero (`zero`, setup frame mm; DF78), absent = the front-left corner of the up face.
 */
export function setupPlacement(
  setup: SetupDTO,
  stock: StockSize,
  zero?: readonly [number, number],
): Placement {
  return setupFrame(
    setupDirection(setup),
    setupRotation(setup),
    stock,
    zero === undefined ? undefined : [zero[0], zero[1]],
  )
}

/** DF78: what the plan knows of a setup's zero and points (`PlanData.alignment`). */
export interface SetupAlignmentInfo {
  readonly zero: readonly [number, number]
  readonly zeroPoint?: string | undefined
  readonly points: readonly {
    readonly id: string
    readonly name: string
    readonly wcs: readonly [number, number] | null
  }[]
}

/**
 * The setup's work zero in the setup frame (mm): the plan's resolved one (a `{ point }` zero
 * follows its point), else the stored offset while the plan re-reads, else the corner.
 */
export function setupZeroOf(
  setup: SetupDTO,
  info: SetupAlignmentInfo | undefined,
): readonly [number, number] {
  if (info !== undefined) return info.zero
  return setup.zero !== undefined && 'at' in setup.zero ? setup.zero.at : [0, 0]
}

/**
 * `plan.alignment.set`'s `points` with a new point from `source` last (no id: the core names it
 * after its source); the inspector's add menu and viewport picking (S22) send it.
 */
export function pointsWithAdded(
  setup: SetupDTO,
  source: object,
): { id?: string; name?: string; source: object }[] {
  return [
    ...(setup.alignment ?? []).map((p) => ({
      id: p.id,
      ...(p.name === undefined ? {} : { name: p.name }),
      source: p.source,
    })),
    { source },
  ]
}

/**
 * The work zero as words (N6): the part corner when it is one ("front left"), else the offset
 * from it or the point it is on; `length` formats mm in the user's units.
 */
export function setupZeroWords(
  setup: SetupDTO,
  stock: StockSize,
  info: SetupAlignmentInfo | undefined,
  length: (mm: number) => string,
): {
  readonly corner: string
  readonly offset?: readonly [string, string]
  readonly point?: string
} {
  const corner = setupCorner(setup, stock)
  const point = info?.points.find((p) => p.id === info.zeroPoint)
  if (point !== undefined) return { corner, point: point.name }
  const [x, y] = setupZeroOf(setup, info)
  return x === 0 && y === 0 ? { corner } : { corner, offset: [length(x), length(y)] }
}

/**
 * The part corner the setup's work zero (G54) sits at ("front left" for an unrotated top setup,
 * "back left" for the bottom): the core's, which the gCode header uses too (DF58).
 */
export const setupCorner = (setup: SetupDTO, stock: StockSize): string =>
  coreSetupCorner(setup, stock)

/** A setup's direction (absent = `+z`). */
export const directionOfSetup = (setup: SetupDTO): Direction => setupDirection(setup)

/** Other setups a setup may merge with, or a plan operation move to: the same direction only. */
export function sameDirectionSetups(plan: PlanDTO, setup: SetupDTO): SetupDTO[] {
  const d = setupDirection(setup)
  return plan.setups.filter((s) => s.id !== setup.id && setupDirection(s) === d)
}

/**
 * Where `plan.operation.move` takes a plan operation one step up or down: within its setup, or
 * across the boundary into the neighbouring setup when that has the same direction (to its end
 * going up, to its start going down). Undefined at the ends.
 */
export function operationStep(
  plan: PlanDTO,
  planOperationId: string,
  by: -1 | 1,
): { toIndex: number; toSetupId?: string } | undefined {
  const si = plan.setups.findIndex((s) => s.operations.some((o) => o.id === planOperationId))
  const setup = plan.setups[si]
  if (setup === undefined) return undefined
  const to = setup.operations.findIndex((o) => o.id === planOperationId) + by
  if (to >= 0 && to < setup.operations.length) return { toIndex: to }
  const next = plan.setups[si + by]
  if (next === undefined || setupDirection(next) !== setupDirection(setup)) return undefined
  return { toSetupId: next.id, toIndex: by < 0 ? next.operations.length : 0 }
}

/**
 * Whether error findings block the export of one setup: its operations' errors and plan-wide
 * errors that are not about another setup (the core blocks a program only on its own setup's
 * findings, docs/modes/plan-v0.2.md#implementation-task-e2).
 */
export function setupExportBlocked(warnings: readonly PlanWarning[], setup: SetupDTO): boolean {
  const ids = new Set(setup.operations.map((o) => o.id))
  return warnings.some(
    (w) =>
      isError(w) &&
      (w.planOperationId === undefined
        ? w.params['setupId'] === undefined || w.params['setupId'] === setup.id
        : ids.has(w.planOperationId)),
  )
}

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

/** A plan operation's name: its feature label ("Hole 1 · drill × 6", plan-v0.4.md § Plan side). */
export function planOperationName(
  plan: PlanDTO,
  op: {
    readonly designOperationIds: readonly string[]
    readonly aid?: { readonly name: string } | undefined
  },
): string {
  // alignment aids carry their own name (alignment.md S13)
  return planOpLabel(plan.design.part, op)
}

/** Readable names for the ids in a plan finding's params (DF43: never the id itself). */
export function findingNames(plan: PlanDTO): FindingNames {
  const part = plan.design.part
  return {
    design: (id) => part.operations.find((o) => o.id === id)?.name ?? m.unknownOperation,
    planOperation: (id) => {
      const op = allPlanOperations(plan).find((o) => o.id === id)
      return op === undefined ? m.unknownOperation : planOperationName(plan, op)
    },
    setup: (id) => plan.setups.find((s) => s.id === id)?.name ?? m.unknownSetup,
  }
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
  /** A through profile: the material it cuts below the stock face (mm), else null (DF23). */
  readonly throughDepth?: number | null
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
    /** Switched off in Design (DF106); absent from plans read before it. */
    disabledInDesign?: boolean
    editedInPlan: boolean
    /** The design's tool field changed (E4); absent from plans read before it. */
    designToolChanged?: boolean
  }[]
  readonly libraryCopies: readonly {
    snapshotId: string
    kind: 'stock' | 'tool' | 'machine' | 'workholding'
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
    s.operations.some((o) => o.changedInDesign || o.removedFromDesign || o.disabledInDesign)
  )
}

/** An item listed under "Off" in the plan navigator (DF106). */
export interface OffItem {
  /** The design operation or feature id (a top-level unit). */
  readonly id: string
  readonly name: string
  /** Switched off in this plan only (can be enabled here) or in Design (read-only here). */
  readonly where: 'plan' | 'design'
  /** The part the item is read from, and its first operation (the row icon). */
  readonly part: PartDTO
  readonly operation: PartDTO['operations'][number] | undefined
}

/**
 * The items switched off for this plan (DF106, plan-v0.4.md § Disabling in a plan): its own list,
 * then the design's own list (items it still copies – a settled plan from before – show in their
 * row with "Off in design" instead).
 */
export function offItems(doc: ProjectDoc, plan: PlanDTO): OffItem[] {
  const record = Object.hasOwn(doc.parts, plan.design.partId)
    ? doc.parts[plan.design.partId]
    : undefined
  const item = (part: PartDTO, id: string, where: OffItem['where']): OffItem | undefined => {
    const operation = part.operations.find((o) => o.id === id || o.featureId === id)
    const name =
      part.operations.find((o) => o.id === id)?.name ??
      part.features?.find((f) => f.id === id)?.name
    return name === undefined ? undefined : { id, name, where, part, operation }
  }
  const mine = plan.disabled ?? []
  const own = mine.flatMap((id) => item(plan.design.taken, id, 'plan') ?? [])
  const copied = (id: string) =>
    plan.design.part.operations.some((o) => o.id === id || o.featureId === id)
  const design =
    record === undefined
      ? []
      : [...disabledState(record).roots]
          .filter((id) => !mine.includes(id) && !copied(id))
          .flatMap((id) => item(record, id, 'design') ?? [])
  return [...own, ...design]
}

/**
 * The plan's disabled list with the design items plan operation `op` machines switched off too
 * (their top-level units: an owned operation switches its feature, DF106); undefined for an
 * alignment aid.
 */
export function disableInPlanList(plan: PlanDTO, op: PlanOperationDTO): string[] | undefined {
  if (op.aid !== undefined) return undefined
  const units = op.designOperationIds.map((id) => unitOfOperation(plan.design.taken, id))
  return [...new Set([...(plan.disabled ?? []), ...units])]
}

/** A plan operation row's stale flag. */
export type RowStale = 'removed' | 'offInDesign' | 'changed' | 'edited'

/** The stale flag of a plan operation row (the first that applies). */
export function rowStale(
  s: PlanStale | undefined,
  designOperationIds: readonly string[],
): RowStale | undefined {
  const mine = s?.operations.filter((o) => designOperationIds.includes(o.operationId)) ?? []
  if (mine.some((o) => o.removedFromDesign)) return 'removed'
  if (mine.some((o) => o.disabledInDesign === true)) return 'offInDesign'
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
  /** How far the current toolpath's tool reaches past the stock sides (mm, DF59); null if stale. */
  readonly overreach?: Overreach | null
}

/**
 * A setup's reach past the stock (DF59): the per-side maximum over its plan operations, or
 * `undefined` while any of their toolpaths is missing or outdated.
 * Doc: docs/modes/plan-v0.2.md#tool-reach-past-the-stock-and-clamps-hardening-df59-interim
 */
export function setupOverreach(
  setup: SetupDTO,
  toolpaths: Readonly<Record<string, ToolpathEntry>>,
): Overreach | undefined {
  const list: Overreach[] = []
  for (const op of setup.operations) {
    const e = toolpaths[op.id]
    if (e === undefined || toolpathState(e, undefined) !== 'ready' || !e.overreach) return undefined
    list.push(e.overreach)
  }
  return maxOverreach(list)
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
/** A hard warning; `info` findings are notes and are not counted as warnings (ui.md#warnings-and-dfm). */
export const isWarning = (w: PlanWarning): boolean => w.severity === 'warning'

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
 * drilling through the stock, a through profile (not a blind groove) or a pattern's through
 * pocket (patterns P4): breakthrough applies.
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
        if (key === 'breakthrough') return through
        return true
      case 'profile':
        if (key === 'breakthrough') return through
        if (key === 'finishStepdown') return Number(resolved['finishAllowance'] ?? 0) > 0
        return key !== 'rampAngle' || entry === 'ramp'
      case 'drilling':
        if (key === 'peckDepth') return cycle === 'peck' || cycle === 'chipBreak'
        if (key === 'chipBreakBack') return cycle === 'chipBreak'
        if (key === 'helixPitch' || key === 'rampAngle') return cycle === 'helix'
        if (key === 'breakthrough') return through
        return true
      case 'chamfer':
        return key !== 'rampAngle' || entry === 'contour'
      case 'line':
        return key !== 'rampAngle' || entry !== 'plunge'
      case 'facing':
        return true
    }
  }
  return STRATEGY_KEYS[kind].filter(applies)
}
