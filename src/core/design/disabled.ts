/**
 * Disabled operations and features (hardening DF106): which items of a part are switched off,
 * directly (`PartDTO.disabled`, or a plan's own list) or because they depend on a switched-off
 * one, and the part as evaluation, DFM, split pieces and Plan see it: without them.
 * Works on DTOs only (no parsing), so it is cheap and the same in core and renderer.
 * Doc: docs/modes/design.md#disabling-operations-and-features-df106
 */
import type { Issue } from '../../shared/errors/app-error'
import type { FeatureDTO } from './feature.dto'
import type { OperationDTO, PartDTO } from './part.dto'

/** The effective state of a part's items: what is off, and the units the user switched off. */
export interface DisabledState {
  /** Operation ids that are off (switched off, owned by or nested in an off unit, or dependent). */
  readonly operations: ReadonlySet<string>
  /** Feature ids that are off (switched off, nested in an off Clones, or dependent). */
  readonly features: ReadonlySet<string>
  /** The units (top-level operation or feature ids) switched off directly; existing ones only. */
  readonly roots: ReadonlySet<string>
  /** The units that are off only because they depend on an off item (`roots` excluded). */
  readonly dependants: ReadonlySet<string>
}

const EMPTY: DisabledState = {
  operations: new Set(),
  features: new Set(),
  roots: new Set(),
  dependants: new Set(),
}

/** The operation id a surface id belongs to (`hole1_counterbore.floor` → `hole1_counterbore`). */
export const operationOfSurface = (surface: string): string => surface.split(/[.[]/, 1)[0]!

/** The Clones source members of a feature record (any stored form), else undefined. */
function cloneMembers(f: FeatureDTO): { features: string[]; operations: string[] } | undefined {
  if (f.kind !== 'clones') return undefined
  const s = (f as Record<string, unknown>)['source']
  if (typeof s !== 'object' || s === null) return undefined
  const src = s as { featureId?: unknown; featureIds?: unknown; operationIds?: unknown }
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  return {
    features: typeof src.featureId === 'string' ? [src.featureId] : strings(src.featureIds),
    operations: strings(src.operationIds),
  }
}

/** Every identifier written before a `.` in the record's quantity sources (expression references). */
function sourceReferences(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) sourceReferences(v, out)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [k, v] of Object.entries(value)) {
    if (k === 'source' && typeof v === 'string') {
      for (const m of v.matchAll(/([a-z][A-Za-z0-9_]*)(?:\[\d+\])?\./g)) out.add(m[1]!)
    } else if (typeof v === 'object') sourceReferences(v, out)
  }
}

/** The operation ids an operation record depends on: `on`, a chamfer's edge, expression references. */
function operationDependencies(op: OperationDTO): Set<string> {
  const out = new Set<string>()
  if ('on' in op && typeof op.on === 'string') out.add(operationOfSurface(op.on))
  if (op.kind === 'chamfer') out.add(op.edgeOf)
  sourceReferences(op, out)
  return out
}

/**
 * The effective disabled state of `part` with its own list plus `extra` (a plan's own list).
 * One pass in design order suffices: references only go to earlier operations, and a unit's
 * operations are contiguous, so whatever depends on a unit comes after all of it.
 */
export function disabledState(part: PartDTO, extra: readonly string[] = []): DisabledState {
  const listed = [...(part.disabled ?? []), ...extra]
  if (listed.length === 0) return EMPTY
  const features = part.features ?? []
  const featureById = new Map(features.map((f) => [f.id, f]))
  const unitOf = unitResolver(features)
  const opUnit = (op: OperationDTO) => unitOf(op.featureId ?? op.id)
  const opIds = new Set(part.operations.map((o) => o.id))
  const roots = new Set<string>()
  for (const id of listed)
    if (opIds.has(id) || featureById.has(id)) roots.add(unitOf(opIdOwner(part, id) ?? id))
  if (roots.size === 0) return EMPTY
  const off = new Set(roots)
  const offOps = new Set<string>()
  // owned shapes of an off feature: operations placing them depend on it
  const shapeOwner = new Map(
    (part.shapes ?? []).flatMap((s) => (s.owner === undefined ? [] : [[s.id, s.owner] as const])),
  )
  for (const op of part.operations) {
    const unit = opUnit(op)
    if (!off.has(unit)) {
      const deps = operationDependencies(op)
      const feature = op.featureId === undefined ? undefined : featureById.get(op.featureId)
      if (feature !== undefined) {
        deps.add(operationOfSurface(feature.on))
        sourceReferences(feature, deps)
      }
      const placed = 'shape' in op && op.shape.kind === 'named' ? op.shape.shapeId : undefined
      const owner = placed === undefined ? undefined : shapeOwner.get(placed)
      if ([...deps].some((d) => offOps.has(d)) || (owner !== undefined && off.has(unitOf(owner))))
        off.add(unit)
    }
    if (off.has(unit)) offOps.add(op.id)
  }
  // features owning no operation (a Clones with every position skipped): by their face
  for (const f of features)
    if (!off.has(unitOf(f.id)) && offOps.has(operationOfSurface(f.on))) off.add(unitOf(f.id))
  const offFeatures = new Set(features.filter((f) => off.has(unitOf(f.id))).map((f) => f.id))
  for (const op of part.operations) if (off.has(opUnit(op))) offOps.add(op.id)
  return {
    operations: offOps,
    features: offFeatures,
    roots,
    dependants: new Set([...off].filter((u) => !roots.has(u))),
  }
}

/**
 * The top-level unit of a feature or plain operation id: itself, or the outermost Clones nesting
 * it (its source, F5; an inner Clones is itself a member of the outer one, Clones v2).
 */
function unitResolver(features: readonly FeatureDTO[]): (id: string) => string {
  const nestedIn = new Map<string, string>()
  for (const f of features) {
    const m = cloneMembers(f)
    if (m === undefined) continue
    for (const id of [...m.features, ...m.operations])
      if (id !== f.id && !nestedIn.has(id)) nestedIn.set(id, f.id)
  }
  return (id) => {
    let u = id
    for (let i = 0; i < 4; i++) {
      const outer = nestedIn.get(u)
      if (outer === undefined) break
      u = outer
    }
    return u
  }
}

/** The top-level units of a part in design order: plain operations and outermost features. */
export function topLevelUnits(part: PartDTO): string[] {
  const unitOf = unitResolver(part.features ?? [])
  const out: string[] = []
  for (const op of part.operations) {
    const u = unitOf(op.featureId ?? op.id)
    if (!out.includes(u)) out.push(u)
  }
  // features owning no operation (every Clones position skipped, an empty pattern)
  for (const f of part.features ?? [])
    if (unitOf(f.id) === f.id && !out.includes(f.id)) out.push(f.id)
  return out
}

/**
 * A new disabled list for `part`: `ids` checked and put in design order. Unknown ids are
 * `unknownItem` issues, an owned or nested item `insideFeature` (switch its feature off instead,
 * or use the feature's own toggles), both at `[path, index]`.
 */
export function checkDisabledList(
  part: PartDTO,
  ids: readonly string[],
  path: string,
): { list: string[]; issues: Issue[] } {
  const units = topLevelUnits(part)
  const unitOf = unitResolver(part.features ?? [])
  const known = new Set([
    ...part.operations.map((o) => o.id),
    ...(part.features ?? []).map((f) => f.id),
  ])
  const issues: Issue[] = []
  ids.forEach((id, i) => {
    if (!known.has(id))
      issues.push({
        path: [path, i],
        rule: 'unknownItem',
        message: `${id} is no operation or feature of the part`,
        params: { id },
      })
    else if (!units.includes(id)) {
      const owner = unitOf(opIdOwner(part, id) ?? id)
      issues.push({
        path: [path, i],
        rule: 'insideFeature',
        message: `${id} is part of ${owner}: switch ${owner} off, or use its own options`,
        params: { id, featureId: owner },
      })
    }
  })
  const set = new Set(ids)
  return { list: units.filter((u) => set.has(u)), issues }
}

/** The feature owning operation `id`, if it is an owned operation. */
function opIdOwner(part: PartDTO, id: string): string | undefined {
  return part.operations.find((o) => o.id === id)?.featureId
}

/**
 * The part without its disabled items (and without the `disabled` list): what evaluation, DFM,
 * split pieces and plan snapshots read. The same object when nothing is disabled, so every
 * consumer of a part with nothing disabled is byte-identical to before DF106.
 */
export function enabledPart(part: PartDTO, extra: readonly string[] = []): PartDTO {
  if (part.disabled === undefined && extra.length === 0) return part
  const state = disabledState(part, extra)
  const { disabled: _, ...rest } = part
  if (state.operations.size === 0 && state.features.size === 0) return rest
  const features = part.features?.filter((f) => !state.features.has(f.id))
  const shapes = part.shapes?.filter((s) => s.owner === undefined || !state.features.has(s.owner))
  const out: PartDTO = {
    ...rest,
    operations: part.operations.filter((o) => !state.operations.has(o.id)),
  }
  if (features !== undefined) {
    if (features.length > 0) out.features = features
    else delete out.features
  }
  if (shapes !== undefined) {
    if (shapes.length > 0) out.shapes = shapes
    else delete out.shapes
  }
  return out
}

/** Whether item `id` (an operation or feature) is off in `state`. */
export const isDisabled = (state: DisabledState, id: string): boolean =>
  state.operations.has(id) || state.features.has(id)

/**
 * `warnings` without those of disabled items (a warning names its operation, or a feature for
 * span warnings): a switched-off item is not checked (DF106). The same array when nothing is off.
 */
export function dropDisabledWarnings<W extends { readonly operation: string }>(
  warnings: W[],
  part: PartDTO,
): W[] {
  if (part.disabled === undefined) return warnings
  const state = disabledState(part)
  return warnings.filter((w) => !isDisabled(state, w.operation))
}
