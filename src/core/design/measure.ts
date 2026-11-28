/**
 * Headless snap and measure (hardening A6): `design.measure` gives agents what the viewport's
 * measure tool snaps to near a part-frame point – mesh vertices, stock corners, part zero, hole
 * and face centres, the nearest feature edge – ranked by the snap engine's priorities, and the
 * distance or angle between points. Query only; reads the part's evaluation, never waits for it.
 * Doc: docs/architecture/llm-api.md#a6-designmeasure-headless-snap-and-measure,
 * docs/conventions/ui.md#snap-and-measure
 */
import { z } from 'zod'
import type { Issue } from '../../shared/errors/app-error'
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import { defineQuery } from '../commands/define'
import { faceFrame, toPartFrame } from '../geometry/face'
import type { PartEvaluation } from '../geometry/evaluate'
import { angleAt, measureBetween } from '../geometry/measure'
import type { PartGeometryInput, StockGeometry, Vec3 } from '../geometry/model'
import { SNAP_PRIORITY, type SnapKind } from '../geometry/snap'
import { EvaluationStatusSchema, type PartEvaluationState } from './evaluation'
import { partGeometryInput } from './load'
import { FEATURE_EDGE_DEG, featureEdges } from './mesh-section'
import { PartIdSchema } from './part.dto'

const WHERE = 'design.measure'

/** What a headless snap landed on (llm-api.md § A6). */
export const MEASURE_KINDS = [
  'vertex',
  'corner',
  'partZero',
  'holeCentre',
  'faceCentre',
  'edge',
] as const
export type MeasureKind = (typeof MEASURE_KINDS)[number]

/** The engine kind whose priority each headless kind takes (`SNAP_PRIORITY`). */
const ENGINE_KIND: Readonly<Record<MeasureKind, SnapKind>> = {
  vertex: 'end',
  corner: 'corner',
  partZero: 'corner',
  holeCentre: 'centre',
  faceCentre: 'centre',
  edge: 'edge',
}

export interface MeasureTarget {
  readonly kind: MeasureKind
  readonly at: Vec3
  /** The operation (hole centre) or surface (face centre) id, usable as a point ref. */
  readonly ref?: string
}

export interface SnapCandidate extends MeasureTarget {
  readonly distance: number
}

/** Default reach (mm) of the snap form; the viewport's is 8 screen px. */
export const MEASURE_RADIUS_MM = 2
export const MEASURE_RADIUS_MAX_MM = 50
/** Candidates returned at most. */
export const MEASURE_LIMIT = 10
/** Vertices this close (mm, per coordinate) are one (split at surface boundaries in the mesh). */
const WELD = 1e-4

const PART_ZERO: Vec3 = [0, 0, 0]

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** Stock corners (the part-zero corner left out: it is `partZero`). */
export function stockCorners(stock: StockGeometry): MeasureTarget[] {
  const out: MeasureTarget[] = []
  for (const x of [0, stock.length])
    for (const y of [0, stock.width])
      for (const z of [-stock.thickness, 0])
        if (x !== 0 || y !== 0 || z !== 0) out.push({ kind: 'corner', at: [x, y, z] })
  return out
}

/**
 * Hole centres from the geometry input: the mouth centre (on the `on` face) of every drilling,
 * circle pocket, inside circle profile and chamfer, in the part frame.
 */
export function holeCentres(input: PartGeometryInput): MeasureTarget[] {
  const out: MeasureTarget[] = []
  for (const op of input.operations) {
    let uvw: Vec3 | undefined
    if (
      op.kind === 'drilling' ||
      (op.kind === 'chamfer' && op.edge === undefined && op.wall === undefined)
    )
      uvw = [op.center[0], op.center[1], op.onZ]
    else if (op.kind === 'pocket' && op.shape.contour.kind === 'circle')
      uvw = [op.shape.center[0], op.shape.center[1], op.onZ]
    else if (op.kind === 'profile' && op.side === 'inside' && op.shape.contour.kind === 'circle')
      uvw = [op.shape.center[0], op.shape.center[1], 0]
    if (uvw === undefined) continue
    const frame = faceFrame(op.direction ?? '+z', input.stock)
    out.push({ kind: 'holeCentre', at: toPartFrame(frame, uvw), ref: op.id })
  }
  return out
}

const faceCentreCache = new WeakMap<PartEvaluation, readonly MeasureTarget[]>()

/** Area centroid of each surface's triangles (cached per evaluation). */
export function faceCentres(m: PartEvaluation): readonly MeasureTarget[] {
  const hit = faceCentreCache.get(m)
  if (hit !== undefined) return hit
  const acc = m.surfaces.map(() => [0, 0, 0, 0])
  const p = m.positions
  const ix = m.indices
  for (let t = 0; t * 3 < ix.length; t++) {
    const a = ix[t * 3]! * 3
    const b = ix[t * 3 + 1]! * 3
    const c = ix[t * 3 + 2]! * 3
    const ux = p[b]! - p[a]!
    const uy = p[b + 1]! - p[a + 1]!
    const uz = p[b + 2]! - p[a + 2]!
    const vx = p[c]! - p[a]!
    const vy = p[c + 1]! - p[a + 1]!
    const vz = p[c + 2]! - p[a + 2]!
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
    const s = acc[m.triangleSurface[t]!]
    if (s === undefined || !(area > 0)) continue
    for (let k = 0; k < 3; k++) s[k]! += (area * (p[a + k]! + p[b + k]! + p[c + k]!)) / 3
    s[3]! += area
  }
  const out: MeasureTarget[] = []
  m.surfaces.forEach((id, i) => {
    const [x, y, z, area] = acc[i]!
    if (area! > 0)
      out.push({ kind: 'faceCentre', at: [x! / area!, y! / area!, z! / area!], ref: id })
  })
  faceCentreCache.set(m, out)
  return out
}

/** Mesh vertices within `radius` of `p`, welded. */
function nearVertices(m: PartEvaluation, p: Vec3, radius: number): MeasureTarget[] {
  const out: MeasureTarget[] = []
  const seen = new Set<string>()
  const q = m.positions
  for (let i = 0; i + 2 < q.length; i += 3) {
    const at: Vec3 = [q[i]!, q[i + 1]!, q[i + 2]!]
    if (dist(at, p) > radius) continue
    const key = at.map((v) => Math.round(v / WELD)).join(',')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind: 'vertex', at })
  }
  return out
}

/**
 * The nearest point within `radius` on a feature edge (`featureEdges`, the edges the viewport
 * draws). Only triangles whose box reaches `radius` around `p` are looked at: both faces of an
 * edge within `radius` contain it, so they are both in that set and the edge is classified as on
 * the whole mesh.
 */
function nearestEdge(m: PartEvaluation, p: Vec3, radius: number): MeasureTarget | undefined {
  const q = m.positions
  const ix = m.indices
  const soup: number[] = []
  for (let t = 0; t * 3 < ix.length; t++) {
    let ok = true
    for (let k = 0; k < 3 && ok; k++) {
      let lo = Infinity
      let hi = -Infinity
      for (let j = 0; j < 3; j++) {
        const v = q[ix[t * 3 + j]! * 3 + k]!
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
      }
      ok = p[k]! >= lo - radius && p[k]! <= hi + radius
    }
    if (!ok) continue
    for (let j = 0; j < 3; j++) {
      const o = ix[t * 3 + j]! * 3
      soup.push(q[o]!, q[o + 1]!, q[o + 2]!)
    }
  }
  if (soup.length === 0) return undefined
  const edges = featureEdges(Float32Array.from(soup), FEATURE_EDGE_DEG)
  if (edges.isErr()) return undefined
  const e = edges.unwrap()
  let best: Vec3 | undefined
  let bestD = radius
  for (let i = 0; i + 5 < e.length; i += 6) {
    const a: Vec3 = [e[i]!, e[i + 1]!, e[i + 2]!]
    const d: Vec3 = [e[i + 3]! - a[0], e[i + 4]! - a[1], e[i + 5]! - a[2]]
    const l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
    const s =
      l2 === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / l2),
          )
    const at: Vec3 = [a[0] + s * d[0], a[1] + s * d[1], a[2] + s * d[2]]
    const dd = dist(at, p)
    if (dd <= bestD) [best, bestD] = [at, dd]
  }
  return best === undefined ? undefined : { kind: 'edge', at: best }
}

/**
 * Snap candidates within `radius` of `p`, ranked as the snap engine ranks (priority, then the
 * nearest). `mesh` absent = only the document's targets (stock corners, part zero, hole centres).
 */
export function snapCandidates(
  p: Vec3,
  input: PartGeometryInput,
  mesh: PartEvaluation | undefined,
  radius: number,
): SnapCandidate[] {
  const targets: MeasureTarget[] = [
    { kind: 'partZero', at: PART_ZERO },
    ...stockCorners(input.stock),
    ...holeCentres(input),
  ]
  if (mesh !== undefined) {
    targets.push(...nearVertices(mesh, p, radius), ...faceCentres(mesh))
    const edge = nearestEdge(mesh, p, radius)
    if (edge !== undefined) targets.push(edge)
  }
  return targets
    .map((t) => ({ ...t, distance: dist(t.at, p) }))
    .filter((c) => c.distance <= radius)
    .sort(
      (a, b) =>
        SNAP_PRIORITY[ENGINE_KIND[a.kind]] - SNAP_PRIORITY[ENGINE_KIND[b.kind]] ||
        a.distance - b.distance,
    )
}

/** A point arg of the measure form: part-frame coordinates or a ref. */
export type PointArg = readonly [number, number, number] | string

/** A point arg resolved to the part frame. */
export function resolvePoint(
  arg: PointArg,
  index: number,
  input: PartGeometryInput,
  state: PartEvaluationState,
): AppResult<Vec3> {
  if (typeof arg !== 'string') return Ok(arg)
  if (arg === 'partZero') return Ok(PART_ZERO)
  const hole = holeCentres(input).find((h) => h.ref === arg)
  if (hole !== undefined) return Ok(hole.at)
  const issue = (rule: string, message: string): Issue => ({
    path: ['points', index],
    rule,
    message,
    params: { ref: arg },
  })
  // surface ids are `<operation id>.<role>` or `stock.<face>`, operation ids have no dot
  const isSurface = arg.includes('.')
  if (isSurface && (state.status !== 'done' || state.evaluation === undefined))
    return fail(
      'input.malformed',
      `${WHERE}: points.${index}: surface ${arg} needs the part's evaluation (${state.status}); wait for it with design_part_evaluate`,
      { where: WHERE, issues: [issue('notEvaluated', 'evaluation not done')] },
    )
  const face = state.evaluation === undefined ? undefined : faceCentres(state.evaluation)
  const centre = face?.find((f) => f.ref === arg)
  if (centre !== undefined) return Ok(centre.at)
  return fail(
    'input.malformed',
    `${WHERE}: points.${index}: unknown ref "${arg}"; use [x, y, z], partZero, a hole operation id or a surface id (design_measure { near } lists refs near a point)`,
    { where: WHERE, issues: [issue('unknownRef', 'not a hole operation or surface')] },
  )
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000 + 0
const v3 = (p: Vec3): [number, number, number] => [r3(p[0]), r3(p[1]), r3(p[2])]

const Vec3Arg = z.tuple([z.number(), z.number(), z.number()])
const Vec3Out = z.tuple([z.number(), z.number(), z.number()])

export const designMeasure = defineQuery({
  name: 'design.measure',
  summary:
    'Snap and measure in the part frame (mm), as the viewport: targets near a point, or the distance or angle between points.',
  args: z.object({
    partId: PartIdSchema,
    near: Vec3Arg.optional().describe('Snap: list targets near [x, y, z]'),
    radius: z.number().positive().max(MEASURE_RADIUS_MAX_MM).optional().describe('Snap reach (2)'),
    points: z
      .array(z.union([Vec3Arg, z.string()]))
      .min(2)
      .max(3)
      .optional()
      .describe(
        'Measure: 2 (distance) or 3 (angle at the 2nd); [x, y, z] or a ref (partZero, hole operation id, surface id)',
      ),
  }),
  result: z.object({
    evaluation: EvaluationStatusSchema.describe('Mesh targets only when done'),
    candidates: z
      .array(
        z.object({
          kind: z.enum(MEASURE_KINDS),
          at: Vec3Out,
          distance: z.number(),
          ref: z.string().optional(),
        }),
      )
      .optional()
      .describe('Snap: ranked by priority, then distance'),
    more: z.number().int().optional().describe('Candidates left out'),
    points: z.array(Vec3Out).optional(),
    distance: z.number().optional(),
    delta: Vec3Out.optional().describe('b − a'),
    angle: z.number().optional().describe('Degrees at the 2nd point'),
    distances: z.tuple([z.number(), z.number()]).optional(),
  }),
  run(doc, args, ctx) {
    if ((args.near === undefined) === (args.points === undefined))
      return fail('input.malformed', `${WHERE}: give near (snap) or points (measure), not both`, {
        where: WHERE,
        issues: [
          {
            path: args.near === undefined ? [] : ['points'],
            rule: 'nearOrPoints',
            message: 'exactly one of near and points',
          },
        ],
      })
    const input = partGeometryInput(doc, args.partId, ctx.services.region2d)
    if (input.isErr()) return Err(input.unwrapErr().withContext(WHERE))
    const geometry = input.unwrap()
    const state: PartEvaluationState = ctx.services.evaluations?.state(doc, args.partId) ?? {
      status: 'pending',
    }
    const mesh = state.status === 'done' ? state.evaluation : undefined
    if (args.near !== undefined) {
      const all = snapCandidates(args.near, geometry, mesh, args.radius ?? MEASURE_RADIUS_MM)
      const candidates = all.slice(0, MEASURE_LIMIT).map((c) => ({
        kind: c.kind,
        at: v3(c.at),
        distance: r3(c.distance),
        ...(c.ref === undefined ? {} : { ref: c.ref }),
      }))
      const more = all.length - candidates.length
      return Ok({ evaluation: state.status, candidates, ...(more > 0 ? { more } : {}) })
    }
    const pts: Vec3[] = []
    for (const [i, arg] of args.points!.entries()) {
      const p = resolvePoint(arg, i, geometry, state)
      if (p.isErr()) return p
      pts.push(p.unwrap())
    }
    const points = pts.map(v3)
    if (pts.length === 2) {
      const m = measureBetween(pts[0]!, pts[1]!)
      return Ok({
        evaluation: state.status,
        points,
        distance: r3(m.distance),
        delta: v3(m.deltas as unknown as Vec3),
      })
    }
    const angle = angleAt(pts[0]!, pts[1]!, pts[2]!)
    if (angle === undefined)
      return fail(
        'input.malformed',
        `${WHERE}: points: the 1st or 3rd point is on the 2nd, so there is no angle; move it`,
        { where: WHERE, issues: [{ path: ['points'], rule: 'noAngle', message: 'coincident' }] },
      )
    return Ok({
      evaluation: state.status,
      points,
      angle: r3(angle),
      distances: [
        r3(measureBetween(pts[1]!, pts[0]!).distance),
        r3(measureBetween(pts[1]!, pts[2]!).distance),
      ] as [number, number],
    })
  },
})
