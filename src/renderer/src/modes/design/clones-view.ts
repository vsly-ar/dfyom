// Design mode's view of Clones (v0.4 task U3), pure: path rows as the inspector edits them (command
// args: quantities as entered, whole numbers as numbers), new rows and the draft's first row, the
// row summaries, the read-out with the 100-instance limit and the row that crosses it, skip
// toggling by instance number, the draft's source options, and the clone path in one shape for
// the stored feature (core `featurePath`) and a draft (`design.clones.preview`). DF126 M2: mirror
// rows (always last: a new path row goes above them, a move below one is refused), the mirror
// references a row may name, the read-outs' "on the line" counts and the refusals' texts by name.
// Doc: docs/conventions/ui.md#clones, #clone-path-in-the-viewport; docs/modes/clones-mirror.md#ui;
// docs/modes/design-v0.4.md#implementation-f5, #implementation-f6
import {
  alongChain,
  CLONES_MAX,
  featurePath,
  mapRow,
  sourceMembers,
  sourceOf,
  sourceOperations,
  type CloneRowKind,
  type Clones,
  type ClonesSource,
} from '../../../../core/design/clones/clones'
import { stockFaceOf } from '../../../../core/design/clones/mirror'
import type { ClonePath } from '../../../../core/design/clones/path'
import type { Region2dPort } from '../../../../core/geometry/2d/port'
import type { Issue } from '../../../../shared/errors/app-error'
import { designToolFromDTO } from '../../../../core/design/tool'
import type { FeatureDTO } from '../../../../core/design/feature.dto'
import type { OperationDTO } from '../../../../core/design/part.dto'
import type { ShapeDTO } from '../../../../core/design/shape.dto'
import type { UnitSystem } from '../../../../core/project/document'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type { ClonesRowArg } from '../../state/ui-store'
import type { IconName } from '../../ui'
import type { ClonePathData } from '../../viewport/clone-path'
import {
  operationUnits,
  unitOperations,
  type ClonesSourceChoice,
  type OperationUnit,
} from './feature-view'
import { quantityOf, type DesignPart } from './model'

/** A path row as `design.clones.add` / `.update` take it: quantities as their source text. */
export type RowArg = ClonesRowArg

/** The Add row menu's order (ui.md § Clones). */
export const ROW_KINDS: readonly CloneRowKind[] = [
  'grid',
  'offset',
  'polar',
  'arc',
  'point',
  'along',
  'mirror',
]

/** Row-kind icons (L1 `row-*`; L2 decides whether they read at 16 px). */
export const ROW_ICON: Readonly<Record<CloneRowKind, IconName>> = {
  grid: 'row-grid',
  offset: 'row-offset',
  polar: 'row-polar',
  arc: 'row-arc',
  point: 'row-point',
  along: 'row-along',
  mirror: 'row-mirror',
}

/** The fields of each row kind in the order the inspector shows them (ui.md § Clones table). */
export const ROW_FIELD_ORDER: Readonly<
  Record<CloneRowKind, readonly { key: string; kind: 'count' | 'length' | 'angle' }[]>
> = {
  grid: [
    { key: 'cols', kind: 'count' },
    { key: 'rows', kind: 'count' },
    { key: 'du', kind: 'length' },
    { key: 'dv', kind: 'length' },
  ],
  offset: [
    { key: 'count', kind: 'count' },
    { key: 'du', kind: 'length' },
    { key: 'dv', kind: 'length' },
  ],
  polar: [
    { key: 'count', kind: 'count' },
    { key: 'angle', kind: 'angle' },
    { key: 'distance', kind: 'length' },
  ],
  arc: [
    { key: 'radius', kind: 'length' },
    { key: 'angle', kind: 'angle' },
    { key: 'arc', kind: 'angle' },
    { key: 'step', kind: 'angle' },
  ],
  point: [
    { key: 'u', kind: 'length' },
    { key: 'v', kind: 'length' },
  ],
  // shape, Spacing / Count and start are laid out by the row editor itself
  along: [{ key: 'start', kind: 'length' }],
  // flip, About and its reference or coordinate are laid out by the mirror card (DF126 M2)
  mirror: [],
}

/** The field of a row that carries the 100-instance error when the row crosses the limit. */
export function countField(row: RowArg): string {
  switch (row.kind) {
    case 'grid':
      return 'cols'
    case 'offset':
    case 'polar':
      return 'count'
    case 'arc':
      return 'arc'
    case 'point':
      return 'u'
    case 'along':
      return row['count'] !== undefined ? 'count' : 'spacing'
    case 'mirror':
      return 'flip'
  }
}

/** Stored rows (quantity DTOs) as command args (their source text). */
export function rowArgsOf(feature: FeatureDTO): RowArg[] {
  const rows = (feature['rows'] as readonly Record<string, unknown>[] | undefined) ?? []
  return rows.map(
    (r) =>
      mapRow<QuantityDTO, string>(
        r as { kind: CloneRowKind },
        (q) => q.source,
      ) as unknown as RowArg,
  )
}

/** mm in the project's units as a source text (`12.5 mm`, `0.4921"`), exact to 0.001 mm. */
export function lengthText(mm: number, units: UnitSystem): string {
  return units === 'mm' ? `${+mm.toFixed(3)} mm` : `${+(mm / 25.4).toFixed(4)}"`
}

/** The smallest gap of the draft's first row: 3 mm / ⅛″. */
export const MIN_GAP_MM = { mm: 3, inch: 3.175 } as const

/**
 * The diameter (mm) of an operation's tool: the generalized tool's, or the library tool's
 * snapshot; undefined while auto has chosen nothing yet.
 */
export function toolDiameter(op: OperationDTO, doc: DesignPart['doc']): number | undefined {
  const tool = op.tool
  if (tool === undefined) return undefined
  if (tool.kind === 'generalized') {
    const g = designToolFromDTO(tool)
    if (g.isErr()) return undefined
    const t = g.unwrap()
    return t.kind === 'generalized' ? t.diameter.canonical : undefined
  }
  const snap = Object.hasOwn(doc.snapshots, tool.snapshotId)
    ? doc.snapshots[tool.snapshotId]
    : undefined
  const d = (snap?.values as { diameter?: unknown } | undefined)?.diameter
  if (d === null || typeof d !== 'object' || !('source' in d)) return undefined
  return quantityOf(d as QuantityDTO)?.canonical
}

/**
 * The gap of the draft's first row (mm): the source tool's diameter (the largest of the source
 * operations'), at least 3 mm / ⅛″ (ui.md § Clones, First row).
 */
export function firstRowGap(part: Pick<DesignPart, 'dto' | 'doc' | 'units'>, source: ClonesSource) {
  const ops = sourceDtos(part, source)
  const tools = ops
    .map((o) => toolDiameter(o, part.doc))
    .filter((d): d is number => d !== undefined)
  return Math.max(MIN_GAP_MM[part.units], ...tools)
}

/** The source operations' records (a feature member: its owned operations). */
function sourceDtos(part: Pick<DesignPart, 'dto'>, source: ClonesSource): OperationDTO[] {
  const m = sourceMembers(source)
  const ids = new Set(m.operationIds)
  const features = new Set(m.featureIds)
  return part.dto.operations.filter((o) => ids.has(o.id) || features.has(o.featureId ?? ''))
}

/** Every id a source names: feature ids, then operation ids (the inspector's resolver start). */
export function sourceIdsOf(source: ClonesSource): string[] {
  const m = sourceMembers(source)
  return [...m.featureIds, ...m.operationIds]
}

/**
 * The source without member `unit` (Clones v2, G5): a member Clones goes with its own source
 * members (the units nested in it); undefined when nothing would be left.
 */
export function sourceWithout(source: ClonesSource, unit: OperationUnit): ClonesSource | undefined {
  const drop = new Set<string>()
  const walk = (u: OperationUnit) => {
    drop.add(u.id)
    if (u.kind === 'feature') u.nested.forEach(walk)
  }
  walk(unit)
  const m = sourceMembers(source)
  const featureIds = m.featureIds.filter((id) => !drop.has(id))
  const operationIds = m.operationIds.filter((id) => !drop.has(id))
  return featureIds.length + operationIds.length === 0
    ? undefined
    : sourceOf(featureIds, operationIds)
}

/** The source with feature or operation `id` added (G1). */
export function sourceWith(source: ClonesSource, id: string, feature: boolean): ClonesSource {
  const m = sourceMembers(source)
  return feature
    ? sourceOf([...m.featureIds, id], m.operationIds)
    : sourceOf(m.featureIds, [...m.operationIds, id])
}

/**
 * Features that could join a Clones' source ("Add to source…", G9): top-level holes, patterns and
 * Clones on its face, not itself and not held by another Clones.
 */
export function addableFeatures(
  part: Pick<DesignPart, 'dto' | 'loaded'>,
  feature: FeatureDTO,
): FeatureDTO[] {
  const members = new Set(sourceMembers(clonesSourceOf(feature)).featureIds)
  return operationUnits(part).flatMap((u) =>
    u.kind === 'feature' &&
    u.id !== feature.id &&
    !members.has(u.id) &&
    unitOperations(u).every((o) => {
      const on = o.on ?? 'stock.top'
      return on === feature.on || !on.startsWith('stock.')
    })
      ? [u.feature]
      : [],
  )
}

/**
 * The draft's first row: one clone along u by the source's footprint width plus the gap, so the
 * first ghost sits beside the source, never on it.
 */
export function firstRow(width: number, gap: number, units: UnitSystem): RowArg {
  return { kind: 'offset', count: 1, du: lengthText(width + gap, units), dv: lengthText(0, units) }
}

/** Named shapes an `along` row can follow: one item that resolves to a chain (F6). */
export function alongShapes(shapes: readonly ShapeDTO[]): ShapeDTO[] {
  return shapes.filter((s) => alongChain(shapes, s.id).chain !== undefined)
}

/**
 * A new row of `kind` with values that place its first position a `step` (mm) from the reference
 * point; a point row jumps one step along u from `ref` (absolute); an along row follows the first
 * shape it can (undefined: none).
 */
export function newRow(
  kind: CloneRowKind,
  step: number,
  units: UnitSystem,
  ref: { u: number; v: number },
  shapes: readonly ShapeDTO[],
): RowArg | undefined {
  const len = (mm: number) => lengthText(mm, units)
  switch (kind) {
    case 'grid':
      return { kind, cols: 2, rows: 2, du: len(step), dv: len(step) }
    case 'offset':
      return { kind, count: 1, du: len(step), dv: len(0) }
    case 'polar':
      return { kind, count: 2, angle: '0°', distance: len(step) }
    case 'arc':
      return { kind, radius: len(step * 2), angle: '90°', arc: '180°', step: '45°' }
    case 'point':
      return { kind, u: len(ref.u + step), v: len(ref.v) }
    case 'along': {
      const shape = alongShapes(shapes)[0]
      return shape === undefined ? undefined : { kind, shapeId: shape.id, count: 3 }
    }
    case 'mirror':
      return { kind, flip: 'u' }
  }
}

/** The path as the inspector and the viewport read it (preview and stored feature alike). */
export function pathDataOf(path: ClonePath): ClonePathData {
  const uv = (p: { u: number; v: number }): [number, number] => [p.u, p.v]
  return {
    instances: path.instances.map((i) => ({ n: i.number, at: uv(i.at) })),
    rows: path.rows.map((r) => ({
      path: (r.curve ?? r.line).map(uv),
      ...(r.arc === undefined ? {} : { centre: uv(r.arc.centre) }),
      ...(r.mirror === undefined ? {} : { mirror: r.mirror }),
      points: r.points.map((p) => ({
        at: uv(p.at),
        kind: p.kind,
        ...(p.number === undefined ? {} : { n: p.number }),
        ...(p.flip === undefined ? {} : { mirrored: p.flip }),
      })),
    })),
  }
}

/**
 * A stored Clones feature's core path, mirror lines resolved (the stock, `about` against every
 * operation, `port` for named shapes' centres), or undefined when the part does not load.
 */
export function storedClonePath(
  part: Pick<DesignPart, 'loaded' | 'dto'>,
  featureId: string,
  port?: Region2dPort,
): ClonePath | undefined {
  const l = part.loaded
  const lf = l?.features.find((x) => x.feature.id === featureId)
  if (l === undefined || lf === undefined || lf.feature.kind !== 'clones') return undefined
  return featurePath(lf.feature as Clones, l.part.operations, part.dto.shapes ?? [], {
    stock: l.stock,
    port,
  })
}

/** A stored Clones feature's path (core `featurePath`), or undefined when the part does not load. */
export function featurePathData(
  part: Pick<DesignPart, 'loaded' | 'dto'>,
  featureId: string,
  port?: Region2dPort,
): ClonePathData | undefined {
  const path = storedClonePath(part, featureId, port)
  return path === undefined ? undefined : pathDataOf(path)
}

// ── mirror rows (DF126 M2) ───────────────────────────────────────────────────────────────

/** A path row (not a mirror row). */
export const isPathRow = (r: Pick<RowArg, 'kind'>): boolean => r.kind !== 'mirror'

/** Where a new row of `kind` goes: a mirror row at the end, a path row above the mirror rows. */
export function insertIndex(rows: readonly RowArg[], kind: CloneRowKind): number {
  if (kind === 'mirror') return rows.length
  const first = rows.findIndex((r) => !isPathRow(r))
  return first < 0 ? rows.length : first
}

/** Whether the rows keep mirror rows last (core `clonesMirrorLast`). */
export function mirrorsLast(rows: readonly Pick<RowArg, 'kind'>[]): boolean {
  let mirror = false
  for (const r of rows) {
    if (!isPathRow(r)) mirror = true
    else if (mirror) return false
  }
  return true
}

/** Which reference a mirror row uses: the stock face's centre, a feature's centre, a coordinate. */
export type MirrorAbout = 'stock' | 'feature' | 'at'

export function mirrorAbout(row: RowArg): MirrorAbout {
  return typeof row['about'] === 'string'
    ? 'feature'
    : typeof row['at'] === 'string'
      ? 'at'
      : 'stock'
}

/** One reference a mirror row may name: an operation or feature by name. */
export interface MirrorRef {
  readonly value: string
  readonly label: string
}

/**
 * The operations and features a mirror row of a Clones on face `on` may mirror about
 * (clones-mirror.md § Reference, core `mirrorRefIssues`): every top-level operation or feature on
 * the same stock face that cuts an area (not a facing), not the Clones `self` itself; for a stored
 * Clones its own source items instead of its unit. `owners` maps each operation id to the item
 * it picks (a hole's drilling → the hole; a Clones' instance → that Clones).
 */
export function mirrorRefs(
  part: Pick<DesignPart, 'dto' | 'loaded'>,
  on: string,
  self: string | undefined,
): { refs: MirrorRef[]; owners: ReadonlyMap<string, string> } {
  const ops = part.loaded?.part.operations ?? []
  const face = stockFaceOf(on, ops)
  const units = operationUnits(part).flatMap((u) =>
    u.kind === 'feature' && u.id === self ? u.nested : [u],
  )
  const refs: MirrorRef[] = []
  const owners = new Map<string, string>()
  for (const u of units) {
    const members = unitOperations(u)
    if (members.length === 0 || members.every((o) => o.kind === 'facing')) continue
    if (members.some((o) => stockFaceOf(o.on ?? 'stock.top', ops) !== face)) continue
    refs.push({ value: u.id, label: u.kind === 'operation' ? u.op.name : u.feature.name })
    for (const o of members) owners.set(o.id, u.id)
  }
  return { refs, owners }
}

/** A mirror row's summary part: "stock centre", the reference's name, or "at 50 mm". */
export function mirrorRefText(
  row: RowArg,
  refs: readonly MirrorRef[],
  text: { stock: string; at: (length: string) => string; unknown: string },
): string {
  const about = row['about']
  if (typeof about === 'string') return refs.find((r) => r.value === about)?.label ?? text.unknown
  const at = row['at']
  return typeof at === 'string' ? text.at(at) : text.stock
}

/**
 * Issue texts by name (ui.md: never ids): the mirror rules' core messages name ids, so a refusal
 * at a mirror row reads `messages(rule, row)` instead.
 */
export function mirrorIssues(
  issues: readonly Issue[],
  text: (rule: string, row: number, message: string) => string | undefined,
): Issue[] {
  return issues.map((i) => {
    const row = i.path[0] === 'rows' && typeof i.path[1] === 'number' ? i.path[1] : undefined
    if (row === undefined) return i
    const t = text(i.rule, row, i.message)
    return t === undefined ? i : { ...i, message: t }
  })
}

/** The source of a stored Clones feature's record. */
export const clonesSourceOf = (feature: FeatureDTO): ClonesSource =>
  feature['source'] as ClonesSource

/** The source's operations in the loaded part (models: outlines, reference point). */
export function sourceModels(part: Pick<DesignPart, 'loaded'>, source: ClonesSource) {
  const ops = part.loaded?.part.operations ?? []
  return sourceOperations(source, ops)
}

/** What the read-out says (ui.md § Clones, Read-out). */
export interface Readout {
  readonly instances: number
  readonly clones: number
  readonly skipped: number
  /** Mirror positions dropped because they equal their original (DF126, Q165). */
  readonly onLine: number
  /** The path has a mirror row: the read-out says how many are on the line. */
  readonly mirrored: boolean
  /** Over the limit (D36): how many, how many to remove, the first row that crossed it. */
  readonly over?: { readonly actual: number; readonly excess: number; readonly row: number }
}

export function readoutOf(data: ClonePathData): Readout {
  const instances = data.instances.length
  const skipped = data.rows.reduce(
    (n, r) => n + r.points.filter((p) => p.kind === 'skipped').length,
    0,
  )
  const onLine = data.rows.reduce(
    (n, r) => n + r.points.filter((p) => p.kind === 'onLine').length,
    0,
  )
  const mirrored = data.rows.some((r) => r.mirror !== undefined)
  const base = { instances, clones: instances - 1, skipped, onLine, mirrored }
  if (instances <= CLONES_MAX) return base
  let total = 1
  let row = data.rows.length - 1
  for (const [i, r] of data.rows.entries()) {
    total += r.points.filter((p) => p.kind === 'clone').length
    if (total > CLONES_MAX) {
      row = i
      break
    }
  }
  return { ...base, over: { actual: instances, excess: instances - CLONES_MAX, row } }
}

/** A mirror row's card read-out: how many copies it places, how many sit on the line. */
export function mirrorReadout(
  data: ClonePathData | undefined,
  i: number,
): { readonly mirrors: number; readonly onLine: number } | undefined {
  const r = data?.rows[i]
  if (r === undefined) return undefined
  return {
    mirrors: r.points.filter((p) => p.kind === 'clone').length,
    onLine: r.points.filter((p) => p.kind === 'onLine').length,
  }
}

/** How many numbered positions each row has (its summary's "5 positions"). */
export function rowPositions(data: ClonePathData | undefined, i: number): number | undefined {
  const r = data?.rows[i]
  return r === undefined ? undefined : r.points.filter((p) => p.n !== undefined).length
}

/** Which row and which of its points has instance number `n` (undefined: the source or none). */
export function pointOf(
  data: ClonePathData,
  n: number,
): { readonly row: number; readonly point: number } | undefined {
  for (const [row, r] of data.rows.entries()) {
    const point = r.points.findIndex((p) => p.n === n)
    if (point >= 0) return { row, point }
  }
  return undefined
}

/** Instance `n` toggled in or out of its row's `skip` (sorted, left out when empty). */
export function toggleSkip(rows: readonly RowArg[], data: ClonePathData, n: number): RowArg[] {
  const at = pointOf(data, n)
  if (at === undefined) return [...rows]
  return rows.map((r, i) => {
    if (i !== at.row) return r
    const had = r.skip ?? []
    const skip = had.includes(at.point)
      ? had.filter((k) => k !== at.point)
      : [...had, at.point].sort((a, b) => a - b)
    const { skip: _, ...rest } = r
    return (skip.length > 0 ? { ...rest, skip } : rest) as RowArg
  })
}

/** The instance numbers of a row's skipped positions (its Skipped chips). */
export function skippedNumbers(data: ClonePathData | undefined, i: number): number[] {
  return (data?.rows[i]?.points ?? []).flatMap((p) =>
    p.kind === 'skipped' && p.n !== undefined ? [p.n] : [],
  )
}

/** Whether instance `n` is skipped in the path. */
export const isSkipped = (data: ClonePathData | undefined, n: number): boolean =>
  data?.rows.some((r) => r.points.some((p) => p.n === n && p.kind === 'skipped')) ?? false

/** An instance selection id (`clones1_3`): the instance number of a Clones feature. */
export const instanceId = (featureId: string, n: number): string => `${featureId}_${n}`

/** The Clones feature and instance number a selection id names, or undefined. */
export function parseInstanceId(
  part: Pick<DesignPart, 'dto'>,
  id: string | null,
): { readonly feature: FeatureDTO; readonly n: number } | undefined {
  const m = id === null ? null : /^(.+)_([1-9]\d*)$/.exec(id)
  if (m === null) return undefined
  const feature = part.dto.features?.find((f) => f.id === m[1] && f.kind === 'clones')
  return feature === undefined ? undefined : { feature, n: Number(m[2]) }
}

/**
 * The instance a clicked operation belongs to: `clones1_3_pocket2` → Clones 1, instance 3; undefined
 * for operations that are not clone instances.
 */
export function instanceOfOperation(
  part: Pick<DesignPart, 'dto'>,
  operationId: string,
): { readonly feature: FeatureDTO; readonly n: number } | undefined {
  const op = part.dto.operations.find((o) => o.id === operationId)
  const feature = part.dto.features?.find((f) => f.id === op?.featureId)
  if (op === undefined || feature?.kind !== 'clones' || op.featureRole === undefined)
    return undefined
  const m = /^([1-9]\d*)_/.exec(op.featureRole)
  return m === null ? undefined : { feature, n: Number(m[1]) }
}

/** One checkbox of the draft's Source list. */
export interface SourceOption {
  readonly id: string
  readonly label: string
  /** The selected item itself (always in the source, not a checkbox). */
  readonly fixed: boolean
  /** The option it sits on (left out with it when that one is unchecked). */
  readonly host?: string
}

/**
 * The draft's Source list (ui.md § Clones): the selected item, plus every plain operation that sits
 * on its surfaces (a drilling on a pocket's floor), transitively, offered checked. A feature
 * source stands alone: a Clones source is either operations or one feature (F5).
 */
export function draftSourceOptions(
  part: Pick<DesignPart, 'dto' | 'loaded'>,
  choice: Extract<ClonesSourceChoice, { ok: true }>,
): SourceOption[] {
  const ops = part.dto.operations
  if ('featureId' in choice.source) {
    const id = choice.source.featureId
    const feature = part.dto.features?.find((f) => f.id === id)
    return feature === undefined ? [] : [{ id: feature.id, label: feature.name, fixed: true }]
  }
  const first = choice.source.operationIds[0]!
  const taken = new Set<string>()
  for (const u of operationUnits(part))
    if (u.kind === 'feature') for (const n of u.nested) taken.add(n.id)
  const out: SourceOption[] = []
  const inSource = new Set([first])
  const firstOp = ops.find((o) => o.id === first)
  if (firstOp !== undefined) out.push({ id: first, label: firstOp.name, fixed: true })
  const owner = (on: string) => on.slice(0, on.indexOf('.') < 0 ? on.length : on.indexOf('.'))
  for (const op of ops) {
    if (inSource.has(op.id) || op.featureId !== undefined || taken.has(op.id)) continue
    // DF122 R5: a roughing operation comes with its owner (core `sourceOperations`)
    if ((op.kind === 'pocket' || op.kind === 'profile') && op.roughingOf !== undefined) continue
    if (op.kind === 'facing' || (op.kind === 'profile' && op.side === 'outside')) continue
    if (!inSource.has(owner(op.on ?? 'stock.top'))) continue
    inSource.add(op.id)
    out.push({ id: op.id, label: op.name, fixed: false, host: owner(op.on ?? 'stock.top') })
  }
  return out
}

/** The draft's source from its options and the unchecked ones. */
export function draftSource(
  options: readonly SourceOption[],
  unchecked: ReadonlySet<string>,
  feature: boolean,
): ClonesSource {
  if (feature) return { featureId: options[0]!.id }
  const kept = new Set<string>()
  // options come in design order, so a host is decided before what sits on it
  for (const o of options)
    if (o.fixed || (!unchecked.has(o.id) && o.host !== undefined && kept.has(o.host)))
      kept.add(o.id)
  return { operationIds: options.filter((o) => kept.has(o.id)).map((o) => o.id) }
}
