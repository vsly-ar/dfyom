/**
 * Region booleans and normalisation folded from a loop-to-loop boolean (CavalierContours has only
 * those, ADR 0019 decision 3). Library-neutral: the loop boolean is passed in, so this runs on the
 * WASM binding in the app and on any fake in tests. Doc: docs/architecture/shapes.md#2d-port
 *
 * A region is pieces (outer loop + holes, island in a hole = its own piece); pieces never overlap.
 * - A − S = per piece s of S: (A − outer(s)) ⊔ (A ∩ hole) for each hole of s.
 * - A ∩ S = per piece s of S: (A ∩ outer(s)) − each hole of s.
 * - A ∪ S: hole-free inputs fold the outer loops directly; otherwise by De Morgan inside a box B
 *   around both: B − ((B − A) ∩ (B − S)).
 * Pieces of a loop boolean are simple loops; the holes of the piece they came from are then
 * subtracted again (`subtractHoles`), which keeps every result normalised.
 */
import { Err, Ok, type AppResult } from '../../../shared/result'
import type { Vec2 } from '../model'
import { elementPointAt, onLoop, windingNumber } from './measure'
import {
  boundsOverlap,
  chainBounds,
  elementLength,
  line,
  MIN_ELEMENT_LENGTH,
  OFFSET_EPSILON,
  reverseLoop,
  signedArea,
  type Bounds2,
  type Loop,
  type Region,
  type RegionPiece,
} from './model'

export type LoopBooleanOp = 'or' | 'and' | 'not'

/** Result of a loop boolean: positive loops counter-clockwise, negative (enclosed) loops clockwise. */
export interface LoopBooleanResult {
  readonly pos: readonly Loop[]
  readonly neg: readonly Loop[]
}

/** A boolean of two simple closed loops (orientation of the inputs does not matter). */
export type LoopBoolean = (a: Loop, b: Loop, op: LoopBooleanOp) => AppResult<LoopBooleanResult>

type Piece = { outer: Loop; holes: Loop[] }

const boundsCache = new WeakMap<Loop, Bounds2>()
function bounds(l: Loop): Bounds2 {
  let b = boundsCache.get(l)
  if (b === undefined) {
    b = chainBounds(l.elements) ?? { min: [0, 0], max: [0, 0] }
    boundsCache.set(l, b)
  }
  return b
}

const areaCache = new WeakMap<Loop, number>()
function area(l: Loop): number {
  let a = areaCache.get(l)
  if (a === undefined) {
    a = signedArea(l)
    areaCache.set(l, a)
  }
  return a
}

const ccw = (l: Loop): Loop => (area(l) >= 0 ? l : reverseLoop(l))
const cw = (l: Loop): Loop => (area(l) <= 0 ? l : reverseLoop(l))
const overlap = (a: Loop, b: Loop): boolean => boundsOverlap(bounds(a), bounds(b))

/** Whether loop `inner` (not crossing `outer`) lies inside `outer`, tested at element midpoints. */
export function loopInside(inner: Loop, outer: Loop): boolean {
  if (!overlap(inner, outer)) return false
  for (const e of inner.elements) {
    const p = elementPointAt(e, 0.5).point
    if (!onLoop(outer, p, 1e-7)) return windingNumber(outer, p) !== 0
  }
  return true // coincident everywhere
}

/** The loop boolean with fast paths for disjoint boxes and identical loops. */
function bool(f: LoopBoolean, a: Loop, b: Loop, op: LoopBooleanOp): AppResult<LoopBooleanResult> {
  if (a === b) return Ok(op === 'not' ? { pos: [], neg: [] } : { pos: [ccw(a)], neg: [] })
  if (!overlap(a, b)) {
    if (op === 'or') return Ok({ pos: [ccw(a), ccw(b)], neg: [] })
    if (op === 'and') return Ok({ pos: [], neg: [] })
    return Ok({ pos: [ccw(a)], neg: [] })
  }
  return f(ccw(a), ccw(b), op)
}

/** `pos` is the single loop `l` again (the boolean changed nothing). */
function unchanged(pos: readonly Loop[], l: Loop): boolean {
  if (pos.length !== 1) return false
  const a = Math.abs(area(l))
  return Math.abs(Math.abs(area(pos[0]!)) - a) <= 1e-9 * Math.max(1, a)
}

/**
 * Pieces from simple loops `outers` minus `holes` (clockwise, pairwise not overlapping, as the
 * holes of one piece are).
 */
function subtractHoles(
  f: LoopBoolean,
  outers: readonly Loop[],
  holes: readonly Loop[],
): AppResult<Piece[]> {
  let work: Piece[] = outers.map((o) => ({ outer: o, holes: [] }))
  for (const h of holes) {
    const cutter = ccw(h)
    const next: Piece[] = []
    for (const piece of work) {
      if (!overlap(piece.outer, cutter)) {
        next.push(piece)
        continue
      }
      const r = bool(f, piece.outer, cutter, 'not')
      if (r.isErr()) return Err(r.unwrapErr())
      const { pos, neg } = r.unwrap()
      if (neg.length > 0) piece.holes.push(cw(h))
      else if (unchanged(pos, piece.outer)) {
        // outside the piece, or touching it from outside
        next.push(piece)
        continue
      } else {
        // the hole crossed the outer loop: the pieces of the cut keep the earlier holes inside them
        for (const o of pos)
          next.push({ outer: o, holes: piece.holes.filter((k) => loopInside(k, o)) })
        continue
      }
      next.push(piece)
    }
    work = next
  }
  return Ok(work)
}

/** `piece − c` for a counter-clockwise simple loop `c`. */
function pieceMinusLoop(f: LoopBoolean, piece: Piece, c: Loop): AppResult<Piece[]> {
  if (!overlap(piece.outer, c)) return Ok([piece])
  const r = bool(f, piece.outer, c, 'not')
  if (r.isErr()) return Err(r.unwrapErr())
  const { pos, neg } = r.unwrap()
  if (neg.length > 0) return mergeHole(f, piece, c)
  if (unchanged(pos, piece.outer)) return Ok([piece])
  return subtractHoles(f, pos, piece.holes)
}

/**
 * `c` lies inside the outer loop: it becomes a hole, united with the holes it overlaps. Areas the
 * united hole encloses become pieces (islands) with the holes inside them.
 */
function mergeHole(f: LoopBoolean, piece: Piece, c: Loop): AppResult<Piece[]> {
  let merged = c
  const islands: Loop[] = []
  let rest = [...piece.holes]
  for (let changed = true; changed;) {
    changed = false
    const keep: Loop[] = []
    for (const h of rest) {
      if (!overlap(merged, h) || islands.some((i) => loopInside(h, i))) {
        keep.push(h)
        continue
      }
      const u = bool(f, merged, h, 'or')
      if (u.isErr()) return Err(u.unwrapErr())
      const { pos, neg } = u.unwrap()
      if (pos.length !== 1) {
        keep.push(h)
        continue
      }
      merged = pos[0]!
      islands.push(...neg.map(ccw))
      changed = true
    }
    rest = keep
  }
  const out: Piece[] = [{ outer: piece.outer, holes: [] }]
  const islandHoles: Loop[][] = islands.map(() => [])
  for (const h of rest) {
    const i = islands.findIndex((isl) => loopInside(h, isl))
    if (i >= 0) islandHoles[i]!.push(h)
    else out[0]!.holes.push(h)
  }
  out[0]!.holes.push(cw(merged))
  for (let i = 0; i < islands.length; i++) {
    const sub = subtractHoles(f, [islands[i]!], islandHoles[i]!)
    if (sub.isErr()) return Err(sub.unwrapErr())
    out.push(...sub.unwrap())
  }
  return Ok(out)
}

/** `piece ∩ c` for a counter-clockwise simple loop `c`. */
function pieceAndLoop(f: LoopBoolean, piece: Piece, c: Loop): AppResult<Piece[]> {
  if (!overlap(piece.outer, c)) return Ok([])
  const r = bool(f, piece.outer, c, 'and')
  if (r.isErr()) return Err(r.unwrapErr())
  return subtractHoles(f, r.unwrap().pos, piece.holes)
}

function flatMapR<T, U>(xs: readonly T[], fn: (x: T) => AppResult<U[]>): AppResult<U[]> {
  const out: U[] = []
  for (const x of xs) {
    const r = fn(x)
    if (r.isErr()) return Err(r.unwrapErr())
    out.push(...r.unwrap())
  }
  return Ok(out)
}

const pieces = (r: Region): Piece[] =>
  r.pieces.map((p) => ({ outer: p.outer, holes: [...p.holes] }))
const region = (ps: readonly Piece[]): Region => ({
  pieces: ps.map((p): RegionPiece => ({ outer: p.outer, holes: p.holes })),
})

function differenceP(f: LoopBoolean, a: Piece[], b: readonly Piece[]): AppResult<Piece[]> {
  let out = a
  for (const s of b) {
    const before = out
    const minus = flatMapR(before, (p) => pieceMinusLoop(f, p, s.outer))
    if (minus.isErr()) return minus
    const inHoles = flatMapR(s.holes, (h) => flatMapR(before, (p) => pieceAndLoop(f, p, ccw(h))))
    if (inHoles.isErr()) return inHoles
    out = [...minus.unwrap(), ...inHoles.unwrap()]
  }
  return Ok(out)
}

function intersectP(f: LoopBoolean, a: readonly Piece[], b: readonly Piece[]): AppResult<Piece[]> {
  return flatMapR(b, (s) => {
    let part = flatMapR(a, (p) => pieceAndLoop(f, p, s.outer))
    for (const h of s.holes) {
      if (part.isErr()) return part
      const cutter = ccw(h)
      part = flatMapR(part.unwrap(), (p) => pieceMinusLoop(f, p, cutter))
    }
    return part
  })
}

/** Union of hole-free pieces by folding their outer loops; undefined if a gap (hole) appears. */
function unionOuters(f: LoopBoolean, all: readonly Loop[]): AppResult<Piece[] | undefined> {
  let done: Loop[] = []
  for (const l of all) {
    let merged = l
    for (let changed = true; changed;) {
      changed = false
      const keep: Loop[] = []
      for (const d of done) {
        if (!overlap(merged, d)) {
          keep.push(d)
          continue
        }
        const u = bool(f, merged, d, 'or')
        if (u.isErr()) return Err(u.unwrapErr())
        const { pos, neg } = u.unwrap()
        if (neg.length > 0) return Ok(undefined)
        if (pos.length === 1) {
          merged = pos[0]!
          changed = true
        } else keep.push(d)
      }
      done = keep
    }
    done.push(merged)
  }
  return Ok(done.map((o) => ({ outer: o, holes: [] })))
}

function box(a: readonly Piece[], b: readonly Piece[]): Piece {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of [...a, ...b]) {
    const bb = bounds(p.outer)
    x0 = Math.min(x0, bb.min[0])
    y0 = Math.min(y0, bb.min[1])
    x1 = Math.max(x1, bb.max[0])
    y1 = Math.max(y1, bb.max[1])
  }
  const m = 1 + 0.1 * Math.max(x1 - x0, y1 - y0)
  const c: Vec2[] = [
    [x0 - m, y0 - m],
    [x1 + m, y0 - m],
    [x1 + m, y1 + m],
    [x0 - m, y1 + m],
  ]
  return { outer: { elements: c.map((p, i) => line(p, c[(i + 1) % 4]!)) }, holes: [] }
}

function unionP(f: LoopBoolean, a: readonly Piece[], b: readonly Piece[]): AppResult<Piece[]> {
  if (a.length === 0) return Ok([...b])
  if (b.length === 0) return Ok([...a])
  if (!a.some((p) => b.some((q) => overlap(p.outer, q.outer)))) return Ok([...a, ...b])
  if (a.every((p) => p.holes.length === 0) && b.every((p) => p.holes.length === 0)) {
    const folded = unionOuters(
      f,
      [...a, ...b].map((p) => p.outer),
    )
    if (folded.isErr()) return folded.map(() => [])
    const v = folded.unwrap()
    if (v !== undefined) return Ok(v)
  }
  const bx = box(a, b)
  const ca = differenceP(f, [bx], a)
  if (ca.isErr()) return ca
  const cb = differenceP(f, [bx], b)
  if (cb.isErr()) return cb
  const x = intersectP(f, ca.unwrap(), cb.unwrap())
  if (x.isErr()) return x
  return differenceP(f, [bx], x.unwrap())
}

export const regionUnion = (f: LoopBoolean, a: Region, b: Region): AppResult<Region> =>
  unionP(f, pieces(a), pieces(b)).map(region)

export const regionDifference = (f: LoopBoolean, a: Region, b: Region): AppResult<Region> =>
  differenceP(f, pieces(a), pieces(b)).map(region)

export const regionIntersect = (f: LoopBoolean, a: Region, b: Region): AppResult<Region> =>
  intersectP(f, pieces(a), pieces(b)).map(region)

/**
 * A region from loops of any nesting: loops are applied from the largest |area| down, a
 * counter-clockwise loop united, a clockwise one subtracted (so a loop is applied after every loop
 * that contains it: outer, hole, island in the hole). Then self-touching loops are split into
 * lobes (`splitLobes`).
 */
export function normaliseLoops(f: LoopBoolean, loops: readonly Loop[]): AppResult<Region> {
  const sorted = [...loops].sort((x, y) => Math.abs(area(y)) - Math.abs(area(x)))
  let acc: Piece[] = []
  for (const l of sorted) {
    const a = area(l)
    if (a === 0) continue
    const r =
      a > 0
        ? unionP(f, acc, [{ outer: l, holes: [] }])
        : differenceP(f, acc, [{ outer: reverseLoop(l), holes: [] }])
    if (r.isErr()) return r.map(() => ({ pieces: [] }))
    acc = r.unwrap()
  }
  return Ok(splitLobes(region(acc)))
}

/**
 * Splits loops that touch themselves at a vertex into lobes when every lobe keeps the loop's
 * orientation (two squares meeting at a corner become two pieces). A pinch that would split off
 * a loop of the other orientation (a hole touching the outer loop from inside) stays one loop:
 * that form is what the library offsets correctly (ADR 0019, touching-island defect).
 */
export function splitLobes(r: Region): Region {
  const out: RegionPiece[] = []
  for (const p of r.pieces) {
    const outers = lobes(p.outer)
    const holes = p.holes.flatMap(lobes)
    if (outers.length === 1) out.push({ outer: outers[0]!, holes })
    else
      for (const o of outers) out.push({ outer: o, holes: holes.filter((h) => loopInside(h, o)) })
  }
  return { pieces: out }
}

/** Smaller pieces of a self-touching loop (mm²) are not lobes: the smallest element squared. */
const MIN_LOBE_AREA = MIN_ELEMENT_LENGTH * MIN_ELEMENT_LENGTH

function lobes(l: Loop): Loop[] {
  const n = l.elements.length
  const sign = Math.sign(area(l))
  const key = (p: Vec2) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`
  const seen = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const k = key(l.elements[i]!.a)
    const j = seen.get(k)
    if (j !== undefined) {
      const first: Loop = { elements: l.elements.slice(j, i) }
      const second: Loop = { elements: [...l.elements.slice(i), ...l.elements.slice(0, j)] }
      const lobe = (x: Loop) =>
        x.elements.length >= 2 && Math.sign(area(x)) === sign && Math.abs(area(x)) > MIN_LOBE_AREA
      if (lobe(first) && lobe(second)) return [...lobes(first), ...lobes(second)]
    }
    seen.set(k, i)
  }
  return [l]
}

/** Point key of the self-touch tests (1 nm grid, as `lobes`). */
const touchKey = (p: Vec2) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`

/**
 * Whether elements (a closed chain) enclose no width: mean width 2·|area| / perimeter below
 * `OFFSET_EPSILON`, as a spike traced out and back or a lens of a tiny arc and its chord.
 */
export function isSliver(elements: readonly Loop['elements'][number][]): boolean {
  let perimeter = 0
  for (const e of elements) perimeter += elementLength(e)
  return 2 * Math.abs(signedArea({ elements })) < OFFSET_EPSILON * perimeter
}

/**
 * Cuts the zero-width spikes out of a loop: where the loop passes a vertex again, the stretch
 * between the two visits is dropped when it is a sliver (`isSliver`). CavalierContours (0.9.0)
 * leaves such spikes in an offset where an element much shorter than the offset sits between
 * near-tangent neighbours (a 1 µm closing line between two arcs): the raw offset of the short
 * element runs backwards, and the crate keeps it because it lies at the offset distance within
 * its epsilons. Offsets of a spiky loop compound into open loops and holes outside their outer
 * loop. Doc: docs/architecture/shapes.md#implementation-k1
 */
export function dropSpikes(l: Loop): Loop {
  let els = l.elements
  for (;;) {
    let cut: Loop['elements'] | undefined
    const seen = new Map<string, number>()
    for (let i = 0; i < els.length && cut === undefined; i++) {
      const k = touchKey(els[i]!.a)
      const j = seen.get(k)
      if (j !== undefined) {
        const inner = els.slice(j, i)
        const rest = [...els.slice(0, j), ...els.slice(i)]
        if (isSliver(inner)) cut = rest
        else if (isSliver(rest)) cut = inner
      }
      seen.set(k, i)
    }
    if (cut === undefined) return els === l.elements ? l : { elements: els }
    els = cut
  }
}
