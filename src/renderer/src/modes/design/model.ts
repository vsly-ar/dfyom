// Design mode's view of the document (task 3.6), pure: the part with its models (core `loadPart`,
// the surface table), the parameters' sources, the update args of one field edit, the defaults
// of a new operation and the surfaces a field may reference or pick. Commands do the checking;
// this only builds what the UI shows and sends. Doc: docs/modes/design.md#commands-and-queries-v01,
// docs/conventions/ui.md#panels-and-inspectors
import { loadPart, type LoadedPart } from '../../../../core/design/load'
import { fieldContext, type FieldKind } from '../../../../core/design/operation'
import type {
  OperationDTO,
  OperationKind,
  PartDTO,
  ShapeDTO,
} from '../../../../core/design/part.dto'
import { SurfaceTable, type SurfaceEntry } from '../../../../core/design/surfaces'
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
export function shapeArgs(shape: ShapeDTO): Record<string, unknown> {
  const center = [src(shape.center[0]), src(shape.center[1])]
  return shape.kind === 'rectangle'
    ? {
        kind: 'rectangle',
        center,
        length: src(shape.length),
        width: src(shape.width),
        cornerRadius: src(shape.cornerRadius),
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

/** Rectangle ↔ circle: the new shape keeps the center and takes its size from the old one. */
export function shapeKindArgs(shape: ShapeDTO, kind: ShapeDTO['kind']): Record<string, unknown> {
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

/** A round length in the unit system: whole millimetres, quarter inches. */
export function roundLength(mm: number, units: UnitSystem): string {
  if (units === 'mm') return `${Math.max(1, Math.round(mm))} mm`
  return `${Math.max(0.25, Math.round((mm / 25.4) * 4) / 4)}"`
}

const SMALL: Record<UnitSystem, { slot: number; hole: string }> = {
  mm: { slot: 6, hole: '6 mm' },
  inch: { slot: 6.35, hole: '1/4"' },
}

/**
 * Args of a new operation inside the stock (`length` × `width` × `thickness`, mm): facing takes
 * the defaults; a pocket in the middle, a through hole off its corner, an outside profile around
 * them. The user edits them in the inspector right after.
 */
export function addArgs(
  kind: OperationKind,
  stock: { length: number; width: number; thickness: number },
  units: UnitSystem,
): Record<string, unknown> {
  const L = (mm: number) => roundLength(mm, units)
  const { length: x, width: y, thickness: t } = stock
  switch (kind) {
    case 'facing':
      return {}
    case 'pocket':
      return {
        shape: {
          kind: 'rectangle',
          center: [L(x / 2), L(y / 2)],
          length: L(x / 3),
          width: L(y / 3),
        },
        depth: L(t / 4),
      }
    case 'drilling':
      return { center: [L(x / 4), L(y / 3)], diameter: SMALL[units].hole }
    case 'profile': {
      const inset = 4 * SMALL[units].slot
      return {
        shape: {
          kind: 'rectangle',
          center: [L(x / 2), L(y / 2)],
          length: L(x > 2 * inset ? x - inset : x / 2),
          width: L(y > 2 * inset ? y - inset : y / 2),
        },
      }
    }
  }
}

// ── surfaces ──────────────────────────────────────────────────────────────────────────────

export interface SurfaceChoice {
  readonly id: string
  /** "Facing 1 floor", "Stock top". */
  readonly label: string
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

/** Horizontal surfaces an operation at `index` may use: `on` targets only, or all (formulas). */
export function surfaceChoices(
  part: PartDTO,
  table: SurfaceTable,
  index: number,
  onTargets: boolean,
): SurfaceChoice[] {
  return table
    .before(index)
    .filter((e: SurfaceEntry) => !onTargets || e.onTarget)
    .map((e) => ({ id: e.id, label: surfaceLabel(part, e.id) }))
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
