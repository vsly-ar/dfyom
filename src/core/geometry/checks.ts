/**
 * Geometry checks of a composed part, run in the worker after composition, in table order:
 * pieces and `dfm.loosePiece`, `dfm.retainedRemoved`, `dfm.surfaceMissing`.
 * Doc: docs/architecture/geometry.md#evaluation-checks
 *
 * The two error checks (`status`, `airSurface`) stay in `evaluate.ts`; parameter and tool checks
 * are synchronous (`dfm.ts`).
 */
import { Err, Ok, type AppResult } from '../../shared/result'
import {
  EPSILON,
  EPSILON_VOLUME,
  type DfmWarning,
  type SurfaceId,
  type SurfaceReference,
  type Vec3,
} from './model'
import type { NominalRegion, OperationSolids, PlacedMesh } from './operations'
import type { Solid, SolidPort } from './solid-port'
import { noSteps, type Steps } from '../workers/steps'

/** Axis-aligned box in the part frame. */
export interface Box {
  readonly min: Vec3
  readonly max: Vec3
}

/** One operation after composition: its solids, its net solid and where it can reach. */
export interface ComposedOperation {
  readonly op: OperationSolids
  readonly originalId: number
  /** (∪ removal − ∪ cut) − ∪ retained, in the part frame. */
  readonly solid: Solid
  /** Bounds of its removal meshes (incl. overshoot). */
  readonly box: Box
}

export interface CheckInput {
  readonly part: Solid
  /** Every operation in input order (not the stock). */
  readonly operations: readonly ComposedOperation[]
  /** original id → operation (incl. the stock), as used for surface mapping. */
  readonly tables: ReadonlyMap<number, OperationSolids>
  /** Surface ids that have triangles. */
  readonly surfaces: readonly SurfaceId[]
  readonly references: readonly SurfaceReference[]
}

export interface CheckResult {
  /** Pieces of volume > ε_V (0 when nothing is left). */
  readonly pieces: number
  readonly warnings: readonly DfmWarning[]
}

const mm3 = (v: number): string => `${v.toFixed(1)} mm³`

/** `steps.step()` after each piece's `toMesh` and each `retainedRemoved` pair. */
export function geometryChecks(
  input: CheckInput,
  solids: SolidPort,
  steps: Steps = noSteps,
): AppResult<CheckResult> {
  const pieces = loosePieces(input, solids, steps)
  if (pieces.isErr()) return Err(pieces.unwrapErr())
  const removed = retainedRemoved(input, solids, steps)
  if (removed.isErr()) return Err(removed.unwrapErr())
  const { count, warnings } = pieces.unwrap()
  return Ok({
    pieces: count,
    warnings: [...warnings, ...removed.unwrap(), ...surfaceMissing(input)],
  })
}

/** Bounds of meshes placed in the part frame. */
export function boxOf(meshes: readonly PlacedMesh[]): Box {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const { mesh, at } of meshes) {
    const p = mesh.positions
    for (let i = 0; i < p.length; i += 3)
      for (let a = 0; a < 3; a++) {
        const v = p[i + a]! + at[a]!
        if (v < min[a]!) min[a] = v
        if (v > max[a]!) max[a] = v
      }
  }
  return { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] }
}

const overlaps = (a: Box, b: Box): boolean =>
  [0, 1, 2].every((k) => Math.min(a.max[k]!, b.max[k]!) - Math.max(a.min[k]!, b.min[k]!) > EPSILON)

interface Piece {
  readonly solid: Solid
  readonly volume: number
  /** Operation ids whose surfaces bound it (not the stock), in operation order. */
  readonly operations: readonly string[]
  /** Bounded by a profile's `offcut` surface: waste, not the part. */
  readonly offcut: boolean
}

/** Profiles are the only operations with an `offcut` surface. */
const isProfile = (op: OperationSolids): boolean => op.surfaces.includes('offcut')

/**
 * `decompose()` into pieces > ε_V. A piece is waste when it is bounded by a profile's `offcut`
 * surface and by no profile's shape side (wall, corner, tab). The part is the largest piece
 * that is not waste (the largest piece if all are); every other piece gets `dfm.loosePiece`.
 */
function loosePieces(
  input: CheckInput,
  solids: SolidPort,
  steps: Steps,
): AppResult<{ count: number; warnings: DfmWarning[] }> {
  const parts = solids.decompose(input.part)
  if (parts.isErr()) return Err(parts.unwrapErr())
  const sized: { solid: Solid; volume: number }[] = []
  for (const solid of parts.unwrap()) {
    const v = solids.volume(solid)
    if (v.isErr()) return Err(v.unwrapErr())
    if (v.unwrap() > EPSILON_VOLUME) sized.push({ solid, volume: v.unwrap() })
  }
  if (sized.length <= 1) return Ok({ count: sized.length, warnings: [] })

  const order = new Map(input.operations.map((c, i) => [c.op, i]))
  const pieces: Piece[] = []
  for (const { solid, volume } of sized) {
    const mesh = solids.toMesh(solid)
    if (mesh.isErr()) return Err(mesh.unwrapErr())
    const step = steps.step()
    if (step.isErr()) return Err(step.unwrapErr())
    const m = mesh.unwrap()
    const bounding = new Set<OperationSolids>()
    let offcutSide = false
    let shapeSide = false
    for (let t = 0; t < m.triangleFace.length; t++) {
      const op = input.tables.get(m.triangleOriginal[t]!)
      if (op === undefined || !order.has(op)) continue // the stock
      bounding.add(op)
      if (!isProfile(op)) continue
      const role = op.surfaces[m.triangleFace[t]!]!
      if (role === 'offcut') offcutSide = true
      else shapeSide = true // wall, corner or tab: the part's side of a profile
    }
    const operations = [...bounding].sort((a, b) => order.get(a)! - order.get(b)!).map((o) => o.id)
    // tabs join a held part to its offcut, so a piece with both sides is never waste
    pieces.push({ solid, volume, operations, offcut: offcutSide && !shapeSide })
  }
  const largest = (ps: readonly Piece[]): Piece | undefined =>
    ps.reduce<Piece | undefined>(
      (best, p) => (best && best.volume >= p.volume ? best : p),
      undefined,
    )
  const part = largest(pieces.filter((p) => !p.offcut)) ?? largest(pieces)!

  const profiles = new Set(input.operations.filter((c) => isProfile(c.op)).map((c) => c.op.id))
  const warnings = pieces
    .filter((p) => p !== part)
    .map((p): DfmWarning => {
      const operation = p.operations.find((id) => profiles.has(id)) ?? p.operations[0] ?? 'stock'
      const what = p.offcut ? 'an offcut' : 'a piece of the part'
      return {
        code: 'dfm.loosePiece',
        severity: 'warning',
        message:
          `${operation}: ${what} (${mm3(p.volume)}) is not held and comes loose; ` +
          (p.offcut ? 'add tabs or make them thicker' : 'check the cut that separates it'),
        operation,
        parameter: 'tabs',
        params: { volume: p.volume, offcut: p.offcut, operations: p.operations },
      }
    })
  return Ok({ count: pieces.length, warnings })
}

/**
 * Nominal retained region ∩ another operation's net solid > ε_V; one warning per
 * (retaining operation, removing operation). Boxes skip pairs that cannot meet.
 */
function retainedRemoved(
  input: CheckInput,
  solids: SolidPort,
  steps: Steps,
): AppResult<DfmWarning[]> {
  type Hit = { regions: string[]; parameter: string; volume: number }
  const all = new Map<ComposedOperation, Map<ComposedOperation, Hit>>()
  for (const a of input.operations) {
    const hits = new Map<ComposedOperation, Hit>()
    all.set(a, hits)
    for (const region of a.op.nominal) {
      const box = boxOf([region.mesh])
      const others = input.operations.filter(
        (b) => b !== a && overlaps(box, b.box) && !clearOf(region, b.box),
      )
      if (others.length === 0) continue
      const solid = placed(region, a.originalId, solids)
      if (solid.isErr()) return Err(solid.unwrapErr())
      for (const b of others) {
        const v = removedVolume(
          solid.unwrap(),
          b.solid,
          region.minusRemoval ? a.solid : undefined,
          solids,
        )
        if (v.isErr()) return Err(v.unwrapErr())
        const step = steps.step()
        if (step.isErr()) return Err(step.unwrapErr())
        if (v.unwrap() <= EPSILON_VOLUME) continue
        const hit = hits.get(b) ?? { regions: [], parameter: region.parameter, volume: 0 }
        hit.regions.push(region.region)
        hit.volume += v.unwrap()
        hits.set(b, hit)
      }
    }
  }
  // operations that cut each other's retained regions (pockets merged on purpose): report
  // only the later one in design order as the remover
  const rank = new Map(input.operations.map((c, i) => [c, i]))
  const warnings: DfmWarning[] = []
  for (const [a, hits] of all)
    for (const [b, hit] of hits) {
      if (all.get(b)?.has(a) === true && rank.get(b)! < rank.get(a)!) continue
      warnings.push({
        code: 'dfm.retainedRemoved',
        severity: 'warning',
        message:
          `${b.op.id} cuts away ${hit.regions.join(', ')} of ${a.op.id} (${mm3(hit.volume)}); ` +
          `move one of them`,
        operation: a.op.id,
        parameter: hit.parameter,
        params: { by: b.op.id, regions: hit.regions, volume: hit.volume },
      })
    }
  return Ok(warnings)
}

/**
 * A removal whose bounds lie, in XY, inside the region's `clearInside` shape (a pocket contour
 * inset by its fillet radius) cannot reach the region: no booleans needed.
 */
function clearOf(region: NominalRegion, box: Box): boolean {
  const shape = region.clearInside
  if (shape === undefined) return false
  const inside = (x: number, y: number): boolean => {
    const dx = Math.abs(x - shape.center[0])
    const dy = Math.abs(y - shape.center[1])
    const c = shape.contour
    if (c.kind === 'circle') return Math.hypot(dx, dy) <= c.radius
    const hx = c.length / 2
    const hy = c.width / 2
    if (dx > hx || dy > hy) return false
    const cx = hx - c.cornerRadius
    const cy = hy - c.cornerRadius
    return dx <= cx || dy <= cy || Math.hypot(dx - cx, dy - cy) <= c.cornerRadius
  }
  // the shape is convex: the box is inside when its four corners are
  return [box.min[0], box.max[0]].every((x) => [box.min[1], box.max[1]].every((y) => inside(x, y)))
}

function placed(region: NominalRegion, originalId: number, solids: SolidPort): AppResult<Solid> {
  return solids
    .fromMesh(region.mesh.mesh, originalId)
    .andThen((s) => solids.translate(s, region.mesh.at))
}

/** vol(region ∩ other), minus the retaining operation's own removal when given. */
function removedVolume(
  region: Solid,
  other: Solid,
  own: Solid | undefined,
  solids: SolidPort,
): AppResult<number> {
  return solids.intersect(region, other).andThen((cut) =>
    solids.volume(cut).andThen((v) => {
      if (own === undefined || v <= EPSILON_VOLUME) return Ok(v)
      return solids.subtract(cut, own).andThen((rest) => solids.volume(rest))
    }),
  )
}

/** A surface referenced by `on` or an expression has no triangles. */
function surfaceMissing(input: CheckInput): DfmWarning[] {
  const present = new Set(input.surfaces)
  return input.references
    .filter((r) => !present.has(r.surface))
    .map((r) => ({
      code: 'dfm.surfaceMissing',
      severity: 'warning',
      message: `${r.operation}.${r.parameter} refers to ${r.surface}, which the part no longer has; pick another surface`,
      operation: r.operation,
      parameter: r.parameter,
      params: { surface: r.surface },
    }))
}
