/**
 * Alignment aids (alignment phase 1, hardening DF78 slice 2): plan operations without a design
 * operation (`source: 'aid'`) that an earlier setup cuts so a later one can align — a V-bit witness
 * mark (a spot or a short line across an edge) or a registration hole through the stock into the
 * spoilboard. Their frames, the synthetic drilling a hole is evaluated as, the mark's depth and
 * toolpath geometry, their positions as alignment sources, the `plan.aid` findings and the
 * placement helpers. Derived, never stored. Pure, headless.
 * Doc: docs/modes/alignment.md#alignment-aids, docs/modes/alignment.md#implementation-slice-2
 */
import { operationFromDTO, type Operation } from '../design/operation'
import { toGeometryInput } from '../design/geometry-input'
import type { Region2dPort } from '../geometry/2d/port'
import { faceFrame, localStock, STOCK_FACE, type StockSize } from '../geometry/face'
import {
  applyPlacement,
  unapplyPlacement,
  type PartGeometryInput,
  type Vec2,
  type Vec3,
} from '../geometry/model'
import { shapeOutline } from '../geometry/outline'
import { flattenLoop } from '../geometry/prism'
import { regionLoops } from '../geometry/2d/model'
import type { Tool } from '../library/tool'
import { setupFrame } from '../toolpath/wcs'
import { AID, type AidDTO } from './alignment.dto'
import type { PlanWarning } from './checks'
import type { LoadedPlan } from './plan'
import type { LengthDTO, PlanDTO, PlanOperationDTO, SetupDTO } from './plan.dto'
import { setupDirection, setupRotation } from './setups'

/** Whether a plan operation is an alignment aid. */
export const isAid = (op: Pick<PlanOperationDTO, 'source'>): boolean => op.source === 'aid'

/** The aid's parameters of an aid plan operation (undefined for any other). */
export const aidOf = (op: Pick<PlanOperationDTO, 'source' | 'aid'>): AidDTO | undefined =>
  op.source === 'aid' ? op.aid : undefined

/** A witness mark's kind: a spot (`at`) or a line (`from` → `to`). */
export const isLineMark = (
  aid: AidDTO,
): aid is Extract<AidDTO, { kind: 'witnessMark'; from: unknown }> =>
  aid.kind === 'witnessMark' && 'from' in aid

/** The mark's end points in the setup frame (a spot: the same point twice). */
export function markEnds(aid: Extract<AidDTO, { kind: 'witnessMark' }>): [Vec2, Vec2] {
  return 'from' in aid
    ? [
        [aid.from[0], aid.from[1]],
        [aid.to[0], aid.to[1]],
      ]
    : [
        [aid.at[0], aid.at[1]],
        [aid.at[0], aid.at[1]],
      ]
}

/** The mark Ø (mm) of a witness mark: the spot's Ø at the face, the line's groove width. */
export const markDiameter = (aid: Extract<AidDTO, { kind: 'witnessMark' }>): number =>
  aid.markDiameter ?? AID.markDiameter

/** A registration hole's depth into the base below the stock (mm). */
export const spoilboardDepth = (aid: Extract<AidDTO, { kind: 'registrationHole' }>): number =>
  aid.spoilboardDepth ?? AID.spoilboardDepth

/**
 * A pointed V-bit's depth for a mark of Ø `diameter` at the face (mm):
 * `d = diameter / (2·tan(α/2))`, α the included angle.
 */
export function markDepth(diameter: number, angleDeg: number): number {
  return diameter / (2 * Math.tan((angleDeg / 2) * (Math.PI / 180)))
}

/** The mark Ø at the face a pointed V-bit of included angle `angleDeg` cuts at `depth` (mm). */
export function markDiameterAt(depth: number, angleDeg: number): number {
  return 2 * depth * Math.tan((angleDeg / 2) * (Math.PI / 180))
}

/** The included angle of a pointed V-bit (deg); undefined for any other tool (DF83). */
export function pointedVBitAngle(tool: Tool | undefined): number | undefined {
  if (tool === undefined || tool.type !== 'chamferMill') return undefined
  if (tool.tipDiameter.mapOr(0, (q) => q.canonical) > 1e-9) return undefined
  return tool.angle.mapOr(undefined, (q) => q.canonical)
}

/** The mark's cut depth with `tool` (undefined unless it is a chamfer mill with an angle). */
export function markDepthWith(
  aid: Extract<AidDTO, { kind: 'witnessMark' }>,
  tool: Tool | undefined,
): number | undefined {
  if (tool === undefined || tool.type !== 'chamferMill') return undefined
  const angle = tool.angle.mapOr(undefined, (q) => q.canonical)
  return angle === undefined ? undefined : markDepth(markDiameter(aid), angle)
}

export const stockSizeOf = (plan: Pick<LoadedPlan, 'stock'>): StockSize => ({
  length: plan.stock.length.canonical,
  width: plan.stock.width.canonical,
  thickness: plan.stock.thickness.canonical,
})

/** The setup frame without the zero (front-left corner of the up face). */
const cornerFrame = (setup: SetupDTO, stock: StockSize) =>
  setupFrame(setupDirection(setup), setupRotation(setup), stock)

/** A setup-frame point (Z 0 = up face) in the part frame. */
export function setupToPart(setup: SetupDTO, stock: StockSize, p: Vec3): Vec3 {
  return applyPlacement(cornerFrame(setup, stock), p)
}

/** A setup-frame X/Y in the face frame of the setup's direction (generators are top-down). */
export function setupToFace(setup: SetupDTO, stock: StockSize, p: Vec2): Vec2 {
  const part = setupToPart(setup, stock, [p[0], p[1], 0])
  const f = unapplyPlacement(faceFrame(setupDirection(setup), stock), part)
  const clean = (c: number) => (Math.abs(c) < 1e-9 ? 0 : c)
  return [clean(f[0]), clean(f[1])]
}

/** The setup's stock size as seen on the machine: X and Y of the up face (after the turn). */
export function setupXY(setup: SetupDTO, stock: StockSize): [number, number] {
  const local = localStock(setupDirection(setup), stock)
  return setupRotation(setup) % 180 !== 0
    ? [local.width, local.length]
    : [local.length, local.width]
}

// ── the flip axis (Q106, assumed) ─────────────────────────────────────────────────────────────

/**
 * Where a point of setup `a`'s up face lands in setup `b`'s frame, seen from above (Z dropped): a
 * through hole drilled at `p` in `a` is at `setupMap(a, b, stock)(p)` in `b`. An isometry of the
 * plane; a flip (opposite directions) reverses its orientation.
 */
export function setupMap(a: SetupDTO, b: SetupDTO, stock: StockSize): (p: Vec2) => Vec2 {
  const from = cornerFrame(a, stock)
  const to = cornerFrame(b, stock)
  return (p) => {
    const q = unapplyPlacement(to, applyPlacement(from, [p[0], p[1], 0]))
    return [q[0], q[1]]
  }
}

/** A flip axis: a line of setup `a`'s up face, clipped to the stock, and `b`'s view of it. */
export interface FlipAxis {
  /** The axis' ends on the stock outline, setup frame of the setup that drills the holes (mm). */
  readonly from: Vec2
  readonly to: Vec2
  /** The same line in the later (flipped) setup's frame. */
  readonly later: { readonly from: Vec2; readonly to: Vec2 }
}

const DIRECTION_VEC: Readonly<Record<string, Vec3>> = {
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+y': [0, 1, 0],
  '-y': [0, -1, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
}

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]

/**
 * The flip axis between `a` and a later setup `b` that turns the stock over (opposite
 * directions; Q106, assumed): the line of `a`'s up face whose points keep their place across the
 * flip up to one shift along it (a reflection's mirror line, a glide reflection's axis), clipped
 * to `a`'s stock outline. Holes on it, drilled through into dowels in the spoilboard, land on the
 * same dowels after the flip. In the setup frames, so a moved work zero never moves it.
 * `undefined` unless `b` flips `a`.
 */
export function flipAxis(a: SetupDTO, b: SetupDTO, stock: StockSize): FlipAxis | undefined {
  const da = DIRECTION_VEC[setupDirection(a)]!
  const db = DIRECTION_VEC[setupDirection(b)]!
  if (da[0] + db[0] !== 0 || da[1] + db[1] !== 0 || da[2] + db[2] !== 0) return undefined
  const map = setupMap(a, b, stock)
  const t = map([0, 0])
  const c1 = sub(map([1, 0]), t)
  const c2 = sub(map([0, 1]), t)
  if (c1[0] * c2[1] - c1[1] * c2[0] > 0) return undefined
  // R = I − 2nnᵀ: the columns of (I − R) are 2·n·nᵢ; the longer one gives n
  const k1: Vec2 = [1 - c1[0], -c1[1]]
  const k2: Vec2 = [-c2[0], 1 - c2[1]]
  const k = Math.hypot(...k1) >= Math.hypot(...k2) ? k1 : k2
  const kl = Math.hypot(...k)
  const n: Vec2 = [k[0] / kl, k[1] / kl]
  const d: Vec2 = [-n[1], n[0]]
  // map(p) − p = −2(p·n)n + t is along d where p·n = t·n / 2
  const c = (t[0] * n[0] + t[1] * n[1]) / 2
  const [L, W] = setupXY(a, stock)
  const ends = clipLine([n[0] * c, n[1] * c], d, L, W)
  if (ends === undefined) return undefined
  // stable ends: from the lower X (then the lower Y)
  const [p, q] = ends.map(round2) as [Vec2, Vec2]
  const [from, to] = p[0] < q[0] || (p[0] === q[0] && p[1] <= q[1]) ? [p, q] : [q, p]
  return { from, to, later: { from: round2(map(from)), to: round2(map(to)) } }
}

/** The part of the line `p + s·d` inside `[0, L] × [0, W]` (Liang–Barsky), if any. */
function clipLine(p: Vec2, d: Vec2, L: number, W: number): [Vec2, Vec2] | undefined {
  let lo = -Infinity
  let hi = Infinity
  for (const [pi, di, max] of [
    [p[0], d[0], L],
    [p[1], d[1], W],
  ] as const) {
    if (Math.abs(di) < 1e-12) {
      if (pi < -1e-9 || pi > max + 1e-9) return undefined
      continue
    }
    const s0 = (0 - pi) / di
    const s1 = (max - pi) / di
    lo = Math.max(lo, Math.min(s0, s1))
    hi = Math.min(hi, Math.max(s0, s1))
  }
  if (!(hi - lo > 1e-6)) return undefined
  return [
    [p[0] + d[0] * lo, p[1] + d[1] * lo],
    [p[0] + d[0] * hi, p[1] + d[1] * hi],
  ]
}

/**
 * The later setup the hole helper places for and its flip axis: `forSetupId` when it flips
 * `setup`, else (no `forSetupId`) the first later setup that does.
 */
export function flipPartner(
  plan: Pick<LoadedPlan, 'stock' | 'setups'>,
  setup: SetupDTO,
  forSetupId?: string,
): { readonly setup: SetupDTO; readonly axis: FlipAxis } | undefined {
  const stock = stockSizeOf(plan)
  const i = plan.setups.findIndex((s) => s.id === setup.id)
  const later =
    forSetupId === undefined
      ? plan.setups.slice(i + 1)
      : plan.setups.filter((s) => s.id === forSetupId)
  for (const b of later) {
    const axis = flipAxis(setup, b, stock)
    if (axis !== undefined) return { setup: b, axis }
  }
  return undefined
}

/**
 * The flip axes of a plan: for each setup that drills registration holes a later flipped setup
 * aligns on (or, without such points, the first later flipped setup when it drills any), the
 * axis in both frames. Drawn dashed in the Plan viewport of either setup.
 */
export function planFlipAxes(
  plan: Pick<LoadedPlan, 'stock' | 'setups'>,
): { readonly setupId: string; readonly laterSetupId: string; readonly axis: FlipAxis }[] {
  const stock = stockSizeOf(plan)
  const out: { setupId: string; laterSetupId: string; axis: FlipAxis }[] = []
  for (const [i, a] of plan.setups.entries()) {
    const holes = new Set(
      a.operations.filter((o) => aidOf(o)?.kind === 'registrationHole').map((o) => o.id),
    )
    if (holes.size === 0) continue
    const users = plan.setups
      .slice(i + 1)
      .filter((b) => (b.alignment ?? []).some((p) => 'aid' in p.source && holes.has(p.source.aid)))
    const partners = users.length > 0 ? users : plan.setups.slice(i + 1)
    for (const b of partners) {
      const axis = flipAxis(a, b, stock)
      if (axis === undefined) continue
      out.push({ setupId: a.id, laterSetupId: b.id, axis })
      if (users.length === 0) break
    }
  }
  return out
}

/** Holes and flip axes match within this (mm). */
const FLIP_TOL = 0.05

/** The id of the synthetic design operation a registration hole is evaluated as. */
export const aidOperationId = (planOperationId: string): string =>
  `aid1_${planOperationId.replace(/[^\w]/g, '_')}`

const lengthSource = (mm: number) => `${Math.round(mm * 1e6) / 1e6 || 0} mm`

/**
 * A registration hole as a through drilling on the setup's stock face (S14), in the face frame:
 * evaluated, checked and generated as any drilling. Never stored; undefined for a mark.
 */
export function aidDrilling(
  plan: Pick<LoadedPlan, 'stock'>,
  setup: SetupDTO,
  op: PlanOperationDTO,
): Operation | undefined {
  const aid = aidOf(op)
  if (aid?.kind !== 'registrationHole') return undefined
  const stock = stockSizeOf(plan)
  const c = setupToFace(setup, stock, [aid.center[0], aid.center[1]])
  const len = mmLength
  const made = operationFromDTO({
    kind: 'drilling',
    id: aidOperationId(op.id),
    name: aid.name,
    on: STOCK_FACE[setupDirection(setup)],
    center: [len(c[0]), len(c[1])],
    diameter: len(aid.diameter),
    bottom: 'through',
  })
  return made.isOk() ? made.unwrap() : undefined
}

/** A length DTO of `mm` millimetres (micrometre precision), as entered in mm. */
export const mmLength = (mm: number): LengthDTO => ({
  kind: 'length',
  source: lengthSource(mm),
  defaultUnit: 'mm',
  exact: rational(mm),
})

/** A decimal mm value as an exact rational (micrometre precision). */
function rational(mm: number): { num: string; den: string } {
  const um = Math.round(mm * 1e6)
  return { num: String(um), den: '1000000' }
}

/** An aid's toolpath geometry in the face frame of its setup (mm). */
export type AidGeometry =
  | { readonly kind: 'mark'; readonly from: Vec2; readonly to: Vec2; readonly depth: number }
  | { readonly kind: 'hole'; readonly center: Vec2; readonly diameter: number }

/** The aid's geometry for its generator; a mark needs its depth (from the V-bit). */
export function aidGeometry(
  plan: Pick<LoadedPlan, 'stock'>,
  setup: SetupDTO,
  aid: AidDTO,
  depth: number | undefined,
): AidGeometry | undefined {
  const stock = stockSizeOf(plan)
  if (aid.kind === 'registrationHole')
    return { kind: 'hole', center: setupToFace(setup, stock, aid.center), diameter: aid.diameter }
  if (depth === undefined) return undefined
  const [a, b] = markEnds(aid)
  return {
    kind: 'mark',
    from: setupToFace(setup, stock, a),
    to: setupToFace(setup, stock, b),
    depth,
  }
}

// ── positions as alignment sources (S16) ──────────────────────────────────────────────────────

/** Where a segment crosses the rectangle `[0, L] × [0, W]`'s outline, if it does. */
function outlineCrossing(a: Vec2, b: Vec2, L: number, W: number): Vec2 | undefined {
  const hits: { t: number; p: Vec2 }[] = []
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const add = (t: number) => {
    if (t < -1e-9 || t > 1 + 1e-9) return
    const p: Vec2 = [a[0] + t * dx, a[1] + t * dy]
    if (p[0] < -1e-6 || p[0] > L + 1e-6 || p[1] < -1e-6 || p[1] > W + 1e-6) return
    hits.push({ t, p })
  }
  if (Math.abs(dx) > 1e-12) {
    add((0 - a[0]) / dx)
    add((L - a[0]) / dx)
  }
  if (Math.abs(dy) > 1e-12) {
    add((0 - a[1]) / dy)
    add((W - a[1]) / dy)
  }
  hits.sort((x, y) => x.t - y.t)
  return hits[0]?.p
}

/** An aid's point as an alignment source: part frame, kind, and its through axis for a hole. */
export interface AidPoint {
  readonly part: Vec3
  readonly kind: 'point' | 'hole' | 'edge'
  readonly throughAxis?: Vec3
}

/**
 * The aid's alignment point in the part frame (S16): a spot mark's tip at the face, a line mark's
 * crossing of the stock outline (its middle when it crosses none), a registration hole's centre
 * (through: seen from either side).
 */
export function aidPoint(plan: Pick<LoadedPlan, 'stock'>, setup: SetupDTO, aid: AidDTO): AidPoint {
  const stock = stockSizeOf(plan)
  const frame = cornerFrame(setup, stock)
  if (aid.kind === 'registrationHole')
    return {
      part: applyPlacement(frame, [aid.center[0], aid.center[1], 0]),
      kind: 'hole',
      throughAxis: frame.n,
    }
  const [a, b] = markEnds(aid)
  if (!isLineMark(aid)) return { part: applyPlacement(frame, [a[0], a[1], 0]), kind: 'point' }
  const [L, W] = setupXY(setup, stock)
  const at = outlineCrossing(a, b, L, W) ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  return { part: applyPlacement(frame, [at[0], at[1], 0]), kind: 'edge' }
}

// ── names ─────────────────────────────────────────────────────────────────────────────────────

export const AID_WORD: Readonly<Record<AidDTO['kind'], string>> = {
  witnessMark: 'Witness mark',
  registrationHole: 'Registration hole',
}

/** The next default name of an aid kind in the plan: "Witness mark 3" (stored on add, kept). */
export function nextAidName(plan: PlanDTO, kind: AidDTO['kind'], skip = 0): string {
  const word = AID_WORD[kind]
  let n = 0
  for (const s of plan.setups)
    for (const o of s.operations) {
      const m = new RegExp(`^${word} (\\d+)$`).exec(o.aid?.name ?? '')
      if (m !== null) n = Math.max(n, Number(m[1]))
    }
  return `${word} ${n + 1 + skip}`
}

// ── part outline and findings (S17) ───────────────────────────────────────────────────────────

const geometryMemo = new WeakMap<LoadedPlan, PartGeometryInput | null>()

function geometry(plan: LoadedPlan, port?: Region2dPort): PartGeometryInput | undefined {
  const hit = geometryMemo.get(plan)
  if (hit !== undefined) return hit ?? undefined
  const g = toGeometryInput(plan.part, plan.stock, port)
  const value = g.isOk() ? g.unwrap() : null
  geometryMemo.set(plan, value)
  return value ?? undefined
}

/**
 * The part's outline seen in `setup` (setup frame X/Y polygons): the loops of the closed through
 * `outside` profiles cut from the setup's face or the opposite one; `undefined` when the design
 * has none (the stock is the part: every aid marks it).
 */
export function partOutline(
  plan: LoadedPlan,
  setup: SetupDTO,
  port?: Region2dPort,
): Vec2[][] | undefined {
  const input = geometry(plan, port)
  if (input === undefined) return undefined
  const stock = stockSizeOf(plan)
  const frame = cornerFrame(setup, stock)
  const out: Vec2[][] = []
  for (const g of input.operations) {
    if (g.kind !== 'profile' || g.side !== 'outside' || g.depth !== undefined) continue
    const face = faceFrame(g.direction ?? '+z', input.stock)
    // only profiles along the setup's axis outline the part from above
    const along = Math.abs(face.n[0] * frame.n[0] + face.n[1] * frame.n[1] + face.n[2] * frame.n[2])
    if (along < 1 - 1e-9) continue
    const o = shapeOutline(g.shape)
    if (o.kind !== 'region') continue
    for (const piece of o.region.pieces)
      for (const loop of regionLoops({ pieces: [{ outer: piece.outer, holes: [] }] })) {
        const ring = flattenLoop(loop, 'grow').points
        out.push(
          ring.map((p) => {
            const s = unapplyPlacement(frame, applyPlacement(face, [p[0], p[1], 0]))
            return [s[0], s[1]] as Vec2
          }),
        )
      }
  }
  return out.length === 0 ? undefined : out
}

function inPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!
    const b = poly[j]!
    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside
  }
  return inside
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

/** The aid's footprint: its centre line (setup frame) and radius (mm). */
export function aidFootprint(aid: AidDTO): { a: Vec2; b: Vec2; r: number } {
  if (aid.kind === 'registrationHole')
    return { a: [...aid.center] as Vec2, b: [...aid.center] as Vec2, r: aid.diameter / 2 }
  const [a, b] = markEnds(aid)
  return { a, b, r: markDiameter(aid) / 2 }
}

/**
 * Whether the footprint (a capsule) touches the part: inside or within `r` of an outline
 * polygon, inside the stock (S17). Without an outline the stock is the part.
 */
export function touchesPart(
  footprint: { a: Vec2; b: Vec2; r: number },
  outline: Vec2[][] | undefined,
  size: [number, number],
): boolean {
  const { a, b, r } = footprint
  const [L, W] = size
  // the capsule's part over the stock (a line mark runs past the edge into the air)
  const samples: Vec2[] = []
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25))
  for (let i = 0; i <= n; i++)
    samples.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n])
  const over = samples.filter((p) => p[0] > -r && p[0] < L + r && p[1] > -r && p[1] < W + r)
  if (over.length === 0) return false
  if (outline === undefined) return true
  for (const poly of outline) {
    if (over.some((p) => inPolygon(p, poly))) return true
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!
      if (segmentDistance(p, a, b) < r - 1e-9) return true
      const q = poly[(i + 1) % poly.length]!
      if (over.some((s) => segmentDistance(s, p, q) < r - 1e-9)) return true
    }
  }
  return false
}

/** Whether the setup has a sacrificial base (spoilboard) in its workholding. */
const hasBase = (setup: SetupDTO): boolean =>
  (setup.workholding ?? []).some((w) => w.kind === 'base')

/**
 * Per-aid findings beside the drilling/V-bit checks (S17): warning `inPart` when the footprint
 * touches the part, warning `noBase` for a registration hole in a setup without a spoilboard
 * (a non-sacrificial base is DF59's `plan.workholding.breakthrough`).
 */
export function aidPlacementFindings(
  plan: LoadedPlan,
  setup: SetupDTO,
  op: PlanOperationDTO,
  port?: Region2dPort,
): Omit<PlanWarning, 'planOperationId'>[] {
  const aid = aidOf(op)
  if (aid === undefined) return []
  const out: Omit<PlanWarning, 'planOperationId'>[] = []
  const size = setupXY(setup, stockSizeOf(plan))
  if (touchesPart(aidFootprint(aid), partOutline(plan, setup, port), size))
    out.push({
      code: 'plan.aid',
      severity: 'warning',
      field: 'aid',
      rule: 'inPart',
      message: `${aid.name} cuts the part: place it in the waste`,
      params: { setupId: setup.id },
    })
  if (aid.kind === 'registrationHole' && !hasBase(setup))
    out.push({
      code: 'plan.aid',
      severity: 'warning',
      field: 'aid',
      rule: 'noBase',
      message: `Add a spoilboard to ${setup.name}: ${aid.name} goes ${Math.round(spoilboardDepth(aid) * 100) / 100} mm into the table`,
      params: { setupId: setup.id, depth: spoilboardDepth(aid), setup: setup.name, aid: aid.name },
    })
  out.push(...flipFindings(plan, setup, op))
  return out
}

/**
 * Warning `plan.aid`, rule `offAxis` (Q106, assumed): the registration holes of `setup` that a
 * later flipped setup aligns on must sit on their dowels after the flip: every hole's image is a
 * hole shifted by one common vector (true for holes on the flip axis, or mirrored about it).
 * When they are not, each hole off the axis is reported. Needs two holes or more per later setup.
 */
export function flipFindings(
  plan: Pick<LoadedPlan, 'stock' | 'setups'>,
  setup: SetupDTO,
  op: PlanOperationDTO,
): Omit<PlanWarning, 'planOperationId'>[] {
  const aid = aidOf(op)
  if (aid?.kind !== 'registrationHole') return []
  const stock = stockSizeOf(plan)
  const holes = new Map<string, Vec2>()
  for (const o of setup.operations) {
    const h = aidOf(o)
    if (h?.kind === 'registrationHole') holes.set(o.id, [h.center[0], h.center[1]])
  }
  const out: Omit<PlanWarning, 'planOperationId'>[] = []
  for (const later of plan.setups) {
    const used = [
      ...new Set(
        (later.alignment ?? []).flatMap((p) =>
          'aid' in p.source && holes.has(p.source.aid) ? [p.source.aid] : [],
        ),
      ),
    ]
    if (!used.includes(op.id) || used.length < 2) continue
    const axis = flipAxis(setup, later, stock)
    if (axis === undefined) continue
    const map = setupMap(setup, later, stock)
    const ps = used.map((id) => holes.get(id)!)
    const near = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= FLIP_TOL
    const fits = ps.some((pi) =>
      ps.some((pj) => {
        const g = sub(map(pi), pj)
        return ps.every((pk) => ps.some((pl) => near(sub(map(pk), g), pl)))
      }),
    )
    if (fits) continue
    const off = distanceToLine([aid.center[0], aid.center[1]], axis.from, axis.to)
    if (off <= FLIP_TOL) continue
    out.push({
      code: 'plan.aid',
      severity: 'warning',
      field: 'aid',
      rule: 'offAxis',
      message: `${aid.name} is ${Math.round(off * 100) / 100} mm off the flip axis to ${later.name}: after the flip it misses its dowel; move it onto the axis (the dashed line)`,
      params: {
        setupId: setup.id,
        laterSetupId: later.id,
        distance: Math.round(off * 1000) / 1000,
      },
    })
  }
  return out
}

function distanceToLine(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.hypot(dx, dy)
}

// ── placement helpers (S18) ───────────────────────────────────────────────────────────────────

/** A candidate edge of the up face: a point on it at `t` and the inward normal. */
interface FaceEdge {
  readonly name: 'front' | 'back' | 'left' | 'right'
  readonly at: (t: number) => Vec2
  readonly inward: Vec2
}

function faceEdges(L: number, W: number): FaceEdge[] {
  return [
    { name: 'front', at: (t) => [t * L, 0], inward: [0, 1] },
    { name: 'back', at: (t) => [(1 - t) * L, W], inward: [0, -1] },
    { name: 'left', at: (t) => [0, (1 - t) * W], inward: [1, 0] },
    { name: 'right', at: (t) => [L, t * W], inward: [-1, 0] },
  ]
}

const T_STEPS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.05, 0.35, 0.4, 0.45]

/** The placement helpers' choices (DF83): which edges, holes on the flip axis or at corners. */
export interface PlaceOptions {
  /** Marks: across the front and back edges or the left and right ones (default: the longer pair). */
  readonly edges?: 'frontBack' | 'leftRight' | undefined
  /**
   * Marks: how far the line runs inside the edge (default `AID.lineInside`); holes: the wall
   * between the stock edge and the hole (default `AID.holeInset`).
   */
  readonly inset?: number | undefined
}

/**
 * Two line marks across opposite edges of the up face of `setup`, each `inset` (4 mm) inside and
 * 2 mm past the edge, from opposite ends (as far apart as possible), at the first spot whose
 * groove stays out of the part (S18). The longer pair of edges unless `edges` names one (DF83).
 */
export function suggestMarks(
  plan: LoadedPlan,
  setup: SetupDTO,
  markD: number,
  port?: Region2dPort,
  options: PlaceOptions = {},
): { from: Vec2; to: Vec2 }[] {
  const inside = options.inset ?? AID.lineInside
  const size = setupXY(setup, stockSizeOf(plan))
  const [L, W] = size
  const outline = partOutline(plan, setup, port)
  const edges = faceEdges(L, W)
  const line = (e: FaceEdge, t: number) => {
    const p = e.at(t)
    return {
      from: [p[0] + e.inward[0] * inside, p[1] + e.inward[1] * inside] as Vec2,
      to: [p[0] - e.inward[0] * AID.linePast, p[1] - e.inward[1] * AID.linePast] as Vec2,
    }
  }
  const pick = (e: FaceEdge) => {
    for (const t of T_STEPS) {
      const l = line(e, t)
      if (!touchesPart({ a: l.from, b: l.to, r: markD / 2 }, outline, size)) return l
    }
    return line(e, T_STEPS[0]!)
  }
  // the longer pair of edges keeps the marks further apart
  const frontBack = options.edges === undefined ? L >= W : options.edges === 'frontBack'
  const [a, b] = frontBack ? [edges[0]!, edges[1]!] : [edges[2]!, edges[3]!]
  return [pick(a), pick(b)].map((l) => ({ from: round2(l.from), to: round2(l.to) }))
}

/**
 * Two registration holes (S17). With `axis`, the flip axis to the later setup (S25, Q106
 * assumed): on the axis, one from each end, in the waste between the stock edge and the part,
 * so the flipped stock drops onto the same dowels; each Ø/2 + 3 mm from the stock edge when the
 * waste allows, else centred in the waste run along the axis, never closer than 0.5 mm to the
 * stock edge (a hole that cannot clear the part keeps its first spot: `inPart`). Without a flip
 * (a turn), near diagonally opposite corners of the up face (front-left and back-right), inset
 * by Ø/2 + 3 mm and moved inward along the diagonal until they stay out of the part. DF83:
 * `options.inset` replaces the 3 mm wall.
 */
export function suggestHoles(
  plan: LoadedPlan,
  setup: SetupDTO,
  diameter: number,
  port?: Region2dPort,
  axis?: Pick<FlipAxis, 'from' | 'to'>,
  options: PlaceOptions = {},
): Vec2[] {
  const size = setupXY(setup, stockSizeOf(plan))
  const [L, W] = size
  const outline = partOutline(plan, setup, port)
  const r = diameter / 2
  const wallMm = options.inset ?? AID.holeInset
  if (axis !== undefined) return axisHoles(axis, r, size, outline, wallMm)
  const inset = r + wallMm
  const place = (corner: Vec2, dir: Vec2): Vec2 => {
    const first: Vec2 = [corner[0] + dir[0] * inset, corner[1] + dir[1] * inset]
    for (let k = 0; k < 20; k++) {
      const p: Vec2 = [first[0] + dir[0] * k * 2, first[1] + dir[1] * k * 2]
      if (p[0] < r || p[0] > L - r || p[1] < r || p[1] > W - r) break
      if (!touchesPart({ a: p, b: p, r }, outline, size)) return p
    }
    return first
  }
  return [place([0, 0], [1, 1]), place([L, W], [-1, -1])].map(round2)
}

/** Grid along the axis the hole helper tries (mm). */
const AXIS_STEP = 0.25

/** Two holes on the flip axis, one from each end (S25; `suggestHoles`). */
function axisHoles(
  axis: Pick<FlipAxis, 'from' | 'to'>,
  r: number,
  size: [number, number],
  outline: Vec2[][] | undefined,
  insetMm: number,
): Vec2[] {
  const [L, W] = size
  const wall = (p: Vec2) => Math.min(p[0], L - p[0], p[1], W - p[1])
  const clear = (p: Vec2) =>
    wall(p) >= r + 0.5 - 1e-9 && !touchesPart({ a: p, b: p, r }, outline, size)
  const [a, b] = [axis.from, axis.to]
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const dir: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
  const fromEnd = (start: Vec2, d: Vec2): Vec2 => {
    const at = (s: number): Vec2 => [start[0] + d[0] * s, start[1] + d[1] * s]
    const max = len / 2
    // the first run of clear spots from the end (the waste before the part)
    let lo: number | undefined
    let hi: number | undefined
    for (let s = 0; s <= max + 1e-9; s += AXIS_STEP) {
      const ok = clear(at(s))
      if (ok) {
        lo ??= s
        hi = s
      } else if (lo !== undefined) break
    }
    const inset = (from: number, to: number): number | undefined => {
      for (let s = from; s <= to + 1e-9; s += AXIS_STEP)
        if (wall(at(s)) >= r + insetMm - 1e-9) return s
      return undefined
    }
    if (lo === undefined || hi === undefined) return at(inset(0, max) ?? Math.min(max, r + insetMm))
    return at(inset(lo, hi) ?? (lo + hi) / 2)
  }
  return [fromEnd(a, dir), fromEnd(b, [-dir[0], -dir[1]])].map(round2)
}

const round2 = (p: Vec2): Vec2 => [
  Math.round(p[0] * 1000) / 1000 || 0,
  Math.round(p[1] * 1000) / 1000 || 0,
]
