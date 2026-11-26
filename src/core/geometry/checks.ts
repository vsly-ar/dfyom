/**
 * Geometry checks of a composed part, run in the worker after composition, in table order:
 * pieces and `dfm.loosePiece`, `dfm.retainedRemoved` (then `dfm.surfaceCutAway` in
 * `construction.ts`).
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
  type Vec3,
  unapplyPlacement,
  type Placement,
} from './model'
import type { NominalRegion, OperationSolids } from './operations'
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
    warnings: [...warnings, ...removed.unwrap()],
  })
}

/** Bounds of meshes placed in the part frame. */
export function boxOf(
  meshes: readonly { readonly mesh: { readonly positions: ArrayLike<number> } }[],
): Box {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const { mesh } of meshes) {
    const p = mesh.positions
    for (let i = 0; i < p.length; i += 3)
      for (let a = 0; a < 3; a++) {
        const q = p[i + a]!
        if (q < min[a]!) min[a] = q
        if (q > max[a]!) max[a] = q
      }
  }
  return { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] }
}

/** A part-frame box seen in the local frame of `t` (axis rotations map boxes to boxes). */
function boxIn(t: Placement, box: Box): Box {
  const a = unapplyPlacement(t, box.min)
  const b = unapplyPlacement(t, box.max)
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  }
}

/** The boxes share more than ε along every axis. */
export const boxesOverlap = (a: Box, b: Box): boolean =>
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
 * (retaining operation, removing operation). Boxes skip pairs that cannot meet. For tabs the
 * warning says what remains (D4, docs/modes/design-llm-first.md#dfm-in-waste): the tab height a
 * cut reaching in from the tab's top or bottom leaves ("lowers tabs 1–4 from 3 mm to 0.5 mm"),
 * and every message names the operation to change (the remover).
 */
function retainedRemoved(
  input: CheckInput,
  solids: SolidPort,
  steps: Steps,
): AppResult<DfmWarning[]> {
  type Hit = {
    regions: string[]
    parameter: string
    volume: number
    /** Nominal height of the regions along the face normal (tabs). */
    height?: number
    /** Least height left of a lowered region (tabs; 0 where cut through). */
    remains?: number
    /** Some region is cut into from neither its top nor its bottom. */
    into?: boolean
  }
  const all = new Map<ComposedOperation, Map<ComposedOperation, Hit>>()
  for (const a of input.operations) {
    const hits = new Map<ComposedOperation, Hit>()
    all.set(a, hits)
    for (const region of a.op.nominal) {
      const box = boxOf([region.mesh])
      const others = input.operations.filter(
        (b) => b !== a && boxesOverlap(box, b.box) && !clearOf(region, a.op, b),
      )
      if (others.length === 0) continue
      const solid = placed(region, a.originalId, solids)
      if (solid.isErr()) return Err(solid.unwrapErr())
      for (const b of others) {
        const r = removed(
          solid.unwrap(),
          b.solid,
          region.minusRemoval ? a.solid : undefined,
          solids,
        )
        if (r.isErr()) return Err(r.unwrapErr())
        const step = steps.step()
        if (step.isErr()) return Err(step.unwrapErr())
        const { volume, cut } = r.unwrap()
        if (volume <= EPSILON_VOLUME) continue
        const hit = hits.get(b) ?? { regions: [], parameter: region.parameter, volume: 0 }
        hit.regions.push(region.region)
        hit.volume += volume
        if (region.parameter === 'tabs') {
          const left = heightLeft(a.op.frame, box, cut, solids)
          if (left.isErr()) return Err(left.unwrapErr())
          const { height, remains } = left.unwrap()
          hit.height = Math.max(hit.height ?? 0, height)
          if (remains === undefined) hit.into = true
          else hit.remains = Math.min(hit.remains ?? Infinity, remains)
        }
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
        ...retainedText(a.op.id, b.op.id, hit),
        operation: a.op.id,
        parameter: hit.parameter,
      })
    }
  return Ok(warnings)
}

/** A tab height left below this (mm) is none: the cut goes through. */
const REMAINS_NONE = 1e-3
/** Float32 mesh slack (mm) when comparing a cut's extent with the region's. */
const MESH_SLACK = 1e-3

const mmText = (v: number): string => `${Math.round(v * 100) / 100} mm`

/**
 * The message and params of one `dfm.retainedRemoved` (owner `a`, remover `by`): starts with the
 * owner's id (named by `namedMessages`), says what remains and to change the remover.
 */
function retainedText(
  a: string,
  by: string,
  hit: {
    readonly regions: readonly string[]
    readonly parameter: string
    readonly volume: number
    readonly height?: number
    readonly remains?: number
    readonly into?: boolean
  },
): Pick<DfmWarning, 'message' | 'params'> {
  const params = { by, regions: [...hit.regions], volume: hit.volume }
  const volume = mm3(hit.volume)
  if (hit.into === true || hit.remains === undefined || hit.height === undefined)
    return {
      message:
        `${a}: ${by} cuts into ${regionWords(hit.regions)} (${volume}); change ${by}: move it ` +
        `off ${hit.parameter === 'tabs' ? 'the tabs' : 'the fillet'}`,
      params,
    }
  const tabs = tabList(hit.regions)
  const remains = Math.max(0, hit.remains)
  const lowered = { ...params, height: hit.height, remains }
  if (remains <= REMAINS_NONE)
    return {
      message: `${a}: ${by} cuts through ${tabs} (${volume}); change ${by}: move it off the tabs`,
      params: lowered,
    }
  return {
    message:
      `${a}: ${by} lowers ${tabs} from ${mmText(hit.height)} to ${mmText(remains)} ` +
      `(${volume}); change ${by}: make it shallower or move it off the tabs`,
    params: lowered,
  }
}

/** Region keys as words: "the floor fillet", tabs as `tabList`, others verbatim. */
function regionWords(regions: readonly string[]): string {
  const tabs = regions.filter((r) => /^tab\[\d+\]$/.test(r))
  const words = [
    ...regions
      .filter((r) => !tabs.includes(r))
      .map((r) => (r === 'floorFillet' ? 'the floor fillet' : r)),
    ...(tabs.length > 0 ? [tabList(tabs)] : []),
  ]
  return words.join(' and ')
}

/** "tab 2", "tabs 1–4", "tabs 1, 3 and 5" from region keys `tab[i]` (others verbatim). */
export function tabList(regions: readonly string[]): string {
  const n = regions.map((r) => /^tab\[(\d+)\]$/.exec(r)).map((m) => (m ? Number(m[1]) + 1 : NaN))
  if (n.some((x) => Number.isNaN(x))) return regions.join(', ')
  const sorted = [...new Set(n)].sort((x, y) => x - y)
  if (sorted.length === 1) return `tab ${sorted[0]}`
  const runs: string[] = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    if (j - i >= 2) runs.push(`${sorted[i]}–${sorted[j]}`)
    else runs.push(...sorted.slice(i, j + 1).map(String))
    i = j + 1
  }
  const last = runs.pop()!
  return `tabs ${runs.length === 0 ? last : `${runs.join(', ')} and ${last}`}`
}

/**
 * The region's height along its face normal and what the cut `cut` (region ∩ remover) leaves of
 * it: reaching in from the top, the height below the cut; from the bottom, the height above it;
 * across the whole height 0; touching neither end, `remains` undefined.
 */
function heightLeft(
  frame: Placement,
  region: Box,
  cut: Solid,
  solids: SolidPort,
): AppResult<{ height: number; remains?: number }> {
  return solids.toMesh(cut).map((mesh) => {
    const r = boxIn(frame, region)
    const c = boxIn(frame, boxOf([{ mesh }]))
    const height = r.max[2] - r.min[2]
    const top = c.max[2] >= r.max[2] - MESH_SLACK
    const bottom = c.min[2] <= r.min[2] + MESH_SLACK
    if (top && bottom) return { height, remains: 0 }
    if (top) return { height, remains: c.min[2] - r.min[2] }
    if (bottom) return { height, remains: r.max[2] - c.max[2] }
    return { height }
  })
}

/**
 * A removal of the same direction whose bounds lie, in the face frame's u, v, inside the
 * region's `clearInside` shape (a pocket contour inset by its fillet radius) cannot reach the
 * region: no booleans needed. Removals of other directions always run the boolean.
 */
function clearOf(region: NominalRegion, owner: OperationSolids, other: ComposedOperation): boolean {
  const shape = region.clearInside
  if (shape === undefined || other.op.direction !== owner.direction) return false
  const box = boxIn(owner.frame, other.box)
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
  return solids.fromMesh(region.mesh.mesh, originalId)
}

/**
 * vol(region ∩ other), minus the retaining operation's own removal when given, with the
 * intersection itself (before that subtraction).
 */
function removed(
  region: Solid,
  other: Solid,
  own: Solid | undefined,
  solids: SolidPort,
): AppResult<{ volume: number; cut: Solid }> {
  return solids.intersect(region, other).andThen((cut) =>
    solids.volume(cut).andThen((v) => {
      if (own === undefined || v <= EPSILON_VOLUME) return Ok({ volume: v, cut })
      return solids
        .subtract(cut, own)
        .andThen((rest) => solids.volume(rest))
        .map((volume) => ({ volume, cut }))
    }),
  )
}
