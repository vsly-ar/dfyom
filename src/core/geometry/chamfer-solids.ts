/**
 * Removal solid of an edge chamfer along a general edge (E1: inside edges, the top edge of a
 * pocket or an inside profile, every loop incl. islands; E2: the outside edge of an outside
 * profile). Spike S7: a V-bit whose axis follows the toolpath region P (the edge moved into the
 * air by the tip radius) has swept P ⊕ ρ(z) at height z, ρ(z) the tool's radius there (inside),
 * or the band (P ⊕ ρ) − (P ⊖ ρ) round P's loops (outside: the V-groove only, so the part inside
 * stays). The solid is that sweep, so it is what the tool cuts:
 * - offset-loft (normal path): P's analytic offsets (parallels, joint arcs, trims; an arc whose
 *   radius reaches 0 collapses into its neighbours' trim point) at a few levels, ruled bands,
 *   triangulated caps; vertical from the face to the overshoot, 0.04 mm past the edge into the
 *   air below (no film, the C2 rule). An outside edge is one annular mesh: the grown rings and
 *   the shrunk ones reversed, at the same levels. Every level is checked against the 2D port's
 *   offset (loop count, area within the chord band);
 * - fallback (the offset changes structure between levels): the tool swept along each chord of
 *   P as its own labelled mesh (a stadium frustum), unioned in the kernel by the evaluation (a
 *   float32 round trip of a unioned mesh is not a valid solid, S7 failure 1).
 * - a split piece's chamfer (`edge.within`, E2) subtracts everything outside its cell (grown by
 *   the tool's radius at the face) as a `cut`, so only the source's real edges are bevelled.
 * - a bottom chamfer's tabs (`edge.tabs`, E4b) subtract a disc prism round each tab as a `cut`:
 *   the toolpath lifts over the tabs, so the edge stays sharp there.
 * Doc: docs/modes/edge-chamfers.md#removal-solid, docs/modes/edge-chamfers.md#implementation-e1,
 * docs/modes/edge-chamfers.md#implementation-e2, docs/modes/edge-chamfers.md#implementation-e4b
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import { AIR, localSolids, Table, type LocalMesh, type LocalSolids } from './local-solids'
import { offsetLoft, type LabelledMesh } from './loft'
import {
  CHORD_TOLERANCE,
  EPSILON,
  OVERSHOOT,
  loopChamferDepth,
  loopChamferTabGap,
  type LoopChamferGeometry,
  type Vec2,
} from './model'
import {
  choosesEveryLoop,
  loopChamferAxis,
  loopChamferEdgeLoops,
  loopChamferLiftCorners,
  nearChosenLoop,
  type LiftCorner,
} from './outline'
import { flattenLoop, type Triangulate } from './prism'
import { translateRegion } from './2d/place'
import {
  chainBounds,
  regionArea,
  regionLoops,
  reverseLoop,
  signedArea,
  type Element,
  type Loop,
  type Region,
} from './2d/model'
import type { Region2dPort } from './2d/port'

/**
 * How far the solid's tool runs past the edge into the air (mm): the circular chamfer's run-in
 * (`CHAMFER_RUN_IN`, 4 × the chord tolerance), so the bevel meets the edge's wall inside the edge
 * operation's removal and leaves no film.
 */
export const LOOP_CHAMFER_RUN = 4 * CHORD_TOLERANCE

/** Largest radius step between two loft levels (mm), as spike S7. */
const LEVEL_STEP = 0.5

/** What the builder needs besides the chamfer: the caps' triangulator and the 2D port. */
export interface ChamferSolidsContext {
  readonly triangulate: Triangulate
  readonly region2d: Region2dPort
}

/**
 * The geometry tool of a loop chamfer: a V-bit of the chamfer's angle with tip diameter `tip`,
 * its tip `run / tan(α/2)` below the bevel's depth and `run` further into the air, so its cone
 * still meets the face `width` into the material. The design solid takes a pointed bit (tip 0):
 * the tool's own tip matters only in inside corners sharper than the tip radius and in necks
 * narrower than the tip (edge-chamfers.md § Implementation (E1)).
 */
export interface ChamferSweep {
  /** Toolpath region of the geometry tool (face frame of the shape's centre). */
  readonly path: Region
  /** Bottom level: radius and z (the cone cut where its radius is half the run). */
  readonly bottom: { readonly rho: number; readonly z: number }
  /** Radius at the face. */
  readonly faceRho: number
  readonly faceZ: number
}

function sweepOf(
  op: LoopChamferGeometry,
  port: Region2dPort,
  tip = 0,
): AppResult<ChamferSweep | undefined> {
  const r0 = tip / 2
  const tan = Math.tan(((op.angle / 2) * Math.PI) / 180)
  const tipZ = op.onZ - loopChamferDepth(op) - LOOP_CHAMFER_RUN / tan
  const rhoB = Math.max(r0, LOOP_CHAMFER_RUN / 2)
  return loopChamferAxis(op, port, r0 + LOOP_CHAMFER_RUN, true).map((path) =>
    path.pieces.length === 0
      ? undefined
      : {
          path,
          bottom: { rho: rhoB, z: tipZ + (rhoB - r0) / tan },
          faceRho: r0 + (op.onZ - tipZ) * tan,
          faceZ: op.onZ,
        },
  )
}

/**
 * The removal solid of a loop chamfer in its face frame: one offset-loft, else the swept chords
 * (`fallback`). Surfaces: `bevel` (display only, as a circular chamfer's `cone`).
 */
export function loopChamferSolids(
  op: LoopChamferGeometry,
  ctx: ChamferSolidsContext,
): AppResult<LocalSolids> {
  const table = new Table()
  const bevel = table.add('bevel')
  const at = [op.edge.shape.center[0], op.edge.shape.center[1], 0] as const
  return sweepOf(op, ctx.region2d).andThen((sweep) => {
    if (sweep === undefined)
      return fail('geometry.evaluation', `${op.id}: the edge leaves no room for the chamfer`, {
        issues: [
          {
            path: ['edgeOf'],
            rule: 'chamferEmpty',
            message: 'the edge operation is too narrow to chamfer',
            params: { edgeOf: op.edgeOf },
          },
        ],
        where: 'loopChamferSolids',
      })
    const levels = loftLevels(sweep)
    const outside = op.edge.side === 'outside'
    const meshes = choosesEveryLoop(op)
      ? sweepMeshes(sweep, levels, bevel, ctx, outside)
      : chosenBands(op, sweep, levels, bevel, ctx)
    if (meshes.isErr()) return Err(meshes.unwrapErr())
    if (op.cornerLift === true)
      for (const c of loopChamferLiftCorners(op, true)) {
        const kite = liftKite(c, levels, bevel, ctx.triangulate)
        if (kite.isErr()) return Err(kite.unwrapErr())
        meshes.unwrap().push(kite.unwrap())
      }
    const mask = withinMask(op, sweep, levels, bevel, ctx.triangulate)
    if (mask.isErr()) return Err(mask.unwrapErr())
    const tabs = tabMasks(op, levels, bevel, ctx.triangulate)
    if (tabs.isErr()) return Err(tabs.unwrapErr())
    return Ok(
      localSolids(op.id, table, {
        removal: meshes.unwrap().map((mesh): LocalMesh => ({ mesh, at })),
        cut: [...mask.unwrap(), ...tabs.unwrap()].map((mesh): LocalMesh => ({ mesh, at })),
      }),
    )
  })
}

/**
 * The sweep of every loop: one offset-loft, else the swept chords. An inside edge of several
 * pieces (a pattern's cells, patterns P3) is lofted and checked piece by piece (`pieceMeshes`).
 */
function sweepMeshes(
  sweep: ChamferSweep,
  levels: readonly LoftLevel[],
  label: number,
  ctx: ChamferSolidsContext,
  band: boolean,
): AppResult<LabelledMesh[]> {
  if (!band && sweep.path.pieces.length > 1) return pieceMeshes(sweep, levels, label, ctx)
  const loft = loopLoft(sweep.path, levels, label, ctx, band)
  return loft.isOk() ? Ok([loft.unwrap()]) : sweptChords(sweep, label)
}

// ── piece by piece (patterns P3) ─────────────────────────────────────────────────────────────

/** One piece's loft in its own frame (its box corner at the origin): rings per level and caps. */
interface PieceLoft {
  /** Per level, the piece's rings (outer, then its holes). */
  readonly rings: readonly (readonly Vec2[])[][]
  readonly capB: Uint32Array
  readonly capT: Uint32Array
}

/** What `pieceMeshes` did (tests, perf): pieces lofted, pieces swept, meshes, distinct pieces. */
export interface PieceStats {
  readonly lofted: number
  readonly fallback: number
  readonly meshes: number
  readonly groups: number
}

/**
 * A path of several pieces (patterns.md § Chamfer, spike S8): the loft is built and checked
 * against the 2D port **per piece**, never per region or per group of pieces (one cell whose
 * offset changes structure would send every cell to the fallback). Pieces that are translated
 * copies of one another (a pattern's cells) share one loft, check and cap triangulation. Pieces
 * whose bevels meet (their paths nearer than twice the face radius) must not share a mesh (it
 * would self-intersect), so the pieces are coloured greedily over that graph: every piece that
 * meets none goes into the first mesh, and each mesh holds pieces that are pairwise apart. The
 * meshes are unioned in the kernel by the evaluation. A piece whose own offset changes structure
 * is swept chord by chord, alone.
 */
function pieceMeshes(
  sweep: ChamferSweep,
  levels: readonly LoftLevel[],
  label: number,
  ctx: ChamferSolidsContext,
  stats?: { value?: PieceStats },
): AppResult<LabelledMesh[]> {
  const pieces = sweep.path.pieces
  // 1. group the pieces by their geometry less their box corner
  const keys = new Map<string, number>()
  const reps: Region[] = []
  const groupOf: number[] = []
  const origins: Vec2[] = []
  const boxes: { min: Vec2; max: Vec2 }[] = []
  for (const p of pieces) {
    const b = chainBounds(p.outer.elements)!
    const o = b.min
    const local: Region = translateRegion({ pieces: [p] }, [-o[0], -o[1]])
    const key = regionKey(local)
    let g = keys.get(key)
    if (g === undefined) {
      keys.set(key, (g = reps.length))
      reps.push(local)
    }
    groupOf.push(g)
    origins.push(o)
    boxes.push(b)
  }
  // 2. one loft (or none: the fallback) per group
  const lofts: (PieceLoft | undefined)[] = []
  for (const r of reps) {
    const l = pieceLoft(r, levels, ctx)
    lofts.push(l.isOk() ? l.unwrap() : undefined)
  }
  // 3. which pieces' bevels meet: grown boxes on a bucket grid, then the paths' distance
  const reach = sweep.faceRho + 2 * CHORD_TOLERANCE + 1e-6
  const flat = reps.map((r) => regionLoops(r).map((l) => flattenLoop(l, 'shrink').points))
  const meets = new Map<string, boolean>()
  const near = (i: number, j: number): boolean => {
    const d: Vec2 = [origins[j]![0] - origins[i]![0], origins[j]![1] - origins[i]![1]]
    const k = `${groupOf[i]},${groupOf[j]},${Math.round(d[0] * 1e6)},${Math.round(d[1] * 1e6)}`
    let m = meets.get(k)
    if (m === undefined) {
      m = ringsWithin(flat[groupOf[i]!]!, flat[groupOf[j]!]!, d, 2 * reach)
      meets.set(k, m)
    }
    return m
  }
  const neighbours = boxNeighbours(boxes, reach, near)
  // 4. greedy colouring: one mesh per colour
  const colour = new Int32Array(pieces.length).fill(-1)
  const members: number[][] = []
  const swept: number[] = []
  for (let i = 0; i < pieces.length; i++) {
    if (lofts[groupOf[i]!] === undefined) {
      swept.push(i)
      continue
    }
    const used = new Set<number>()
    for (const j of neighbours[i]!) if (colour[j]! >= 0) used.add(colour[j]!)
    let c = 0
    while (used.has(c)) c++
    colour[i] = c
    ;(members[c] ??= []).push(i)
  }
  const out: LabelledMesh[] = []
  for (const m of members)
    out.push(
      piecesMesh(
        m.map((i) => ({ loft: lofts[groupOf[i]!]!, at: origins[i]! })),
        levels,
        label,
      ),
    )
  for (const i of swept) {
    const s = sweptChords({ ...sweep, path: { pieces: [pieces[i]!] } }, label)
    if (s.isErr()) return s
    out.push(...s.unwrap())
  }
  if (stats !== undefined)
    stats.value = {
      lofted: pieces.length - swept.length,
      fallback: swept.length,
      meshes: out.length,
      groups: reps.length,
    }
  return Ok(out)
}

/** A key of a region's geometry (to 10⁻⁶ mm): equal keys are the same piece. */
function regionKey(r: Region): string {
  const n = (x: number) => Math.round(x * 1e6)
  const p = (v: Vec2) => `${n(v[0])},${n(v[1])}`
  return regionLoops(r)
    .map((l) =>
      l.elements
        .map((e) =>
          e.kind === 'line'
            ? `l${p(e.a)},${p(e.b)}`
            : `a${p(e.a)},${p(e.b)},${p(e.centre)},${e.ccw ? 1 : 0}`,
        )
        .join(';'),
    )
    .join('|')
}

/** One piece's loft rings and caps, checked per level against the 2D port, or why not. */
function pieceLoft(
  piece: Region,
  levels: readonly LoftLevel[],
  ctx: ChamferSolidsContext,
): AppResult<PieceLoft> {
  const loops = regionLoops(piece)
  const rhoMax = Math.max(...levels.map((l) => l.rho))
  const plans = loops.map((l) => planFor(l, -rhoMax, CHORD_TOLERANCE))
  const rings: Vec2[][][] = []
  let checked = -1
  for (const lv of levels) {
    const rs: Vec2[][] = []
    for (const [k, l] of loops.entries()) {
      const r = offsetRing(l, -lv.rho, plans[k]!)
      if (typeof r === 'string') return loftInvalid(r, { offset: -lv.rho })
      rs.push(r)
    }
    if (lv.rho !== checked) {
      const ok = sameAsPort(piece, rs, -lv.rho, ctx.region2d)
      if (ok !== undefined) return loftInvalid(ok, { offset: -lv.rho })
    }
    checked = lv.rho
    rings.push(rs)
  }
  const capB = ctx.triangulate(rings[0]!)
  if (capB.isErr()) return capB
  const capT = ctx.triangulate(rings.at(-1)!)
  if (capT.isErr()) return capT
  return Ok({ rings, capB: capB.unwrap(), capT: capT.unwrap() })
}

/**
 * For every piece, the pieces whose boxes grown by `reach` overlap its own and for which `near`
 * holds (a bucket grid of the boxes: linear for a pattern's cells).
 */
function boxNeighbours(
  boxes: readonly { min: Vec2; max: Vec2 }[],
  reach: number,
  near: (i: number, j: number) => boolean,
): number[][] {
  const out: number[][] = boxes.map(() => [])
  if (boxes.length === 0) return out
  let size = 0
  for (const b of boxes) size = Math.max(size, b.max[0] - b.min[0], b.max[1] - b.min[1])
  size += 2 * reach
  const cellOf = (x: number) => Math.floor(x / size)
  const grid = new Map<string, number[]>()
  boxes.forEach((b, i) => {
    const k = `${cellOf(b.min[0])},${cellOf(b.min[1])}`
    const l = grid.get(k)
    if (l === undefined) grid.set(k, [i])
    else l.push(i)
  })
  boxes.forEach((b, i) => {
    const cx = cellOf(b.min[0])
    const cy = cellOf(b.min[1])
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j <= i) continue
          const c = boxes[j]!
          if (
            b.min[0] - reach > c.max[0] + reach ||
            c.min[0] - reach > b.max[0] + reach ||
            b.min[1] - reach > c.max[1] + reach ||
            c.min[1] - reach > b.max[1] + reach
          )
            continue
          if (!near(i, j)) continue
          out[i]!.push(j)
          out[j]!.push(i)
        }
  })
  return out
}

/** Whether rings `a` and rings `b` moved by `d` come nearer than `limit` (closed polylines). */
function ringsWithin(
  a: readonly (readonly Vec2[])[],
  b: readonly (readonly Vec2[])[],
  d: Vec2,
  limit: number,
): boolean {
  const moved = b.map((r) => r.map((p): Vec2 => [p[0] + d[0], p[1] + d[1]]))
  for (const ra of a)
    for (let i = 0; i < ra.length; i++) {
      const p = ra[i]!
      const q = ra[(i + 1) % ra.length]!
      for (const rb of moved)
        for (let j = 0; j < rb.length; j++)
          if (segmentDistance(p, q, rb[j]!, rb[(j + 1) % rb.length]!) < limit) return true
    }
  return false
}

function segmentDistance(p: Vec2, q: Vec2, r: Vec2, s: Vec2): number {
  const d1 = sub(q, p)
  const d2 = sub(s, r)
  // crossing segments
  const den = cross(d1, d2)
  if (Math.abs(den) > 1e-15) {
    const t = cross(sub(r, p), d2) / den
    const u = cross(sub(r, p), d1) / den
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0
  }
  return Math.min(
    pointSegment(p, r, s),
    pointSegment(q, r, s),
    pointSegment(r, p, q),
    pointSegment(s, p, q),
  )
}

function pointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2))
  return dist(p, add(a, mul(ab, t)))
}

/** One mesh of pieces that are pairwise apart: each piece's loft moved to its box corner. */
function piecesMesh(
  parts: readonly { loft: PieceLoft; at: Vec2 }[],
  levels: readonly LoftLevel[],
  label: number,
): LabelledMesh {
  let vertices = 0
  let triangles = 0
  let bandTris = 0
  for (const { loft } of parts) {
    const perLevel = loft.rings[0]!.reduce((s, r) => s + r.length, 0)
    vertices += perLevel * levels.length
    bandTris += 2 * perLevel * (levels.length - 1)
    triangles += loft.capB.length / 3 + loft.capT.length / 3
  }
  triangles += bandTris
  const positions = new Float64Array(vertices * 3)
  const tris = new Uint32Array(triangles * 3)
  const faces = new Uint32Array(triangles)
  let v = 0
  let t = 0
  let base = 0
  // band triangles first (labelled), then the caps (air), as `loftMesh`
  const caps: number[] = []
  for (const { loft, at } of parts) {
    const counts = loft.rings[0]!.map((r) => r.length)
    const perLevel = counts.reduce((a, b) => a + b, 0)
    for (const [k, rs] of loft.rings.entries())
      for (const r of rs)
        for (const p of r) {
          positions[v++] = p[0] + at[0]
          positions[v++] = p[1] + at[1]
          positions[v++] = levels[k]!.z
        }
    let start = 0
    for (const n of counts) {
      for (let k = 0; k + 1 < levels.length; k++) {
        const b0 = base + k * perLevel + start
        const b1 = base + (k + 1) * perLevel + start
        for (let i = 0; i < n; i++) {
          const i1 = (i + 1) % n
          faces[t / 3] = label
          tris[t++] = b0 + i
          tris[t++] = b0 + i1
          tris[t++] = b1 + i1
          faces[t / 3] = label
          tris[t++] = b0 + i
          tris[t++] = b1 + i1
          tris[t++] = b1 + i
        }
      }
      start += n
    }
    for (let k = 0; k < loft.capB.length; k += 3)
      caps.push(base + loft.capB[k]!, base + loft.capB[k + 2]!, base + loft.capB[k + 1]!)
    const top = base + (levels.length - 1) * perLevel
    for (let k = 0; k < loft.capT.length; k += 3)
      caps.push(top + loft.capT[k]!, top + loft.capT[k + 1]!, top + loft.capT[k + 2]!)
    base += perLevel * levels.length
  }
  tris.set(caps, t)
  return { positions, triangles: tris, faces }
}

/**
 * Chosen loops (E4a): per chosen loop of the sweep's path, the V-groove band round that loop
 * alone (the outside edge's construction), so the other loops keep their sharp edge.
 */
function chosenBands(
  op: LoopChamferGeometry,
  sweep: ChamferSweep,
  levels: readonly LoftLevel[],
  label: number,
  ctx: ChamferSolidsContext,
): AppResult<LabelledMesh[]> {
  const edges = loopChamferEdgeLoops(op, true)
  const out: LabelledMesh[] = []
  for (const l of regionLoops(sweep.path)) {
    const first = l.elements[0]
    if (first === undefined || !nearChosenLoop(edges, first.a)) continue
    const outer = signedArea(l) < 0 ? reverseLoop(l) : l
    const one: ChamferSweep = { ...sweep, path: { pieces: [{ outer, holes: [] }] } }
    const m = sweepMeshes(one, levels, label, ctx, true)
    if (m.isErr()) return m
    out.push(...m.unwrap())
  }
  return Ok(out)
}

/**
 * The mitre a corner lift adds at a sharp corner (E4a): at each level the kite between the
 * path's vertex (the edge's corner moved `run` into the air), the two bevels' offsets by ρ and
 * their mitre point ρ / sin(θ/2) along the bisector, lofted as the sweep's levels; its own
 * removal mesh, unioned with the loft in the kernel.
 */
function liftKite(
  c: LiftCorner,
  levels: readonly LoftLevel[],
  label: number,
  triangulate: Triangulate,
): AppResult<LabelledMesh> {
  const vp = add(c.v, mul(c.bisector, -LOOP_CHAMFER_RUN / c.sinHalf))
  const cos = c.sinHalf
  const sin = Math.sqrt(Math.max(0, 1 - cos * cos))
  const turn = (s: number): Vec2 => [
    c.bisector[0] * cos - s * c.bisector[1] * sin,
    c.bisector[0] * s * sin + c.bisector[1] * cos,
  ]
  const n1 = turn(1)
  const n2 = turn(-1)
  const ring = (rho: number): Vec2[] => {
    const r: Vec2[] = [
      vp,
      add(vp, mul(n2, rho)),
      add(vp, mul(c.bisector, rho / c.sinHalf)),
      add(vp, mul(n1, rho)),
    ]
    return ringArea(r) < 0 ? r.reverse() : r
  }
  return loftMesh(
    levels.map((lv) => [ring(lv.rho)]),
    levels,
    label,
    triangulate,
  )
}

interface Box {
  readonly min: Vec2
  readonly max: Vec2
}

/**
 * A split piece's mask (E2, `edge.within`): an annular prism from beyond the sweep's bounds in
 * to the cell grown by the tool's radius at the face, through the removal's height. Subtracted
 * from the removal, it keeps the bevel of the source's real edges in the cell and drops the rest
 * of the source loop (the neighbouring pieces' edges). None when the sweep lies inside.
 */
function withinMask(
  op: LoopChamferGeometry,
  s: ChamferSweep,
  levels: readonly LoftLevel[],
  label: number,
  triangulate: Triangulate,
): AppResult<LabelledMesh[]> {
  const w = op.edge.within
  if (w === undefined) return Ok([])
  const c = op.edge.shape.center
  const m = s.faceRho
  const inner: Box = {
    min: [w.min[0] - c[0] - m, w.min[1] - c[1] - m],
    max: [w.max[0] - c[0] + m, w.max[1] - c[1] + m],
  }
  let lo: Vec2 = [Infinity, Infinity]
  let hi: Vec2 = [-Infinity, -Infinity]
  for (const l of regionLoops(s.path))
    for (const p of flattenLoop(l, 'shrink').points) {
      lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])]
      hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])]
    }
  if (
    lo[0] - m >= inner.min[0] &&
    lo[1] - m >= inner.min[1] &&
    hi[0] + m <= inner.max[0] &&
    hi[1] + m <= inner.max[1]
  )
    return Ok([])
  const pad = m + 1
  const outer: Box = {
    min: [Math.min(lo[0], inner.min[0]) - pad, Math.min(lo[1], inner.min[1]) - pad],
    max: [Math.max(hi[0], inner.max[0]) + pad, Math.max(hi[1], inner.max[1]) + pad],
  }
  const rect = (b: Box, ccw: boolean): Vec2[] => {
    const r: Vec2[] = [
      [b.min[0], b.min[1]],
      [b.max[0], b.min[1]],
      [b.max[0], b.max[1]],
      [b.min[0], b.max[1]],
    ]
    return ccw ? r : r.reverse()
  }
  const ring = [rect(outer, true), rect(inner, false)]
  const z0 = levels[0]!.z - 1
  const z1 = levels.at(-1)!.z + 1
  return loftMesh(
    [ring, ring],
    [
      { z: z0, rho: 0 },
      { z: z1, rho: 0 },
    ],
    label,
    triangulate,
  ).map((mesh) => [mesh])
}

/** Sides of a tab mask's polygon (E4b). */
const TAB_MASK_SIDES = 48

/**
 * A bottom chamfer's tab masks (E4b, `edge.tabs`): per tab a vertical prism round its centre on
 * the edge, through the removal's height, subtracted from the removal, so the tab stays whole.
 * Its radius is the toolpath's gap for a pointed bit less half the width: the bevel ends square
 * half-way along the taper the cone leaves where the tool lifts (edge-chamfers.md E4b).
 */
function tabMasks(
  op: LoopChamferGeometry,
  levels: readonly LoftLevel[],
  label: number,
  triangulate: Triangulate,
): AppResult<LabelledMesh[]> {
  const out: LabelledMesh[] = []
  const c = op.edge.shape.center
  const z0 = levels[0]!.z - 1
  const z1 = levels.at(-1)!.z + 1
  for (const t of op.edge.tabs ?? []) {
    const r = loopChamferTabGap(t, op.width) - op.width / 2
    const ring: Vec2[] = Array.from({ length: TAB_MASK_SIDES }, (_, k) => {
      const a = (2 * Math.PI * k) / TAB_MASK_SIDES
      return [t.at[0] - c[0] + r * Math.cos(a), t.at[1] - c[1] + r * Math.sin(a)]
    })
    const m = loftMesh(
      [[ring], [ring]],
      [
        { z: z0, rho: 0 },
        { z: z1, rho: 0 },
      ],
      label,
      triangulate,
    )
    if (m.isErr()) return Err(m.unwrapErr())
    out.push(m.unwrap())
  }
  return Ok(out)
}

/** Which construction `loopChamferSolids` takes for `op` (tests, perf): `loft` or `fallback`. */
export function loopChamferConstruction(
  op: LoopChamferGeometry,
  ctx: ChamferSolidsContext,
): 'loft' | 'fallback' | 'empty' {
  const sweep = sweepOf(op, ctx.region2d)
  if (sweep.isErr() || sweep.unwrap() === undefined) return 'empty'
  const s = sweep.unwrap()!
  const outside = op.edge.side === 'outside'
  if (!outside && s.path.pieces.length > 1)
    return loopChamferPieces(op, ctx)?.fallback === 0 ? 'loft' : 'fallback'
  return loopLoft(s.path, loftLevels(s), 0, ctx, outside).isOk() ? 'loft' : 'fallback'
}

/**
 * What the piece-by-piece construction does for an inside edge of several pieces (patterns P3;
 * tests, perf): pieces lofted and swept, meshes, distinct pieces. Undefined otherwise.
 */
export function loopChamferPieces(
  op: LoopChamferGeometry,
  ctx: ChamferSolidsContext,
): PieceStats | undefined {
  const sweep = sweepOf(op, ctx.region2d)
  if (sweep.isErr() || sweep.unwrap() === undefined) return undefined
  const s = sweep.unwrap()!
  if (op.edge.side === 'outside' || s.path.pieces.length < 2) return undefined
  const stats: { value?: PieceStats } = {}
  return pieceMeshes(s, loftLevels(s), 0, ctx, stats).isOk() ? stats.value : undefined
}

interface LoftLevel {
  readonly z: number
  readonly rho: number
}

/** Bottom to face in radius steps of at most `LEVEL_STEP`, then the overshoot (vertical). */
function loftLevels(s: ChamferSweep): LoftLevel[] {
  const n = Math.max(1, Math.ceil((s.faceRho - s.bottom.rho) / LEVEL_STEP - 1e-9))
  const out: LoftLevel[] = []
  for (let k = 0; k <= n; k++)
    out.push({
      z: s.bottom.z + ((s.faceZ - s.bottom.z) * k) / n,
      rho: s.bottom.rho + ((s.faceRho - s.bottom.rho) * k) / n,
    })
  out.push({ z: Math.max(OVERSHOOT, s.faceZ + OVERSHOOT), rho: s.faceRho })
  return out
}

// ── offset-loft ──────────────────────────────────────────────────────────────────────────────

function loftInvalid(message: string, data: Readonly<Record<string, unknown>> = {}) {
  return fail('geometry.evaluation', message, {
    issues: [{ path: [], rule: 'chamferLoft', message, params: data }],
    where: 'loopLoft',
    data,
  })
}

/**
 * One closed mesh through `path` grown by each level's ρ (bottom first): per loop a ring of the
 * same point count at every level, bands between them, caps by `triangulate`. With `band`
 * (outside edges, E2) the path shrunk by ρ joins as reversed rings: the annular V-groove between
 * them. Fails (rule `chamferLoft`) where the analytic offset is not valid: the caller then sweeps
 * the chords.
 */
function loopLoft(
  path: Region,
  levels: readonly LoftLevel[],
  label: number,
  ctx: ChamferSolidsContext,
  band = false,
): AppResult<LabelledMesh> {
  const loops = regionLoops(path)
  const rhoMax = Math.max(...levels.map((l) => l.rho))
  const sides = band ? [-1, 1] : [-1]
  const plans = sides.map((sg) => loops.map((l) => planFor(l, sg * rhoMax, CHORD_TOLERANCE)))
  const rings: Vec2[][][] = []
  let checked = -1
  for (const lv of levels) {
    const rs: Vec2[][] = []
    for (const [j, sg] of sides.entries()) {
      const d = sg * lv.rho
      const side: Vec2[][] = []
      for (const [k, l] of loops.entries()) {
        const r = offsetRing(l, d, plans[j]![k]!)
        if (typeof r === 'string') return loftInvalid(r, { offset: d })
        side.push(r)
      }
      // the vertical top repeats the face level's rings: checked once
      if (lv.rho !== checked) {
        const ok = sameAsPort(path, side, d, ctx.region2d)
        if (ok !== undefined) return loftInvalid(ok, { offset: d })
      }
      // the shrunk rings reversed: the region between them is on every ring's left
      rs.push(...(sg > 0 ? side.map((r) => [...r].reverse()) : side))
    }
    checked = lv.rho
    rings.push(rs)
  }
  return loftMesh(rings, levels, label, ctx.triangulate)
}

/** Undefined when the rings match the port's offset (loop count; area within the chord band). */
function sameAsPort(
  path: Region,
  rings: readonly Vec2[][],
  d: number,
  port: Region2dPort,
): string | undefined {
  const ref = port.offset(path, d)
  if (ref.isErr()) return 'the 2D offset failed'
  const region = ref.unwrap()
  if (regionLoops(region).length !== rings.length) return 'the loop count changes'
  const area = rings.reduce((s, r) => s + ringArea(r), 0)
  const perimeter = rings.reduce(
    (s, r) => s + r.reduce((q, p, i) => q + dist(p, r[(i + 1) % r.length]!), 0),
    0,
  )
  return Math.abs(area - regionArea(region)) > perimeter * CHORD_TOLERANCE * 1.5 + 1e-6
    ? 'the offset area differs from the 2D offset'
    : undefined
}

function loftMesh(
  rings: readonly Vec2[][][],
  levels: readonly LoftLevel[],
  label: number,
  triangulate: Triangulate,
): AppResult<LabelledMesh> {
  const counts = rings[0]!.map((r) => r.length)
  const perLevel = counts.reduce((a, b) => a + b, 0)
  const positions = new Float64Array(levels.length * perLevel * 3)
  let v = 0
  for (const [k, rs] of rings.entries())
    for (const r of rs)
      for (const p of r) {
        positions[v++] = p[0]
        positions[v++] = p[1]
        positions[v++] = levels[k]!.z
      }
  const tris: number[] = []
  const starts = counts.map((_, l) => counts.slice(0, l).reduce((a, b) => a + b, 0))
  for (let k = 0; k + 1 < levels.length; k++)
    for (const [l, n] of counts.entries()) {
      const b0 = k * perLevel + starts[l]!
      const b1 = (k + 1) * perLevel + starts[l]!
      for (let i = 0; i < n; i++) {
        const i1 = (i + 1) % n
        // rings run with their region on the left: band faces point out of it
        tris.push(b0 + i, b0 + i1, b1 + i1, b0 + i, b1 + i1, b1 + i)
      }
    }
  const bottom = triangulate(rings[0]!)
  if (bottom.isErr()) return bottom
  const top = triangulate(rings.at(-1)!)
  if (top.isErr()) return top
  const capB = bottom.unwrap()
  for (let t = 0; t < capB.length; t += 3) tris.push(capB[t]!, capB[t + 2]!, capB[t + 1]!)
  const topBase = (levels.length - 1) * perLevel
  const capT = top.unwrap()
  for (let t = 0; t < capT.length; t += 3)
    tris.push(topBase + capT[t]!, topBase + capT[t + 1]!, topBase + capT[t + 2]!)
  // collapsed arcs give coincident points (distinct vertices): their degenerate band triangles
  // keep the mesh closed and the kernel drops them, as in spike S7
  const bandCount = (tris.length - capB.length - capT.length) / 3
  const faces = new Uint32Array(tris.length / 3)
  faces.fill(label, 0, bandCount)
  return Ok({ positions, triangles: Uint32Array.from(tris), faces })
}

// ── the analytic offset of one loop (spike S7 `loft.ts`) ────────────────────────────────────

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]]
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k]
const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0]
const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1]
const len = (a: Vec2): number => Math.hypot(a[0], a[1])
const dist = (a: Vec2, b: Vec2): number => len(sub(a, b))
const unit = (a: Vec2): Vec2 => mul(a, 1 / len(a))
const left = (t: Vec2): Vec2 => [-t[1], t[0]]
const angleOf = (c: Vec2, p: Vec2): number => Math.atan2(p[1] - c[1], p[0] - c[0])

type Arc = Extract<Element, { kind: 'arc' }>

function tangent(e: Element, end: 'a' | 'b'): Vec2 {
  if (e.kind === 'line') return unit(sub(e.b, e.a))
  const n = unit(sub(e[end], e.centre))
  return e.ccw ? left(n) : mul(left(n), -1)
}

function sweepOfArc(e: Arc): number {
  if (dist(e.a, e.b) < 1e-12) return 2 * Math.PI
  let d = e.ccw
    ? angleOf(e.centre, e.b) - angleOf(e.centre, e.a)
    : angleOf(e.centre, e.a) - angleOf(e.centre, e.b)
  while (d <= 0) d += 2 * Math.PI
  return d
}

/** An element's parallel at signed distance d to its left, as a full line or circle. */
interface Parallel {
  readonly kind: 'line' | 'arc'
  /** Line: a point and the direction. */
  readonly p: Vec2
  readonly t: Vec2
  /** Arc: centre, radius, sense. */
  readonly c: Vec2
  readonly r: number
  readonly ccw: boolean
  /** Its start and end point, trimmed at the joints. */
  s: Vec2
  e: Vec2
}

function parallel(e: Element, d: number): Parallel | undefined {
  if (e.kind === 'line') {
    const t = unit(sub(e.b, e.a))
    const n = mul(left(t), d)
    return {
      kind: 'line',
      p: add(e.a, n),
      t,
      c: [0, 0],
      r: 0,
      ccw: true,
      s: add(e.a, n),
      e: add(e.b, n),
    }
  }
  const R = dist(e.a, e.centre)
  // the centre is on the left of a counter-clockwise arc: moving left shrinks it
  const r = e.ccw ? R - d : R + d
  if (!(r > 1e-9)) return undefined
  const at = (p: Vec2): Vec2 => add(e.centre, mul(unit(sub(p, e.centre)), r))
  return { kind: 'arc', p: [0, 0], t: [0, 0], c: e.centre, r, ccw: e.ccw, s: at(e.a), e: at(e.b) }
}

function intersections(u: Parallel, v: Parallel): Vec2[] {
  if (u.kind === 'line' && v.kind === 'line') {
    const den = cross(u.t, v.t)
    if (Math.abs(den) < 1e-15) return []
    return [add(u.p, mul(u.t, cross(sub(v.p, u.p), v.t) / den))]
  }
  if (u.kind === 'arc' && v.kind === 'line') return intersections(v, u)
  if (u.kind === 'line') {
    const f = sub(u.p, v.c)
    const b = dot(f, u.t)
    const disc = b * b - (dot(f, f) - v.r * v.r)
    if (disc < 0) return []
    const q = Math.sqrt(disc)
    return [add(u.p, mul(u.t, -b - q)), add(u.p, mul(u.t, -b + q))]
  }
  const dv = sub(v.c, u.c)
  const D = len(dv)
  if (D < 1e-15 || D > u.r + v.r || D < Math.abs(u.r - v.r)) return []
  const a = (u.r * u.r - v.r * v.r + D * D) / (2 * D)
  const h = Math.sqrt(Math.max(0, u.r * u.r - a * a))
  const m = add(u.c, mul(dv, a / D))
  const n = mul(left(unit(dv)), h)
  return [add(m, n), sub(m, n)]
}

/**
 * Point counts fixed for every level of one loop: per element (arc segments) and per joint
 * (0 = trimmed, −1 = tangent, else joint arc segments).
 */
interface RingPlan {
  readonly elementSegs: readonly number[]
  readonly jointSegs: readonly number[]
}

function planFor(loop: Loop, dMax: number, tol: number): RingPlan {
  const els = loop.elements
  const segs = (r: number, sweep: number) =>
    Math.max(1, Math.ceil(sweep / (2 * Math.acos(Math.max(-1, 1 - tol / Math.max(r, tol))))))
  const elementSegs = els.map((e) =>
    e.kind === 'line' ? 1 : segs(dist(e.a, e.centre) + Math.abs(dMax), sweepOfArc(e)),
  )
  const jointSegs = els.map((e, i) => {
    const t1 = tangent(e, 'b')
    const t2 = tangent(els[(i + 1) % els.length]!, 'a')
    const c = cross(t1, t2)
    if (Math.abs(c) < 1e-6 && dot(t1, t2) > 0) return -1
    // a left turn opens a gap when moving right (d < 0), a right turn when moving left
    const gap = dMax < 0 ? c > 0 : c < 0
    if (!gap) return 0
    return segs(Math.abs(dMax), Math.abs(Math.atan2(c, dot(t1, t2))))
  })
  return { elementSegs, jointSegs }
}

/** The loop's analytic offset by `d` (left) as points, or why it is not valid. */
function offsetRing(loop: Loop, d: number, plan: RingPlan): Vec2[] | string {
  const els = loop.elements
  const n = els.length
  const pars = els.map((e) => parallel(e, d))
  const alive = pars.map((p) => p !== undefined)
  if (!alive.some(Boolean)) return 'every element collapsed'
  const collapsedAt = new Map<number, Vec2>()
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue
    let j = (i + 1) % n
    const between: number[] = []
    while (!alive[j]) {
      between.push(j)
      j = (j + 1) % n
    }
    const u = pars[i]!
    const v = pars[j]!
    if (between.length === 0 && plan.jointSegs[i]! > 0) continue
    const V = els[i]!.b
    if (between.length === 0 && (plan.jointSegs[i] === -1 || dist(u.e, v.s) < 1e-7)) {
      const m = mul(add(u.e, v.s), 0.5)
      u.e = m
      v.s = m
      continue
    }
    if (
      between.some((k) => plan.jointSegs[k]! > 0) ||
      (between.length > 0 && plan.jointSegs[i]! > 0)
    )
      return 'a collapsed arc next to a joint arc'
    const xs = intersections(u, v)
    if (xs.length === 0) return `no trim point at joint ${i}`
    let best = xs[0]!
    for (const x of xs) if (dist(x, V) < dist(best, V)) best = x
    u.e = best
    v.s = best
    for (const k of between) collapsedAt.set(k, best)
  }
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const e = els[i]!
    if (!alive[i]) {
      const p = collapsedAt.get(i)
      if (p === undefined) return `arc ${i} collapsed without a trim point`
      for (let j = 0; j < plan.elementSegs[i]!; j++) out.push(p)
      continue
    }
    const u = pars[i]!
    if (u.kind === 'line') {
      // the trimmed line keeps its direction, else the element vanished
      if (dot(sub(u.e, u.s), u.t) <= 1e-9) return `line ${i} vanished`
      out.push(u.s)
    } else {
      const a0 = angleOf(u.c, u.s)
      let sw = u.ccw ? angleOf(u.c, u.e) - a0 : a0 - angleOf(u.c, u.e)
      const full = sweepOfArc(e as Arc)
      while (sw <= -Math.PI) sw += 2 * Math.PI
      while (sw > 2 * Math.PI) sw -= 2 * Math.PI
      if (full >= 2 * Math.PI - 1e-12 && dist(u.s, u.e) < 1e-9) sw = 2 * Math.PI
      else if (sw <= 0) {
        if (full > Math.PI) sw += 2 * Math.PI
        else return `arc ${i} vanished`
      }
      if (Math.abs(sw - full) > Math.PI) return `arc ${i} flipped`
      const k = plan.elementSegs[i]!
      for (let j = 0; j < k; j++) {
        const t = a0 + ((u.ccw ? 1 : -1) * (sw * j)) / k
        out.push([u.c[0] + u.r * Math.cos(t), u.c[1] + u.r * Math.sin(t)])
      }
    }
    const m = plan.jointSegs[i]!
    if (m > 0) {
      // the joint arc round the vertex from this parallel's end to the next one's start
      const V = e.b
      const v = pars[(i + 1) % n]
      if (v === undefined) return 'a joint arc before a collapsed arc'
      const a0 = angleOf(V, u.e)
      let sw = angleOf(V, v.s) - a0
      if (d < 0) while (sw < 0) sw += 2 * Math.PI
      else while (sw > 0) sw -= 2 * Math.PI
      for (let j = 0; j < m; j++) {
        const t = a0 + (sw * j) / m
        out.push([V[0] + Math.abs(d) * Math.cos(t), V[1] + Math.abs(d) * Math.sin(t)])
      }
    }
  }
  return out
}

function ringArea(r: readonly Vec2[]): number {
  let s = 0
  for (let i = 0; i < r.length; i++) s += cross(r[i]!, r[(i + 1) % r.length]!)
  return s / 2
}

// ── fallback: the tool swept along each chord ───────────────────────────────────────────────

/**
 * Per chord a→b of P (flattened within the chord tolerance, into the air): the tool swept along
 * it, a stadium of length |ab| + 2ρ and width 2ρ lofted from ρ at the bottom to the face and on
 * vertically to the overshoot, turned along ab. Each is one labelled mesh; the evaluation unions
 * an operation's removal meshes in the kernel.
 */
function sweptChords(s: ChamferSweep, label: number): AppResult<LabelledMesh[]> {
  const top = Math.max(OVERSHOOT, s.faceZ + OVERSHOOT)
  const out: LabelledMesh[] = []
  for (const loop of regionLoops(s.path)) {
    const { points } = flattenLoop(loop, 'shrink')
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!
      const b = points[(i + 1) % points.length]!
      const L = dist(a, b)
      if (L <= EPSILON) continue
      const mesh = offsetLoft(
        {
          kind: 'rectangle',
          length: L + 2 * s.faceRho,
          width: 2 * s.faceRho,
          cornerRadius: s.faceRho,
        },
        [
          { offset: 0, z: top },
          { offset: 0, z: s.faceZ },
          { offset: s.faceRho - s.bottom.rho, z: s.bottom.z },
        ],
        { band: () => label, top: AIR, bottom: AIR },
      )
      if (mesh.isErr()) return Err(mesh.unwrapErr())
      out.push(placeChord(mesh.unwrap(), a, b))
    }
  }
  return Ok(out)
}

/** A mesh built along +x about the origin, turned along a→b and moved to its middle. */
function placeChord(mesh: LabelledMesh, a: Vec2, b: Vec2): LabelledMesh {
  const t = unit(sub(b, a))
  const m = mul(add(a, b), 0.5)
  const p = Float64Array.from(mesh.positions)
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!
    const y = p[i + 1]!
    p[i] = m[0] + x * t[0] - y * t[1]
    p[i + 1] = m[1] + x * t[1] + y * t[0]
  }
  return { ...mesh, positions: p }
}
