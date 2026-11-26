// Design mode's view of the document (task 3.6), pure: the part with its models (core `loadPart`,
// the surface table), the parameters' sources, the update args of one field edit, the defaults
// of a new operation and the surfaces a field may reference or pick. Commands do the checking;
// this only builds what the UI shows and sends. Doc: docs/modes/design.md#commands-and-queries-v01,
// docs/conventions/ui.md#panels-and-inspectors
import { disabledState, type DisabledState } from '../../../../core/design/disabled'
import { loadPart, type LoadedPart } from '../../../../core/design/load'
import { fieldContext, type FieldKind } from '../../../../core/design/operation'
import type {
  AnchorDTO,
  OperationDTO,
  OperationKind,
  PartDTO,
  OperationShapeDTO,
} from '../../../../core/design/part.dto'
import { isExpression } from '../../../../core/design/anchor'
import {
  coordinateName,
  STOCK_FACES,
  SurfaceTable,
  type SurfaceEntry,
} from '../../../../core/design/surfaces'
import { DIRECTIONS, type Direction } from '../../../../core/geometry/face'
import type { DfmWarning } from '../../../../core/geometry/model'
import type { ProjectDoc, UnitSystem } from '../../../../core/project/document'
import { Quantity } from '../../../../core/quantity/quantity'
import type { QuantityDTO } from '../../../../core/quantity/quantity.dto'
import type { UnitId } from '../../../../core/quantity/units'
import { designMessages as m } from '../../messages/design'
import type { DfmNames } from '../../messages/dfm'

export interface DesignPart {
  readonly doc: ProjectDoc
  readonly units: UnitSystem
  readonly dto: PartDTO
  /** Models of the part and its stock; undefined if the record does not load. */
  readonly loaded: LoadedPart | undefined
  readonly table: SurfaceTable | undefined
}

const cache = new WeakMap<ProjectDoc, Map<string, DesignPart>>()

const offCache = new WeakMap<PartDTO, DisabledState>()
/**
 * What is off in the part (hardening DF106, docs/modes/design.md#disabling-operations-and-features-df106):
 * switched off and following; memoized per immutable part record.
 */
export function disabledOf(part: Pick<DesignPart, 'dto'>): DisabledState {
  let hit = offCache.get(part.dto)
  if (hit === undefined) offCache.set(part.dto, (hit = disabledState(part.dto)))
  return hit
}

/**
 * The part Design shows: `partId` while the document has it, else the first part (split parts S0:
 * the window's part choice, ui-store `designPart`); memoized per immutable document and part.
 */
export function designPart(doc: ProjectDoc, partId?: string | null): DesignPart | undefined {
  const dto =
    (partId != null && Object.hasOwn(doc.parts, partId) ? doc.parts[partId] : undefined) ??
    Object.values(doc.parts)[0]
  if (dto === undefined) return undefined
  let parts = cache.get(doc)
  if (parts === undefined) cache.set(doc, (parts = new Map()))
  const hit = parts.get(dto.id)
  if (hit !== undefined) return hit
  const r = loadPart(doc, dto.id, 'design UI')
  const loaded = r.isOk() ? r.unwrap() : undefined
  const part: DesignPart = {
    doc,
    units: doc.unitSystem,
    dto,
    loaded,
    table:
      loaded === undefined ? undefined : SurfaceTable.build(loaded.part.operations, loaded.stock),
  }
  parts.set(dto.id, part)
  return part
}

// ── parameters ────────────────────────────────────────────────────────────────────────────

/** The DTO value at a parameter path (`depth`, `shape.center.0`, `tabs.width`). */
export function valueAt(op: OperationDTO, path: string): unknown {
  let v: unknown = op
  for (const seg of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined
    v = (v as Record<string, unknown>)[seg]
  }
  return v
}

/** A stored quantity as a model (for a field's stored value); undefined if it does not load. */
export function quantityOf(dto: QuantityDTO): Quantity | undefined {
  const q = Quantity.fromDTO(dto)
  return q.isOk() ? q.unwrap() : undefined
}

/** The quantity of a parameter as a model. */
export function quantityAt(op: OperationDTO, path: string): Quantity | undefined {
  const dto = valueAt(op, path) as QuantityDTO | undefined
  if (dto === undefined || typeof dto !== 'object' || !('source' in dto)) return undefined
  return quantityOf(dto)
}

export function defaultUnit(kind: FieldKind, units: UnitSystem): UnitId {
  return fieldContext(kind, units).defaultUnit
}

const src = (q: QuantityDTO): string => q.source

/** The command args of a shape (as entered), from its DTO. */
export function shapeArgs(shape: OperationShapeDTO): Record<string, unknown> {
  const center = [src(shape.center[0]), src(shape.center[1])]
  const rotation =
    'rotation' in shape && shape.rotation !== undefined ? { rotation: src(shape.rotation) } : {}
  if (shape.kind === 'named')
    return {
      kind: 'named',
      shapeId: shape.shapeId,
      center,
      ...rotation,
      ...(shape.mirror === true ? { mirror: true } : {}),
    }
  return shape.kind === 'rectangle'
    ? {
        kind: 'rectangle',
        center,
        length: src(shape.length),
        width: src(shape.width),
        cornerRadius: src(shape.cornerRadius),
        ...rotation,
      }
    : { kind: 'circle', center, diameter: src(shape.diameter) }
}

/**
 * The update args of one edited parameter: a shape is replaced as a whole and a center as a
 * pair (design.md: updates replace `shape`), tabs merge field by field.
 */
export function updateArgs(
  op: OperationDTO,
  path: string,
  source: string,
): Record<string, unknown> {
  const [head = '', ...rest] = path.split('.')
  if (head === 'shape' && 'shape' in op) {
    const shape = shapeArgs(op.shape)
    if (rest[0] === 'center') {
      const center = [...(shape['center'] as string[])]
      center[Number(rest[1])] = source
      return { shape: { ...shape, center } }
    }
    return { shape: { ...shape, [rest.join('.')]: source } }
  }
  if (head === 'center' && op.kind === 'drilling') {
    const center = [src(op.center[0]), src(op.center[1])]
    center[Number(rest[0])] = source
    return { center }
  }
  if (head === 'tabs') return { tabs: { [rest.join('.')]: source } }
  if (op.kind === 'line') {
    // a Line (engraved-patterns.md E1): paths are replaced whole, a ramp's depth too
    if (head === 'paths') {
      const paths = linePathArgs(op)
      const i = Number(rest[0])
      const p = { ...paths[i]! }
      if (rest[1] === 'center') {
        const center = [...(p['center'] as string[])]
        center[Number(rest[2])] = source
        p['center'] = center
      } else p[rest[1]!] = source
      paths[i] = p
      return { paths }
    }
    if (head === 'depth' && rest.length > 0 && 'start' in op.depth) {
      const depth = { start: src(op.depth.start), end: src(op.depth.end) }
      return { depth: { ...depth, [rest[0]!]: source } }
    }
    if (head === 'depth' && rest.length > 0 && 'min' in op.depth) {
      const depth = { min: src(op.depth.min), max: src(op.depth.max) }
      return { depth: { ...depth, [rest[0]!]: source } }
    }
  }
  return { [head]: source }
}

/** A Line's `paths` args as entered (engraved-patterns.md E1). */
export function linePathArgs(
  op: Extract<OperationDTO, { kind: 'line' }>,
): Record<string, unknown>[] {
  return op.paths.map((p) => ({
    shapeId: p.shapeId,
    center: [src(p.center[0]), src(p.center[1])],
    ...(p.rotation !== undefined ? { rotation: src(p.rotation) } : {}),
    ...(p.mirror === true ? { mirror: true } : {}),
    ...(p.scale !== undefined ? { scale: p.scale } : {}),
  }))
}

/**
 * Rectangle ↔ circle: the new shape keeps the center and takes its size from the old one. Its
 * `center` is the anchor point and an update's shape keeps the operation's anchor
 * (design-v0.2.md#implementation-task-a2), so the anchor point stays where it was: a front-left
 * anchored rectangle becomes a circle in the same front-left corner, as a size edit would.
 */
export function shapeKindArgs(
  shape: Exclude<OperationShapeDTO, { kind: 'named' }>,
  kind: 'rectangle' | 'circle',
): Record<string, unknown> {
  const center = [src(shape.center[0]), src(shape.center[1])]
  if (kind === 'circle')
    return {
      kind: 'circle',
      center,
      diameter: shape.kind === 'circle' ? src(shape.diameter) : src(shape.width),
    }
  const size = shape.kind === 'circle' ? src(shape.diameter) : src(shape.length)
  return { kind: 'rectangle', center, length: size, width: size }
}

// ── new operations ────────────────────────────────────────────────────────────────────────

/** A round length in the unit system, as a number in its unit: whole millimetres, quarter inches. */
function roundValue(mm: number, units: UnitSystem): number {
  return units === 'mm'
    ? Math.max(1, Math.round(mm))
    : Math.max(0.25, Math.round((mm / 25.4) * 4) / 4)
}

const lengthSource = (n: number, units: UnitSystem): string =>
  units === 'mm' ? `${+n.toFixed(4)} mm` : `${+n.toFixed(4)}"`

/** A round length in the unit system: whole millimetres, quarter inches. */
export function roundLength(mm: number, units: UnitSystem): string {
  return lengthSource(roundValue(mm, units), units)
}

const SMALL: Record<UnitSystem, { slot: number; hole: string }> = {
  mm: { slot: 6, hole: '6 mm' },
  inch: { slot: 6.35, hole: '1/4"' },
}

const ANCHOR_SIGN = { min: -1, centre: 0, max: 1 } as const

/**
 * A new shape around the round centre `[cx, cy]` (mm) with the round size `[sx, sy]` (mm),
 * positioned by `anchor`: its `center` is the anchor point, so the shape lands in the same place
 * whatever the default anchor is.
 */
function anchoredRectangle(
  c: readonly [number, number],
  size: readonly [number, number],
  anchor: AnchorDTO,
  units: UnitSystem,
): Record<string, unknown> {
  const [cx, cy] = c.map((v) => roundValue(v, units)) as [number, number]
  const [sx, sy] = size.map((v) => roundValue(v, units)) as [number, number]
  return {
    kind: 'rectangle',
    center: [
      lengthSource(cx + (ANCHOR_SIGN[anchor.u] * sx) / 2, units),
      lengthSource(cy + (ANCHOR_SIGN[anchor.v] * sy) / 2, units),
    ],
    length: lengthSource(sx, units),
    width: lengthSource(sy, units),
  }
}

const CENTRE: AnchorDTO = { u: 'centre', v: 'centre' }

/**
 * Args of a new operation inside the stock (`length` × `width` × `thickness`, mm): facing takes
 * the defaults; a pocket in the middle, a through hole off its corner, an outside profile around
 * them. A pocket or profile is placed by `anchor` (the default-anchor setting, which the window
 * passes as `anchor`, design-v0.2.md#placement-anchors). The user edits them in the inspector
 * right after.
 */
export function addArgs(
  kind: OperationKind,
  stock: { length: number; width: number; thickness: number },
  units: UnitSystem,
  anchor: AnchorDTO = CENTRE,
): Record<string, unknown> {
  const L = (mm: number) => roundLength(mm, units)
  const { length: x, width: y, thickness: t } = stock
  switch (kind) {
    case 'facing':
      return {}
    case 'pocket':
      return {
        shape: anchoredRectangle([x / 2, y / 2], [x / 3, y / 3], anchor, units),
        anchor,
        depth: L(t / 4),
      }
    case 'drilling':
      return { center: [L(x / 4), L(y / 3)], diameter: SMALL[units].hole }
    case 'profile': {
      const inset = 4 * SMALL[units].slot
      return {
        shape: anchoredRectangle(
          [x / 2, y / 2],
          [x > 2 * inset ? x - inset : x / 2, y > 2 * inset ? y - inset : y / 2],
          anchor,
          units,
        ),
        anchor,
      }
    }
    case 'chamfer':
      // needs an edge: added from a drilling, circle pocket or inside circle profile (inspector, task U4)
      return {}
    case 'line':
      // its paths are the part's shapes (useAddOperation picks or makes one)
      return {}
  }
}

/**
 * The open path a new Line grooves when the part has no shape yet: an S of two half circles,
 * half the room's length wide (engraved-patterns.md § UI).
 */
export function lineWave(
  room: { length: number; width: number },
  units: UnitSystem,
): Record<string, unknown> {
  const L = (mm: number) => roundLength(mm, units)
  const w = Math.min(room.length / 2, room.width)
  return {
    kind: 'path',
    op: 'add',
    closed: false,
    start: ['0', '0'],
    segments: [
      { kind: 'arc', to: [L(w / 2), '0'], radius: L(w / 4), cw: true },
      { kind: 'arc', to: [L(w), '0'], radius: L(w / 4), cw: false },
    ],
  }
}

// ── surfaces ──────────────────────────────────────────────────────────────────────────────

export interface SurfaceChoice {
  readonly id: string
  /** "Facing 1 floor", "Stock top". */
  readonly label: string
  readonly direction: Direction
  /** The direction's group in the `on` dropdown ("Top", "Right side"). */
  readonly group: string
}

/**
 * The readable name of an operation or feature id ("Pocket 1", "Hole 2", "Stock"); never the id
 * (ui.md § Selection and picking: visible text shows no internal ids). An id the part no longer
 * has (a stale finding) reads "Unknown operation".
 */
export function itemName(part: PartDTO, id: string): string {
  if (id === 'stock') return m.stockName
  return (
    part.operations.find((o) => o.id === id)?.name ??
    part.features?.find((f) => f.id === id)?.name ??
    m.unknownOperation
  )
}

/** The readable names a DFM finding's text uses for the ids in its params (DF43). */
export const dfmNames = (part: PartDTO): DfmNames => ({
  item: (id) => itemName(part, id),
  surface: (id) => surfaceLabel(part, id),
})

/** Human name of a surface id from the part's operation names ("Pocket 1 floor", "Stock top"). */
export function surfaceLabel(part: PartDTO, id: string): string {
  const dot = id.indexOf('.')
  const owner = dot < 0 ? id : id.slice(0, dot)
  const role = dot < 0 ? '' : id.slice(dot + 1)
  const tab = /^tab\[(\d+)\]\.top$/.exec(role)
  const roleText = tab
    ? m.surfaceRoles.tabTop(Number(tab[1]))
    : (((m.surfaceRoles as Record<string, unknown>)[role] as string | undefined) ??
      m.surfaceRoles.unknown)
  return m.surfaceLabel(itemName(part, owner), roleText)
}

const choice = (part: PartDTO, e: SurfaceEntry): SurfaceChoice => ({
  id: e.id,
  label: surfaceLabel(part, e.id),
  direction: e.direction,
  group: m.inspector.directions[e.direction],
})

const ownerOfSurface = (id: string): string => id.split('.')[0] ?? id

/**
 * Two surfaces of operations that share a name read the same: each such label gets its owner's
 * place in the design order ("Pocket floor (operation 3)"), never the id (DF43).
 */
function disambiguate<T extends { readonly label: string }>(
  part: PartDTO,
  items: readonly T[],
  surface: (item: T) => string,
): T[] {
  const counts = new Map<string, number>()
  for (const c of items) counts.set(c.label, (counts.get(c.label) ?? 0) + 1)
  return items.map((c) => {
    if ((counts.get(c.label) ?? 0) < 2) return c
    const index = part.operations.findIndex((o) => o.id === ownerOfSurface(surface(c)))
    return index < 0 ? c : { ...c, label: m.surfaceAt(c.label, index + 1) }
  })
}

const byDirection = (a: SurfaceChoice, b: SurfaceChoice) =>
  DIRECTIONS.indexOf(a.direction) - DIRECTIONS.indexOf(b.direction)

/**
 * The face targets an operation of `kind` at `index` may start from (design-v0.2.md#face-targets):
 * a facing or profile any stock face, a pocket or drilling also the floors and tab tops of earlier
 * operations, in every direction. Grouped by direction in the order Top, Bottom, Front, Right,
 * Back, Left (ui.md#design-and-plan-controls-v02), stock face first, then in design order.
 */
export function onChoices(
  part: PartDTO,
  table: SurfaceTable,
  index: number,
  kind: OperationKind,
): SurfaceChoice[] {
  const stockOnly = kind === 'facing' || kind === 'profile'
  const choices = table
    .before(index)
    .filter((e) => (stockOnly ? STOCK_FACES.includes(e.id) : e.onTarget))
    .map((e) => choice(part, e))
    .toSorted(byDirection)
  return disambiguate(part, choices, (c) => c.id)
}

export interface ReferenceChoice {
  /** The formula name: the part-frame coordinate on the face's normal axis (`stock.side[1].x`). */
  readonly id: string
  readonly surface: string
  readonly label: string
}

/** Face positions a formula of an operation at `index` may reference, every direction. */
export function referenceChoices(
  part: PartDTO,
  table: SurfaceTable,
  index: number,
): ReferenceChoice[] {
  const choices = table
    .before(index)
    .toSorted((a, b) => DIRECTIONS.indexOf(a.direction) - DIRECTIONS.indexOf(b.direction))
    .map((e) => ({ id: coordinateName(e), surface: e.id, label: surfaceLabel(part, e.id) }))
  return disambiguate(part, choices, (c) => c.surface)
}

/** The direction of a surface (the stock top when unknown). */
export function surfaceDirection(table: SurfaceTable | undefined, id: string): Direction {
  return table?.get(id).mapOr<Direction>('+z', (e) => e.direction) ?? '+z'
}

/**
 * Names of the face frame's axes in field labels: X and Y on the top face (where they are the
 * part axes), `u` and `v` elsewhere (design-v0.2.md#face-frame).
 */
export function axisNames(direction: Direction): { u: string; v: string } {
  return direction === '+z' ? { u: 'X', v: 'Y' } : { u: 'u', v: 'v' }
}

/** True if a stored coordinate is a formula (the anchor picker is then disabled). */
/** `design.warning.list` marks a check against an unlocked tool that Apply may change (P2). */
export const pendingApply = (w: DfmWarning): boolean =>
  (w as DfmWarning & { pendingApply?: boolean }).pendingApply === true

export function isFormula(dto: QuantityDTO): boolean {
  const q = quantityOf(dto)
  return q !== undefined && isExpression(q)
}

/** The operation an evaluation error names (an issue path or frame data), if any. */
export function failingOperation(
  error: {
    issues: readonly { path: readonly (string | number)[] }[]
    frames: readonly { data?: Readonly<Record<string, unknown>> }[]
  },
  operationIds: readonly string[],
): string | undefined {
  const ids = new Set(operationIds)
  for (const i of error.issues)
    for (const seg of i.path) if (ids.has(String(seg))) return String(seg)
  for (const f of error.frames)
    for (const v of Object.values(f.data ?? {})) if (typeof v === 'string' && ids.has(v)) return v
  return undefined
}
