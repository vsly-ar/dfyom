// Design mode's view of features (v0.4 task U1), pure: the operation list as units (a feature's
// block counts once), a unit's move target (a move steps over a whole neighbouring block, never
// into it), owned rows' role names, the feature row's read-out, the rolled-up finding count and
// the feature field behind an owned operation's parameter (core `FeatureKindSpec.fieldOf`, F3).
// Doc: docs/conventions/ui.md#feature-rows-and-add, #owned-operations-and-clone-instances;
// docs/modes/design-v0.4.md#implementation-f3
import { featureKind, featureSpan, ownerOf } from '../../../../core/design/feature'
import { featurePath, type Clones } from '../../../../core/design/clones/clones'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import type { OperationDTO, PartDTO } from '../../../../core/design/part.dto'
import type { DfmWarning } from '../../../../core/geometry/model'
import { checkReferences, surfaceOfReference } from '../../../../core/design/surfaces'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import { ERROR_CODES } from '../../../../shared/errors/codes'
import { designMessages } from '../../messages/design'
import { dfmMessages } from '../../messages/dfm'
import { itemName, pendingApply, quantityOf, surfaceLabel, type DesignPart } from './model'

/** One row of the operation list: a plain operation or a feature with its span. */
export type OperationUnit = OperationRowUnit | FeatureUnit

export interface OperationRowUnit {
  readonly kind: 'operation'
  readonly id: string
  readonly op: OperationDTO
  readonly start: number
  readonly end: number
}

export interface FeatureUnit {
  readonly kind: 'feature'
  readonly id: string
  readonly feature: FeatureDTO
  /** The owned operations in design order (the block `[ownedStart, end)`). */
  readonly ops: readonly OperationDTO[]
  /**
   * Nested operations (F5: a Clones feature's source, `[start, ownedStart)`) as units of their
   * own: plain operations or the source feature's block; empty for a hole.
   */
  readonly nested: readonly OperationUnit[]
  /** The span `[start, end)`: nested, then owned; it moves as one unit. */
  readonly start: number
  readonly ownedStart: number
  readonly end: number
}

/** Groups `[from, to)` of `ops` by owner: plain operations and owned blocks (no spans). */
function blockUnits(
  ops: readonly OperationDTO[],
  features: readonly FeatureDTO[],
  from: number,
  to: number,
): OperationUnit[] {
  const out: OperationUnit[] = []
  for (let i = from; i < to;) {
    const op = ops[i]!
    const feature =
      op.featureId === undefined ? undefined : features.find((f) => f.id === op.featureId)
    if (feature === undefined) {
      out.push({ kind: 'operation', id: op.id, op, start: i, end: i + 1 })
      i++
      continue
    }
    let end = i
    while (end < to && ops[end]!.featureId === feature.id) end++
    out.push({
      kind: 'feature',
      id: feature.id,
      feature,
      ops: ops.slice(i, end),
      nested: [],
      start: i,
      ownedStart: i,
      end,
    })
    i = end
  }
  return out
}

/**
 * The part's operations as units in design order: a feature's span counts once (features.md A3,
 * F5 spans: a Clones feature nests its source right before its owned block). Spans come from the
 * loaded part (core `featureSpan`); without it (a record that does not load) owned blocks only.
 */
export function operationUnits(part: Pick<DesignPart, 'dto' | 'loaded'>): OperationUnit[] {
  const ops = part.dto.operations
  const features = part.dto.features ?? []
  const l = part.loaded
  if (l === undefined || l.part.operations.length !== ops.length)
    return blockUnits(ops, features, 0, ops.length)
  const models = l.part.operations
  // outer spans first where two start together (Clones v2: a group holding a Clones, DF40)
  const spans = l.features
    .filter((lf) => lf.spec.nested !== undefined)
    .map((lf) => ({ id: lf.feature.id, ...featureSpan(models, lf) }))
    .filter((sp) => sp.end > sp.start)
    .toSorted((x, y) => x.start - y.start || y.end - x.end)
  return spanUnitsIn(ops, features, spans, 0, ops.length)
}

/** The units of `[from, to)`: spans inside it as feature units (their own spans nested), the rest as blocks. */
function spanUnitsIn(
  ops: readonly OperationDTO[],
  features: readonly FeatureDTO[],
  spans: readonly { id: string; start: number; ownedStart: number; end: number }[],
  from: number,
  to: number,
): OperationUnit[] {
  const out: OperationUnit[] = []
  let i = from
  for (const sp of spans) {
    if (sp.start < i || sp.end > to) continue // outside, or nested in an earlier span
    out.push(...blockUnits(ops, features, i, sp.start))
    const feature = features.find((f) => f.id === sp.id)
    if (feature === undefined) continue
    out.push({
      kind: 'feature',
      id: sp.id,
      feature,
      ops: ops.slice(sp.ownedStart, sp.end),
      nested: spanUnitsIn(
        ops,
        features,
        spans.filter((x) => x !== sp),
        sp.start,
        sp.ownedStart,
      ),
      start: sp.start,
      ownedStart: sp.ownedStart,
      end: sp.end,
    })
    i = sp.end
  }
  out.push(...blockUnits(ops, features, i, to))
  return out
}

/** Every operation of a unit's span in design order: nested ones (recursively), then owned. */
export function unitOperations(u: OperationUnit): OperationDTO[] {
  return u.kind === 'operation' ? [u.op] : [...u.nested.flatMap(unitOperations), ...u.ops]
}

/** The instance rows of a Clones feature (ui.md § Clones in the navigator), from its path. */
export interface CloneInstanceRow {
  readonly n: number
  readonly kind: 'clone' | 'skipped' | 'duplicate'
  /** The reference point `[u, v]` in mm. */
  readonly at: { readonly u: number; readonly v: number }
}

/**
 * Every numbered position of a Clones feature from 2 (the source is 1) in number order, with its
 * state: a clone, skipped, or a duplicate of an earlier spot (core `featurePath`, stable numbers
 * D30); empty when the part does not load.
 */
export function cloneInstances(
  part: Pick<DesignPart, 'loaded' | 'dto'>,
  featureId: string,
): CloneInstanceRow[] {
  const l = part.loaded
  const lf = l?.features.find((x) => x.feature.id === featureId)
  if (l === undefined || lf === undefined || lf.feature.kind !== 'clones') return []
  const path = featurePath(lf.feature as Clones, l.part.operations, part.dto.shapes ?? [])
  return path.rows
    .flatMap((r) => r.points)
    .flatMap((p) =>
      p.number === undefined || p.kind === 'closes'
        ? []
        : [{ n: p.number, kind: p.kind, at: p.at } as CloneInstanceRow],
    )
    .toSorted((x, y) => x.n - y.n)
}

/**
 * The `toIndex` of moving a unit one step (`design.operation.move` for a plain operation,
 * `design.feature.move` for a feature: the new index of its first operation), stepping over the
 * whole neighbouring unit; undefined at the ends.
 */
export function unitMoveIndex(
  units: readonly OperationUnit[],
  id: string,
  by: -1 | 1,
): number | undefined {
  const i = units.findIndex((u) => u.id === id)
  const unit = units[i]
  const next = units[i + by]
  if (unit === undefined || next === undefined) return undefined
  return by < 0 ? next.start : unit.start + (next.end - next.start)
}

/**
 * Where unit `id` lands in the operation list when it is moved to unit position `to` (D45: a drop;
 * the start index `design.operation.move` / `design.feature.move` take): the operations of the
 * units before it in the new order. Undefined for an unknown unit, an index out of range or no move.
 */
export function unitDropIndex(
  units: readonly OperationUnit[],
  id: string,
  to: number,
): number | undefined {
  const from = units.findIndex((u) => u.id === id)
  if (from < 0 || to < 0 || to >= units.length || to === from) return undefined
  const rest = units.filter((u) => u.id !== id)
  return rest.slice(0, to).reduce((n, u) => n + (u.end - u.start), 0)
}

/**
 * Why moving unit `id` to unit position `to` is refused, as the move command would refuse it (a
 * reference to a surface no longer before its user, a chamfer before its edge: the core's
 * `checkReferences` on the reordered operations); undefined = allowed or unknown.
 */
export function unitDropRefusal(
  part: Pick<DesignPart, 'dto' | 'loaded'>,
  units: readonly OperationUnit[],
  id: string,
  to: number,
): AppErrorData | undefined {
  const l = part.loaded
  const unit = units.find((u) => u.id === id)
  const at = unitDropIndex(units, id, to)
  if (l === undefined || unit === undefined || at === undefined) return undefined
  const ops = l.part.operations
  const block = ops.slice(unit.start, unit.end)
  const rest = [...ops.slice(0, unit.start), ...ops.slice(unit.end)]
  const next = [...rest.slice(0, at), ...block, ...rest.slice(at)]
  const r = checkReferences(next, l.stock)
  return r.isOk() ? undefined : r.unwrapErr().toJSON()
}

/**
 * A refused move as the operation list says it (D45: the same text for a drop and Alt+↑/↓): who
 * needs which surface or edge before it, the feature a position is inside, or the code's message.
 */
export function moveRefusal(part: Pick<DesignPart, 'dto'>, error: AppErrorData): string {
  const t = designMessages.reorder
  const nameOf = (id: string) => {
    const op = part.dto.operations.find((o) => o.id === id)
    const owner = op === undefined ? undefined : ownerFeature(part.dto, op)
    return owner?.name ?? op?.name ?? itemName(part.dto, id)
  }
  const issue = error.issues?.[0]
  if (error.code === 'design.referenced' && issue !== undefined) {
    const user = String(issue.params?.['operationId'] ?? '')
    const reference = String(issue.params?.['reference'] ?? '')
    if (user.length > 0 && reference.length > 0) {
      const edge = part.dto.operations.find((o) => o.id === reference)
      return edge !== undefined
        ? t.edgeFirst(nameOf(user), nameOf(reference))
        : t.surfaceFirst(nameOf(user), surfaceLabel(part.dto, surfaceOfReference(reference)))
    }
  }
  if (issue?.rule === 'insideFeature') {
    const featureId = String(issue.params?.['featureId'] ?? '')
    return t.insideFeature(itemName(part.dto, featureId))
  }
  return t.refused(ERROR_CODES[error.code]?.userMessage ?? error.message)
}

/** The feature an operation belongs to, if any. */
export function ownerFeature(
  part: Pick<PartDTO, 'features'>,
  op: Pick<OperationDTO, 'featureId'>,
): FeatureDTO | undefined {
  return op.featureId === undefined ? undefined : part.features?.find((f) => f.id === op.featureId)
}

/**
 * An owned row's label: the stored name with its "<feature name> · " prefix dropped while it
 * starts with it ("counterbore", not "Hole 1 · counterbore"); a renamed operation keeps its name.
 */
export function roleLabel(featureName: string, opName: string): string {
  const prefix = `${featureName} · `
  return opName.startsWith(prefix) && opName.length > prefix.length
    ? opName.slice(prefix.length)
    : opName
}

/** Whether a finding counts on badges: errors and hard warnings, not while Apply may change it. */
export const countsAsWarning = (w: DfmWarning): boolean =>
  !pendingApply(w) && dfmMessages.tier(w) === 'hard'

/**
 * The findings of a unit: its own operation's, or a feature's own (F5: Clones notes name the
 * feature id as `operation`) and every owned operation's (the roll-up); nested source operations
 * keep their own badges.
 */
export function unitWarnings(unit: OperationUnit, warnings: readonly DfmWarning[]): DfmWarning[] {
  const ids = new Set(unit.kind === 'feature' ? [unit.id, ...unit.ops.map((o) => o.id)] : [unit.id])
  return warnings.filter((w) => ids.has(w.operation))
}

/**
 * The rolled-up badge count: the counted findings of the unit (ui.md § Feature rows: a finding
 * repeated on several clone instances counts once – by code and parameter of the same step).
 */
export function rolledUpCount(unit: OperationUnit, warnings: readonly DfmWarning[]): number {
  const counted = unitWarnings(unit, warnings).filter(countsAsWarning)
  if (unit.kind === 'operation') return counted.length
  const roleOf = (id: string) => unit.ops.find((o) => o.id === id)?.featureRole ?? id
  // a role `<instance>_<step>` repeats its step: one finding per step, code and parameter
  const step = (role: string) => /^[1-9]\d*_(.+)$/.exec(role)?.[1] ?? role
  return new Set(counted.map((w) => `${step(roleOf(w.operation))}:${w.code}:${w.parameter ?? ''}`))
    .size
}

const source = (q: unknown): string | undefined =>
  q !== null && typeof q === 'object' && 'source' in q ? (q as QuantityDTO).source : undefined

/** Hole type names in read-outs. */
const HOLE_TYPES: Readonly<Record<string, string>> = {
  simple: 'simple',
  counterbore: 'counterbore',
  countersink: 'countersink',
}

/**
 * A feature row's read-out in secondary text: "M3 · counterbore", "Ø 6 mm · simple"; a Clones
 * feature "×6" (`instances`: the source and its clones, skipped ones excluded).
 */
export function featureReadout(feature: FeatureDTO, instances?: number): string {
  if (feature.kind === 'clones') return instances === undefined ? '' : `×${instances}`
  // patterns P1: lattice and cell ("hex · polygon"); the cell count is the inspector's read-out
  if (feature.kind === 'pattern')
    return `${String(feature['lattice'])} · ${String((feature['cell'] as { kind?: unknown }).kind)}`
  if (feature.kind === 'hole') {
    const type = HOLE_TYPES[String(feature['type'])] ?? String(feature['type'])
    const fastener = typeof feature['fastener'] === 'string' ? feature['fastener'] : undefined
    const diameter = source(feature['diameter'])
    const size = fastener ?? (diameter === undefined ? undefined : `Ø ${diameter}`)
    const readout = size === undefined ? type : `${size} · ${type}`
    const custom = fastener === undefined ? undefined : customSize(feature)
    return custom === undefined ? readout : `${readout} ${custom} (custom)`
  }
  return ''
}

/**
 * The first size of a hole that differs from its fastener's table row, as the read-out shows it
 * ("Ø 7 mm", "depth 3.5 mm", "100°"; ui.md § Hole inspector, Custom sizes): the kind's own
 * `dfm.holeCustomSize` rule (core `holeSpec.warnings`), so both always agree.
 */
function customSize(feature: FeatureDTO): string | undefined {
  const spec = featureKind('hole')
  if (spec.isNone()) return undefined
  const k = spec.unwrap()
  const hole = k.fromDTO(feature)
  if (hole.isErr()) return undefined
  const first = k.warnings?.(hole.unwrap(), (role) => role)[0]
  const field = first?.parameter
  if (field === undefined) return undefined
  const value = source(feature[field])
  if (value === undefined) return undefined
  if (field === 'cbDepth') return `depth ${value}`
  return field === 'csAngle' ? value : `Ø ${value}`
}

/** The parameter path of an owned operation's first geometric field (where the note points). */
export function firstGeometricPath(op: OperationDTO): string {
  switch (op.kind) {
    case 'drilling':
      return 'center.0'
    case 'pocket':
    case 'profile':
      return 'shape.center.0'
    case 'facing':
      return 'depth'
    case 'chamfer':
      return 'diameter'
    case 'line':
      return 'paths.0.center.0'
  }
}

/**
 * The feature field (dotted, `cbDiameter`, `center.0`) an owned operation's parameter stands for
 * (core `FeatureKindSpec.fieldOf`, design-v0.4.md#implementation-f3); undefined = not mapped.
 */
export function featureFieldOf(
  feature: FeatureDTO,
  op: Pick<OperationDTO, 'featureRole'>,
  path: string,
): string | undefined {
  if (op.featureRole === undefined) return undefined
  const spec = featureKind(feature.kind)
  if (spec.isNone()) return undefined
  const fieldOf = spec.unwrap().fieldOf
  const segs = path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s))
  return fieldOf?.(op.featureRole, segs)?.join('.')
}

/**
 * The feature field a finding on an owned operation belongs to: a kind's own note names it
 * (`params.feature`, `dfm.holeCustomSize`), the rest map their operation parameter.
 */
export function warningFeatureField(
  feature: FeatureDTO,
  op: Pick<OperationDTO, 'featureRole'>,
  w: DfmWarning,
): string | undefined {
  if (w.parameter === undefined) return undefined
  if (w.params['feature'] === feature.id) return w.parameter
  return featureFieldOf(feature, op, w.parameter)
}

/** Feature fields a single-value fix can write (`design.<kind>.update { [field]: source }`). */
export const FIXABLE_FIELDS: ReadonlySet<string> = new Set([
  'diameter',
  'depth',
  'cbDiameter',
  'cbDepth',
  'headSink',
])

/**
 * Why a feature can't be removed now: a later operation uses one of its owned surfaces
 * (`design.referenced`, as `design.feature.remove` would refuse it); undefined = removable.
 * "Hole 1 · counterbore floor is used by Drilling 5."
 */
export function featureRemoveBlocked(
  part: Pick<DesignPart, 'dto' | 'loaded'>,
  featureId: string,
): string | undefined {
  const l = part.loaded
  if (l === undefined) return undefined
  const next = l.part.operations.filter((o) => ownerOf(o) !== featureId)
  const r = checkReferences(next, l.stock)
  if (r.isOk()) return undefined
  const issues = r.unwrapErr().issues
  const first = issues[0]
  const reference = first?.params?.['reference']
  if (typeof reference !== 'string') return undefined
  const users = [...new Set(issues.map((i) => String(i.params?.['operationId'] ?? '')))]
    .filter((id) => id.length > 0)
    .map((id) => itemName(part.dto, id))
  return designMessages.features.referenced(
    surfaceLabel(part.dto, surfaceOfReference(reference)),
    users,
  )
}

/**
 * The feature a finding is fixed in: the owner of its operation, or the feature it names itself
 * (F5: Clones notes carry the feature id as `operation`); undefined for a plain operation.
 */
export function featureOfWarning(
  part: Pick<DesignPart, 'dto'>,
  w: Pick<DfmWarning, 'operation'>,
): FeatureDTO | undefined {
  const op = part.dto.operations.find((o) => o.id === w.operation)
  if (op !== undefined) return ownerFeature(part.dto, op)
  return part.dto.features?.find((f) => f.id === w.operation)
}

/** What Make Clones… would clone from the selection, or why it can't (ui.md § Feature rows). */
export type ClonesSourceChoice =
  | {
      readonly ok: true
      readonly source: { readonly operationIds: readonly string[] } | { readonly featureId: string }
      /** The source's footprint width along u (mm), for the first row's offset. */
      readonly width: number
    }
  | { readonly ok: false; readonly reason: string }

const mmOf = (q: unknown): number | undefined => {
  if (q === null || typeof q !== 'object' || !('source' in q)) return undefined
  return quantityOf(q as QuantityDTO)?.canonical
}

/** A footprint width (mm) of an operation along u, or undefined when it has none to read. */
function widthOf(op: OperationDTO, ops: readonly OperationDTO[]): number | undefined {
  if (op.kind === 'drilling') return mmOf(op.diameter)
  if (op.kind === 'facing' || op.kind === 'line') return undefined
  if (op.kind === 'chamfer') {
    // D45: edge Ø + 2 × width
    const edge = ops.find((o) => o.id === op.edgeOf)
    const edgeD = edge === undefined ? undefined : widthOf(edge, ops)
    const w = mmOf(op.width)
    return edgeD === undefined || w === undefined ? undefined : edgeD + 2 * w
  }
  const shape = op.shape
  return shape.kind === 'circle'
    ? mmOf(shape.diameter)
    : shape.kind === 'rectangle'
      ? mmOf(shape.length)
      : undefined
}

/** The u extent (mm) of operations' centres: a Clones' instances spread along u. */
function centreSpread(ops: readonly OperationDTO[]): number {
  const us = ops.flatMap((o) => {
    const c =
      o.kind === 'drilling'
        ? o.center
        : o.kind === 'facing' || o.kind === 'chamfer'
          ? undefined
          : o.kind === 'line'
            ? o.paths[0]?.center
            : o.shape.center
    const u = c === undefined ? undefined : mmOf(c[0])
    return u === undefined ? [] : [u]
  })
  return us.length === 0 ? 0 : Math.max(...us) - Math.min(...us)
}

/**
 * The Clones source of the selection (`selected`: a feature or operation id): a feature (a Clones
 * too, Clones v2 G2: the core adds its source) or an operation that can be a source; an owned
 * operation stands for its feature. The reasons are the source rule's (design-v0.4.md § Clones in
 * v0.4); the core checks the rest.
 */
export function clonesSource(
  part: Pick<DesignPart, 'dto' | 'loaded'>,
  selected: string | null,
): ClonesSourceChoice {
  const c = designMessages.features.cloneReasons
  const no = (reason: string): ClonesSourceChoice => ({ ok: false, reason })
  const units = operationUnits(part)
  const nestedIn = (id: string) =>
    units.find(
      (u): u is FeatureUnit =>
        u.kind === 'feature' &&
        u.nested.some(
          (n) => n.id === id || (n.kind === 'feature' && n.ops.some((o) => o.id === id)),
        ),
    )
  const op = part.dto.operations.find((o) => o.id === selected)
  const featureId = op !== undefined ? op.featureId : selected
  const feature = part.dto.features?.find((f) => f.id === featureId)
  if (feature !== undefined) {
    const taken = nestedIn(feature.id)
    if (taken !== undefined) return no(c.taken(feature.name, taken.feature.name))
    const unit = units.find((u) => u.id === feature.id)
    const owned =
      unit === undefined
        ? part.dto.operations.filter((o) => o.featureId === feature.id)
        : unitOperations(unit)
    const widths = owned
      .map((o) => widthOf(o, part.dto.operations))
      .filter((w): w is number => w !== undefined)
    return {
      ok: true,
      source: { featureId: feature.id },
      width: centreSpread(owned) + Math.max(0, ...widths),
    }
  }
  if (op === undefined) return no(c.select)
  if (op.kind === 'facing') return no(c.facing)
  if (op.kind === 'profile' && op.side === 'outside') return no(c.outside)
  const taken = nestedIn(op.id)
  if (taken !== undefined) return no(c.taken(op.name, taken.feature.name))
  return {
    ok: true,
    source: { operationIds: [op.id] },
    width: widthOf(op, part.dto.operations) ?? 0,
  }
}
