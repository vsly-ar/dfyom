// Design mode's view of the document (task 3.6), pure: the part with its models (core `loadPart`,
// the surface table), the parameters' sources, the update args of one field edit, the defaults
// of a new operation and the surfaces a field may reference or pick. Commands do the checking;
// this only builds what the UI shows and sends. Doc: docs/modes/design.md#commands-and-queries-v01,
// docs/conventions/ui.md#panels-and-inspectors
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

export interface DesignPart {
  readonly doc: ProjectDoc
  readonly units: UnitSystem
  readonly dto: PartDTO
  /** Models of the part and its stock; undefined if the record does not load. */
  readonly loaded: LoadedPart | undefined
  readonly table: SurfaceTable | undefined
}

const cache = new WeakMap<ProjectDoc, DesignPart | null>()

/** The project's part (one per project in v0.1), memoized per immutable document. */
export function designPart(doc: ProjectDoc): DesignPart | undefined {
  const hit = cache.get(doc)
  if (hit !== undefined) return hit ?? undefined
  const dto = Object.values(doc.parts)[0]
  if (dto === undefined) {
    cache.set(doc, null)
    return undefined
  }
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
  cache.set(doc, part)
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
  return { [head]: source }
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
      // needs an edge: added from a drilling or circle pocket (inspector, task U4)
      return {}
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

/** Human name of a surface id from the part's operation names. */
export function surfaceLabel(part: PartDTO, id: string): string {
  const dot = id.indexOf('.')
  const owner = id.slice(0, dot)
  const role = id.slice(dot + 1)
  const tab = /^tab\[(\d+)\]\.top$/.exec(role)
  const roleText = tab
    ? m.surfaceRoles.tabTop(Number(tab[1]))
    : (((m.surfaceRoles as Record<string, unknown>)[role] as string | undefined) ?? role)
  const name =
    owner === 'stock' ? m.stockName : (part.operations.find((o) => o.id === owner)?.name ?? owner)
  return m.surfaceLabel(name, roleText)
}

const choice = (part: PartDTO, e: SurfaceEntry): SurfaceChoice => ({
  id: e.id,
  label: surfaceLabel(part, e.id),
  direction: e.direction,
  group: m.inspector.directions[e.direction],
})

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
  return table
    .before(index)
    .filter((e) => (stockOnly ? STOCK_FACES.includes(e.id) : e.onTarget))
    .map((e) => choice(part, e))
    .toSorted(byDirection)
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
  return table
    .before(index)
    .toSorted((a, b) => DIRECTIONS.indexOf(a.direction) - DIRECTIONS.indexOf(b.direction))
    .map((e) => ({ id: coordinateName(e), surface: e.id, label: surfaceLabel(part, e.id) }))
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
