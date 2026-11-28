/**
 * Clones mirror (hardening DF126, slice M1): a mirror row's line (the stock face's centre, an
 * operation's or feature's centre, a coordinate), its reference rules (`clonesMirrorRef`), whether
 * the source maps onto itself under a flip (the on-line drop), and an instance's flips applied
 * to one source operation (positions, rotations, anchors, a named shape's `mirror`, tabs).
 * Doc: docs/modes/clones-mirror.md
 */
import type { Issue } from '../../../shared/errors/app-error'
import { None, type AppResult } from '../../../shared/result'
import { arc, line, type Bounds2, type Loop } from '../../geometry/2d/model'
import { chainLength, chainPointAt, closestOnChains } from '../../geometry/2d/measure'
import type { Region2dPort } from '../../geometry/2d/port'
import type { Vec2 } from '../../geometry/model'
import { shapeOutline } from '../../geometry/outline'
import type { Stock } from '../../library/stock'
import { Quantity } from '../../quantity/quantity'
import { Rational } from '../../quantity/rational'
import { shapeCentre } from '../anchor'
import {
  chamferDiameter,
  isGeneralShape,
  shapeRotation,
  shapesOf,
  type Anchor,
  type Operation,
  type Part,
  type Profile,
  type Shape,
} from '../operation'
import { isInlinePath } from '../operation'
import { inlineBounds } from '../line-inline'
import { placeShape } from '../placement'
import type { ShapeDTO } from '../shape.dto'
import type { Flip, UV } from './path'
import { SAME_SPOT } from './path'

/** A mirror row as stored (clones.ts `CloneRow` of kind `mirror`). */
export interface MirrorCloneRow {
  readonly kind: 'mirror'
  readonly flip: 'u' | 'v'
  readonly about?: string
  readonly at?: Quantity
}

/** What a mirror line and an instance's tabs are read from. */
export interface MirrorEnv {
  readonly stock: Stock
  /** The operations a reference may name: those before the Clones' instances. */
  readonly ops: readonly Operation[]
  readonly shapes: readonly ShapeDTO[]
  /** The 2D layer: named and rotated shapes' centres, tab positions; absent: approximations. */
  readonly port?: Region2dPort | undefined
}

const ownerOf = (op: Operation): string | undefined =>
  op.owner.isSome() ? op.owner.unwrap().featureId : undefined
const surfaceOwner = (on: string): string =>
  on.slice(0, on.indexOf('.') < 0 ? on.length : on.indexOf('.'))

/** The stock face a face target lies on (`on` followed through earlier operations). */
export function stockFaceOf(on: string, ops: readonly Operation[]): string {
  let at = on
  for (let guard = 0; guard < 64 && !at.startsWith('stock.'); guard++)
    at = ops.find((o) => o.id === surfaceOwner(at))?.on ?? 'stock.top'
  return at
}

/** Size of the stock face under face target `on`, `[u, v]` mm (design-v0.2.md § Face frame). */
export function faceSizeOf(stock: Stock, on: string, ops: readonly Operation[]): [number, number] {
  const L = stock.length.canonical
  const W = stock.width.canonical
  const T = stock.thickness.canonical
  const face = stockFaceOf(on, ops)
  if (face === 'stock.top' || face === 'stock.bottom') return [L, W]
  return face === 'stock.side[0]' || face === 'stock.side[2]' ? [L, T] : [W, T]
}

/** The operations a reference names: the operation, or a feature's (a Clones' source with it). */
function referenced(id: string, ops: readonly Operation[]): Operation[] {
  const own = ops.filter((o) => o.id === id || ownerOf(o) === id)
  // a Clones' instances are `<n>_<source id>`: its source operations come with it
  const roles = new Set(
    own.flatMap((o) => (o.owner.isSome() ? [o.owner.unwrap().role.replace(/^\d+_/, '')] : [])),
  )
  return /^clones[1-9]\d*$/.test(id)
    ? [...ops.filter((o) => roles.has(o.id) && ownerOf(o) !== id), ...own]
    : own
}

/**
 * The mirror rows' reference rules as `model.invariant` issues at `rows.<i>.about`
 * (`clonesMirrorRef`): `about` names an operation or feature of the part that is not this Clones
 * nor one of its instances, cuts an area (not a facing) and lies on the Clones' face; before or
 * after the Clones in design order (`ExpansionContext.after`). `at` and `about` together are
 * `oneOf`.
 */
export function mirrorRefIssues(
  rows: readonly { readonly kind: string }[],
  clones: { readonly id: string; readonly name: string },
  face: string,
  ops: readonly Operation[],
): Issue[] {
  const issues: Issue[] = []
  rows.forEach((r, i) => {
    if (r.kind !== 'mirror') return
    const m = r as MirrorCloneRow
    const at = (field: string, rule: string, message: string) =>
      issues.push({ path: ['rows', i, field], rule, message, params: { about: m.about ?? '' } })
    if (m.about !== undefined && m.at !== undefined) at('at', 'oneOf', 'give about or at, not both')
    if (m.about === undefined) return
    const row = `${clones.name}'s mirror row (row ${i + 1})`
    if (m.about === clones.id)
      return at('about', 'clonesMirrorRef', `${row} cannot mirror about itself`)
    const target = referenced(m.about, ops)
    if (target.length === 0)
      return at('about', 'clonesMirrorRef', `${m.about} is not in the part: change ${row} first`)
    if (target.some((o) => ownerOf(o) === clones.id))
      return at('about', 'clonesMirrorRef', `${m.about} is one of its own clones`)
    if (target.every((o) => o.kind === 'facing'))
      return at('about', 'clonesMirrorRef', `${m.about} is a facing: it has no centre`)
    if (target.some((o) => stockFaceOf(o.on, ops) !== stockFaceOf(face, ops)))
      return at('about', 'clonesMirrorRef', `${m.about} is not on this face`)
  })
  return issues
}

/** The bounds `b` grown by `g` on every side. */
const grow = (b: Bounds2, g: number): Bounds2 => ({
  min: [b.min[0] - g, b.min[1] - g],
  max: [b.max[0] + g, b.max[1] + g],
})
const box = (c: readonly [number, number], hu: number, hv: number): Bounds2 => ({
  min: [c[0] - hu, c[1] - hv],
  max: [c[0] + hu, c[1] + hv],
})

/** A shape's placed bounding box (general shapes through the 2D layer; without it the anchor point). */
function shapeBounds(s: Shape, shapes: Part['shapes'], port: Region2dPort | undefined): Bounds2 {
  if (s.kind === 'circle')
    return box(shapeCentre(s), s.diameter.canonical / 2, s.diameter.canonical / 2)
  if (!isGeneralShape(s) && s.kind === 'rectangle')
    return box(shapeCentre(s), s.length.canonical / 2, s.width.canonical / 2)
  const placed = port === undefined ? undefined : placeShape(port, s, shapes)
  if (placed?.isOk()) {
    const { centre, size } = placed.unwrap()
    return box(centre, size[0] / 2, size[1] / 2)
  }
  return box([s.center[0].canonical, s.center[1].canonical], 0, 0)
}

/**
 * An operation's footprint bounds (features.md § Checks and DFM; a Line's groove width left out,
 * it grows every path alike): a drilling's circle, a pocket's or inside profile's shape, an `on`
 * profile's grown by half the slot width, an outside one's by the slot width, a chamfer's edge
 * grown by its width; none for a facing.
 */
function footprintBoundsOf(
  op: Operation,
  ops: readonly Operation[],
  shapes: Part['shapes'],
  port: Region2dPort | undefined,
): Bounds2 | undefined {
  switch (op.kind) {
    case 'facing':
      return undefined
    case 'drilling':
      return box([op.center[0].canonical, op.center[1].canonical], ...half(op.diameter.canonical))
    case 'pocket':
      return shapeBounds(op.shape, shapes, port)
    case 'profile': {
      const g =
        op.side === 'inside'
          ? 0
          : op.side === 'outside'
            ? op.slotWidth.canonical
            : op.slotWidth.canonical / 2
      return grow(shapeBounds(op.shape, shapes, port), g)
    }
    case 'chamfer': {
      const edge = ops.find((o) => o.id === op.edgeOf)
      const d = chamferDiameter(op, edge)?.toNumber()
      if (edge?.kind === 'drilling' && d !== undefined)
        return box([edge.center[0].canonical, edge.center[1].canonical], ...half(d))
      const b = edge === undefined ? undefined : footprintBoundsOf(edge, ops, shapes, port)
      return b === undefined ? undefined : grow(b, op.width.canonical)
    }
    case 'line':
      return union(
        op.paths.map((p) => (isInlinePath(p) ? inlineBounds(p) : shapeBounds(p, shapes, port))),
      )
  }
}

const half = (d: number): [number, number] => [d / 2, d / 2]

function union(list: readonly (Bounds2 | undefined)[]): Bounds2 | undefined {
  const bs = list.filter((b): b is Bounds2 => b !== undefined)
  if (bs.length === 0) return undefined
  return {
    min: [Math.min(...bs.map((b) => b.min[0])), Math.min(...bs.map((b) => b.min[1]))],
    max: [Math.max(...bs.map((b) => b.max[0])), Math.max(...bs.map((b) => b.max[1]))],
  }
}

/** The named shapes `ops` place (empty when they do not load: the bounds fall back). */
function shapeMap(ops: readonly Operation[], shapes: readonly ShapeDTO[]): Part['shapes'] {
  const m = shapesOf(ops, { shapes: [...shapes] })
  return m.isOk() ? m.unwrap() : new Map()
}

/**
 * Each row's mirror line coordinate (mm, absolute in the face frame; undefined for other rows):
 * `at`, the centre of `about`'s footprint bounding box, or half the stock face along the axis.
 * An `about` that names nothing in `env.ops` falls back to the stock centre (`mirrorRefIssues`
 * refuses it before).
 */
export function mirrorLines(
  rows: readonly { readonly kind: string }[],
  face: string,
  env: MirrorEnv,
): (number | undefined)[] {
  let shapes: Part['shapes'] | undefined
  return rows.map((r) => {
    if (r.kind !== 'mirror') return undefined
    const m = r as MirrorCloneRow
    const k = m.flip === 'u' ? 0 : 1
    if (m.at !== undefined) return m.at.canonical
    if (m.about !== undefined) {
      const target = referenced(m.about, env.ops)
      shapes ??= shapeMap(env.ops, env.shapes)
      const b = union(target.map((o) => footprintBoundsOf(o, env.ops, shapes, env.port)))
      if (b !== undefined) return (b.min[k] + b.max[k]) / 2
    }
    return faceSizeOf(env.stock, face, env.ops)[k] / 2
  })
}

// ── symmetry: a mirror image on its original ────────────────────────────────────────────────

/** A rectangle's or circle's geometric centre when it is axis-aligned up to a quarter turn. */
function squareCentre(s: Shape): readonly [number, number] | undefined {
  if (s.kind === 'circle') return shapeCentre(s)
  if (s.kind !== 'rectangle') return undefined
  const rot = (((shapeRotation(s) % 360) + 360) % 360) / 90
  if (!Number.isInteger(rot)) return undefined
  // a quarter turn swaps the placed box's sides
  const [su, sv] =
    rot % 2 === 0
      ? [s.length.canonical, s.width.canonical]
      : [s.width.canonical, s.length.canonical]
  const off = (p: Anchor['u'], size: number) =>
    p === 'min' ? -size / 2 : p === 'max' ? size / 2 : 0
  return [s.center[0].canonical - off(s.anchor.u, su), s.center[1].canonical - off(s.anchor.v, sv)]
}

/**
 * Whether the source maps onto itself under a flip in u (v) about the line through `ref`: every
 * operation is a drilling, circle, or rectangle at a multiple of 90°, centred on that line (a
 * chamfer as its edge). Named shapes and Lines never are (clones-mirror.md § Instances on the
 * mirror line).
 */
export function sourceSymmetry(src: readonly Operation[], ref: UV): { u: boolean; v: boolean } {
  const centre = (op: Operation): readonly [number, number] | undefined => {
    switch (op.kind) {
      case 'drilling':
        return [op.center[0].canonical, op.center[1].canonical]
      case 'pocket':
      case 'profile':
        return squareCentre(op.shape)
      case 'chamfer': {
        if (op.loops.isSome()) return undefined
        const edge = src.find((o) => o.id === op.edgeOf)
        return edge === undefined ? undefined : centre(edge)
      }
      default:
        return undefined
    }
  }
  const cs = src.map(centre)
  const on = (k: 0 | 1, r: number) =>
    cs.every((c) => c !== undefined && Math.abs(c[k] - r) < SAME_SPOT)
  return { u: on(0, ref.u), v: on(1, ref.v) }
}

// ── an instance's flips on one operation ───────────────────────────────────────────────────

const R180 = Rational.create(180n).unwrap()
const TWO = Rational.create(2n).unwrap()

/** Is the instance mirrored in u or v (not both: a half turn)? */
const mirrors = (f: Flip): boolean => (f.u === true) !== (f.v === true)

/**
 * The new value of a source rotation `theta` (degrees, exact) on an instance with flips `f`: a
 * rectangle −θ when mirrored once (symmetric under a half turn); a named placement −θ for u,
 * 180° − θ for v, θ + 180° for both (the placement flips the shape frame's x before rotating).
 */
export function flippedRotation(kind: Shape['kind'], theta: Rational, f: Flip): Rational {
  if (kind === 'rectangle') return mirrors(f) ? theta.neg() : theta
  if (f.u === true && f.v === true) return theta.add(R180)
  if (f.u === true) return theta.neg()
  if (f.v === true) return R180.sub(theta)
  return theta
}

/** The amount a position coordinate `q` moves on an instance: `s·q + t − q` (s = −1 when flipped). */
export function positionDelta(q: Rational, flipped: boolean, t: Rational): Rational {
  return flipped ? t.sub(q.mul(TWO)) : t
}

const swap = (p: Anchor['u']): Anchor['u'] => (p === 'min' ? 'max' : p === 'max' ? 'min' : p)

/** A shape's anchor and `mirror` flag on an instance with flips `f` (its rotation and centre are quantities). */
export function flipShapeFlags<S extends Shape>(s: S, f: Flip): S {
  if (f.u !== true && f.v !== true) return s
  const anchor = {
    u: f.u === true ? swap(s.anchor.u) : s.anchor.u,
    v: f.v === true ? swap(s.anchor.v) : s.anchor.v,
  }
  const named = s.kind === 'named' ? { mirror: mirrors(f) ? !s.mirror : s.mirror } : {}
  return { ...s, anchor, ...named }
}

/** 180° as a typed angle (a named placement without rotation mirrored in v). */
export function halfTurn(): AppResult<Quantity> {
  return Quantity.create({
    kind: 'angle',
    source: '180',
    defaultUnit: 'deg',
    exact: R180,
    tolerance: None,
  })
}

// ── tabs ───────────────────────────────────────────────────────────────────────────────────

/** A shape's first loop about the centre of its placed box, as geometry and toolpaths take it. */
function localLoop(s: Shape, shapes: Part['shapes'], port: Region2dPort): Loop | undefined {
  if (!isGeneralShape(s)) {
    const contour =
      s.kind === 'circle'
        ? { kind: 'circle' as const, radius: s.diameter.canonical / 2 }
        : s.kind === 'rectangle'
          ? {
              kind: 'rectangle' as const,
              length: s.length.canonical,
              width: s.width.canonical,
              cornerRadius: s.cornerRadius.canonical,
            }
          : undefined
    if (contour === undefined) return undefined
    const o = shapeOutline({ center: [0, 0], contour })
    return o.kind === 'region' ? o.region.pieces[0]?.outer : undefined
  }
  const placed = placeShape(port, s, shapes)
  if (placed.isErr()) return undefined
  const o = placed.unwrap().outline
  return o.kind === 'region' ? o.region.pieces[0]?.outer : undefined
}

/** Arc length along `l` from its start to the point closest to `p`. */
function arcLengthAt(l: Loop, p: Vec2): number | undefined {
  const c = closestOnChains([l], p)
  if (c === undefined) return undefined
  let s = 0
  for (let k = 0; k < c.element; k++) s += chainLength({ elements: [l.elements[k]!] })
  const e = l.elements[c.element]!
  if (Math.hypot(c.point[0] - e.a[0], c.point[1] - e.a[1]) < 1e-9) return s
  const part = e.kind === 'line' ? line(e.a, c.point) : arc(e.a, c.point, e.centre, e.ccw)
  return s + chainLength({ elements: [part] })
}

/**
 * A profile's tab positions on its instance with flips `f`: each on the mirror image of its source
 * tab (the mirrored loop is numbered from its own start point and keeps its winding, so the
 * distances change). Undefined when nothing changes or the shapes cannot be resolved (no 2D
 * layer): the positions are copied.
 */
export function flippedTabs(
  src: Profile,
  moved: Profile,
  f: Flip,
  env: { readonly shapes: Part['shapes']; readonly port: Region2dPort | undefined },
): number[] | undefined {
  const positions = src.tabs.positions
  if (positions.isNone() || (f.u !== true && f.v !== true) || env.port === undefined)
    return undefined
  const from = localLoop(src.shape, env.shapes, env.port)
  const to = localLoop(moved.shape, env.shapes, env.port)
  if (from === undefined || to === undefined) return undefined
  const su = f.u === true ? -1 : 1
  const sv = f.v === true ? -1 : 1
  const out: number[] = []
  for (const q of positions.unwrap()) {
    const p = chainPointAt(from, q.canonical, true)
    if (p.isErr()) return undefined
    const [x, y] = p.unwrap().point
    const s = arcLengthAt(to, [su * x, sv * y])
    if (s === undefined) return undefined
    out.push(s)
  }
  return out
}

/** The named shapes for `flippedTabs` (loaded once per expansion). */
export function tabShapes(ops: readonly Operation[], shapes: readonly ShapeDTO[]): Part['shapes'] {
  return shapeMap(ops, shapes)
}
