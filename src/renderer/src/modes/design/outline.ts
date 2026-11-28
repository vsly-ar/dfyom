// What the design scene draws without the worker, in the operation's face frame: the live outline
// of an operation while its evaluation is pending (ui.md decision 15: "drawn live as an outline
// from the field values, cheap, no worker"), the point of the error marker of a failing
// operation, the face-frame axes of the selected operation's face (task F1) and its anchor point
// (task F2). Pure, from the analytic model (part frame, mm); named and rotated shapes (v0.3) are
// placed through the renderer's 2D port when it is given (task U1), else they draw no outline.
// Doc: docs/conventions/ui.md#evaluation-status-pending-outdated-failed,
// #design-and-plan-controls-v02; docs/modes/design-v0.2.md#face-frame;
// docs/modes/design-v0.3.md#placing-a-shape-on-a-face
import { shapeCentre } from '../../../../core/design/anchor'
import {
  CENTRE_ANCHOR,
  isGeneralShape,
  isInlinePath,
  type InlineLinePath,
  type Operation,
  type Part,
  type Shape,
} from '../../../../core/design/operation'
import { chamferEdge } from '../../../../core/design/geometry-input'
import { placeShape } from '../../../../core/design/placement'
import { inlineBounds, inlineElement } from '../../../../core/design/line-inline'
import { resolveEngraving } from '../../../../core/design/engraving/resolve'
import type { EngravingRecord } from '../../../../core/design/shape.dto'
import type { Element, Loop, Region } from '../../../../core/geometry/2d/model'
import { chamferDepth } from '../../../../core/geometry/model'
import type { Region2dPort } from '../../../../core/geometry/2d/port'
import type { SurfaceTable } from '../../../../core/design/surfaces'
import {
  DIRECTION,
  faceFrame,
  STOCK_FACE,
  toPartFrame,
  type Direction,
  type FaceFrame,
  type StockSize,
} from '../../../../core/geometry/face'
import type { Stock } from '../../../../core/library/stock'
import type { OutlineLoop, Vec3 } from '../../viewport'

/** Segments per quarter circle (corner arcs) and per full circle. */
const ARC_SEGMENTS = 8
const CIRCLE_SEGMENTS = 48

/** Chord angle of the arcs of general shapes (rad): 64 segments per full circle. */
const ARC_STEP = Math.PI / 32

/** The 2D layer the general shapes are placed with: the renderer's port and the part's shapes. */
export interface ShapeContext {
  readonly port: Region2dPort
  readonly shapes: Part['shapes']
}

/** The points of an element chain (each element's start, then the arcs sampled), without its end. */
function chainPoints(elements: readonly Element[], at: (u: number, v: number) => Vec3): Vec3[] {
  const out: Vec3[] = []
  for (const e of elements) {
    out.push(at(e.a[0], e.a[1]))
    if (e.kind !== 'arc') continue
    const [cx, cy] = e.centre
    const r = Math.hypot(e.a[0] - cx, e.a[1] - cy)
    const a0 = Math.atan2(e.a[1] - cy, e.a[0] - cx)
    let sweep = Math.atan2(e.b[1] - cy, e.b[0] - cx) - a0
    const full = e.a[0] === e.b[0] && e.a[1] === e.b[1]
    if (full) sweep = e.ccw ? 2 * Math.PI : -2 * Math.PI
    else if (e.ccw && sweep <= 0) sweep += 2 * Math.PI
    else if (!e.ccw && sweep >= 0) sweep -= 2 * Math.PI
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP))
    for (let i = 1; i < n; i++) {
      const t = a0 + (sweep * i) / n
      out.push(at(cx + r * Math.cos(t), cy + r * Math.sin(t)))
    }
  }
  return out
}

/**
 * The loops of a named or rotated shape placed on its face (`placeShape`), at height `w`: every
 * loop of a region closed, an open path marked `open`. None when the shape does not resolve.
 */
function generalLoops(shape: Shape, w: number, ctx: ShapeContext): OutlineLoop[] {
  const placed = placeShape(ctx.port, shape, ctx.shapes)
  if (placed.isErr()) return []
  const { outline, centre } = placed.unwrap()
  const at = (u: number, v: number): Vec3 => [centre[0] + u, centre[1] + v, w]
  if (outline.kind === 'path') {
    const els = outline.path.elements
    const pts = chainPoints(els, at)
    const last = els.at(-1)
    if (last !== undefined) pts.push(at(last.b[0], last.b[1]))
    return [Object.assign(pts, { open: true as const })]
  }
  const loops: Loop[] = outline.region.pieces.flatMap((p) => [p.outer, ...p.holes])
  return loops.map((l) => chainPoints(l.elements, at))
}

/**
 * An engraved pattern's lines (engraved-patterns.md E3) at height `w`, moved by `at` (the owned
 * Line's path centre: [0, 0], a Clones copy's offset): closed lines as loops, open ones marked.
 */
function engravingLoops(
  rec: EngravingRecord,
  at: readonly [number, number],
  w: number,
  ctx: ShapeContext,
): OutlineLoop[] {
  const r = resolveEngraving(rec, ctx.shapes, ctx.port)
  if (r.isErr()) return []
  const pt = (u: number, v: number): Vec3 => [at[0] + u, at[1] + v, w]
  return r.unwrap().lines.flatMap((l): OutlineLoop[] => {
    const c = l.shape.contour
    if (c.kind === 'path') {
      const els = c.path.elements
      const pts = chainPoints(els, pt)
      const last = els.at(-1)
      if (last !== undefined) pts.push(pt(last.b[0], last.b[1]))
      return [Object.assign(pts, { open: true as const })]
    }
    if (c.kind !== 'region') return []
    return c.region.pieces
      .flatMap((p) => [p.outer, ...p.holes])
      .map((loop) => chainPoints(loop.elements, pt))
  })
}

/**
 * The loops of a shape at face-frame height `w` as `[u, v, w]` (in the part frame for the top
 * face): one closed loop for a v0.1 rectangle or circle; for a named or rotated shape the placed
 * loops through `ctx` (none without it).
 */
/** An inline Straight / Arc (DF147 SL2) as one open loop at height `w`. */
function inlineLoops(p: InlineLinePath, w: number): OutlineLoop[] {
  const el = inlineElement(p)
  if (el === undefined) return []
  const pt = (u: number, v: number): Vec3 => [u, v, w]
  const pts = chainPoints([el], pt)
  pts.push(pt(el.b[0], el.b[1]))
  return [Object.assign(pts, { open: true as const })]
}

/** An inline path's bounding-box centre (mm), its gizmo's place. */
function inlineCentre(p: InlineLinePath): [number, number] {
  const b = inlineBounds(p)
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
}

export function shapeLoops(shape: Shape, w: number, ctx?: ShapeContext): OutlineLoop[] {
  if (shape.kind === 'named' || isGeneralShape(shape))
    return ctx === undefined ? [] : generalLoops(shape, w, ctx)
  return [shapeLoop(shape, w)]
}

/**
 * Closed loop of a v0.1 rectangle or circle at face-frame height `w` (the last point does not
 * repeat the first), as `[u, v, w]`; in the part frame for the top face. Named and rotated shapes
 * have none here (`shapeLoops` places them).
 */
export function shapeLoop(shape: Shape, w: number): Vec3[] {
  if (shape.kind === 'named' || isGeneralShape(shape)) return []
  const [cx, cy] = shapeCentre(shape) // `center` is the anchor point
  if (shape.kind === 'circle') return circleLoop(cx, cy, shape.diameter.canonical / 2, w)
  const hx = shape.length.canonical / 2
  const hy = shape.width.canonical / 2
  const r = Math.max(0, Math.min(shape.cornerRadius.canonical, hx, hy))
  if (r === 0) return rectangleLoop(cx - hx, cy - hy, cx + hx, cy + hy, w)
  // corners counter-clockwise from the front right, each arc a quarter turn
  const corners: [number, number, number][] = [
    [cx + hx - r, cy - hy + r, -Math.PI / 2],
    [cx + hx - r, cy + hy - r, 0],
    [cx - hx + r, cy + hy - r, Math.PI / 2],
    [cx - hx + r, cy - hy + r, Math.PI],
  ]
  return corners.flatMap(([x, y, start]) =>
    Array.from({ length: ARC_SEGMENTS + 1 }, (_, i): Vec3 => {
      const a = start + (i / ARC_SEGMENTS) * (Math.PI / 2)
      return [x + r * Math.cos(a), y + r * Math.sin(a), w]
    }),
  )
}

function circleLoop(cx: number, cy: number, r: number, w: number): Vec3[] {
  return Array.from({ length: CIRCLE_SEGMENTS }, (_, i): Vec3 => {
    const a = (i / CIRCLE_SEGMENTS) * 2 * Math.PI
    return [cx + r * Math.cos(a), cy + r * Math.sin(a), w]
  })
}

function rectangleLoop(x0: number, y0: number, x1: number, y1: number, w: number): Vec3[] {
  return [
    [x0, y0, w],
    [x1, y0, w],
    [x1, y1, w],
    [x0, y1, w],
  ]
}

const stockSize = (stock: Stock): StockSize => ({
  length: stock.length.canonical,
  width: stock.width.canonical,
  thickness: stock.thickness.canonical,
})

/** The face an operation starts from. */
export interface OperationFace {
  readonly direction: Direction
  /** The frame at the stock face of the direction (`w` = 0 there, negative below it). */
  readonly frame: FaceFrame
  /** `w` of the `on` face: 0 on the stock face, −depth on a floor below it. */
  readonly w: number
  /** Stock size seen in the face frame (`length` along `u`, `width` along `v`, `thickness` along `n`). */
  readonly local: StockSize
}

/** The `on` face of an operation; the stock top when the surface is unknown. */
export function operationFace(op: Operation, stock: Stock, table: SurfaceTable): OperationFace {
  return surfaceFace(op.on, stock, table)
}

/** The face of a surface id (a face target, or a selected face, DF22); the stock top when unknown. */
export function surfaceFace(on: string, stock: Stock, table: SurfaceTable): OperationFace {
  const entry = table.get(on).or(table.get(STOCK_FACE['+z']))
  const direction = entry.mapOr<Direction>('+z', (e) => e.direction)
  const size = stockSize(stock)
  const d = DIRECTION[direction]
  return {
    direction,
    frame: faceFrame(direction, size),
    w: entry.mapOr(0, (e) => e.faceZ.toNumber()),
    local: { length: size[d.uSize], width: size[d.vSize], thickness: size[d.extent] },
  }
}

/** Distance (mm) within which a point of a region's boundary is on a stock edge. */
const ON_EDGE = 1e-6

/** A closed loop (face frame) clipped to the face rectangle `[0, L] × [0, W]` (Sutherland–Hodgman). */
function clipToFace(loop: readonly Vec3[], L: number, W: number): Vec3[] {
  const planes: [(p: Vec3) => number, (a: Vec3, b: Vec3) => Vec3][] = (
    [
      [0, 0, 1],
      [0, L, -1],
      [1, 0, 1],
      [1, W, -1],
    ] as const
  ).map(([axis, at, sign]) => {
    const d = (p: Vec3) => sign * (p[axis] - at)
    const cut = (a: Vec3, b: Vec3): Vec3 => {
      const t = d(a) / (d(a) - d(b))
      const p: [number, number, number] = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2]]
      p[axis] = at
      return p
    }
    return [d, cut]
  })
  let out: Vec3[] = [...loop]
  for (const [d, cut] of planes) {
    const input = out
    out = []
    for (let i = 0; i < input.length; i++) {
      const a = input[i]!
      const b = input[(i + 1) % input.length]!
      if (d(a) >= 0) out.push(a)
      if (d(a) >= 0 !== d(b) >= 0) out.push(cut(a, b))
    }
  }
  return out
}

/**
 * DF145: a facing region's boundary on its face at height `w` (face frame), clipped to the face:
 * the `inner` sides, where the tool's edge stays on the boundary, and the `open` sides on the
 * stock edges, where the rows run off the stock (drawn dashed, design.md § Facing region). A
 * named shape draws only with the 2D port (`ctx`).
 */
export function facingRegionSides(
  op: Extract<Operation, { kind: 'facing' }>,
  face: OperationFace,
  w: number,
  ctx?: ShapeContext,
): { inner: OutlineLoop[]; open: OutlineLoop[] } {
  const { length: L, width: W } = face.local
  const region = op.region
  if (region === undefined) return { inner: [], open: [rectangleLoop(0, 0, L, W, w)] }
  let loops: (readonly Vec3[])[]
  if (region.kind === 'band') {
    const b = region.width.canonical
    const box = {
      front: [0, 0, L, b],
      back: [0, W - b, L, W],
      left: [0, 0, b, W],
      right: [L - b, 0, L, W],
    }[region.edge]
    loops = [rectangleLoop(box[0]!, box[1]!, box[2]!, box[3]!, w)]
  } else loops = shapeLoops(region.shape, w, ctx).filter((l) => l.open !== true)
  const onEdge = (a: Vec3, b: Vec3) =>
    [
      [0, 0],
      [0, L],
      [1, 0],
      [1, W],
    ].some(
      ([axis, at]) => Math.abs(a[axis!]! - at!) < ON_EDGE && Math.abs(b[axis!]! - at!) < ON_EDGE,
    )
  const inner: OutlineLoop[] = []
  const open: OutlineLoop[] = []
  for (const raw of loops) {
    const pts = clipToFace(raw, L, W)
    const n = pts.length
    if (n < 3) continue
    const kinds = pts.map((p, i) => onEdge(p, pts[(i + 1) % n]!))
    // start at a change of kind, so a run never wraps round the loop's first point
    const start = kinds.findIndex((k, i) => k !== kinds[(i + n - 1) % n])
    if (start < 0) {
      ;(kinds[0] ? open : inner).push(pts)
      continue
    }
    let run: Vec3[] = [pts[start]!]
    for (let j = 0; j < n; j++) {
      const i = (start + j) % n
      run.push(pts[(i + 1) % n]!)
      if (j === n - 1 || kinds[(i + 1) % n] !== kinds[i]) {
        ;(kinds[i] ? open : inner).push(Object.assign(run, { open: true as const }))
        run = [pts[(i + 1) % n]!]
      }
    }
  }
  return { inner, open }
}

/**
 * A pattern's area (the boundary less the margin, face frame) as closed loops on its face in the
 * part frame: the dashed guide while the pattern is selected (patterns P2).
 */
export function patternAreaLoops(
  op: Operation,
  stock: Stock,
  table: SurfaceTable,
  area: Region,
): OutlineLoop[] {
  const face = operationFace(op, stock, table)
  const at = (u: number, v: number): Vec3 => toPartFrame(face.frame, [u, v, face.w])
  return area.pieces.flatMap((p) => [p.outer, ...p.holes]).map((l) => chainPoints(l.elements, at))
}

/** The thin-web marker's radius (mm): a small ring round the narrowest web (patterns P5). */
export const PATTERN_WEB_MARKER = 1.5

/**
 * Everything a selected pattern draws dashed on its face (patterns P2, P5): the area, the ghosts
 * (cells left out at the border, whole) and a ring round the thinnest web (`dfm.patternThinWeb`'s
 * marker), all in the part frame.
 */
export function patternGuideLoops(
  op: Operation,
  stock: Stock,
  table: SurfaceTable,
  facts: {
    readonly area: Region
    readonly ghosts?: Region | undefined
    readonly web?: { readonly at: readonly [number, number] } | undefined
  },
): OutlineLoop[] {
  const face = operationFace(op, stock, table)
  const at = (u: number, v: number): Vec3 => toPartFrame(face.frame, [u, v, face.w])
  const ghosts = (facts.ghosts?.pieces ?? []).map((p) => chainPoints(p.outer.elements, at))
  const web = facts.web?.at
  const ring =
    web === undefined
      ? []
      : [
          Array.from({ length: 24 }, (_, i) => {
            const t = (i / 24) * 2 * Math.PI
            return at(
              web[0] + PATTERN_WEB_MARKER * Math.cos(t),
              web[1] + PATTERN_WEB_MARKER * Math.sin(t),
            )
          }),
        ]
  return [...patternAreaLoops(op, stock, table, facts.area), ...ghosts, ...ring]
}

/** The thin-wall marker's radius (mm): a ring at each `dfm.lineMerge` place (engraved patterns). */
export const LINE_MERGE_MARKER = 1.5

/**
 * Rings at the places a selected Line's grooves leave a thin wall (`dfm.lineMerge`'s `points`,
 * face frame, engraved-patterns.md § DFM), dashed on its face in the part frame.
 */
export function lineMergeLoops(
  op: Operation,
  stock: Stock,
  table: SurfaceTable,
  points: readonly number[],
): OutlineLoop[] {
  const face = operationFace(op, stock, table)
  const out: OutlineLoop[] = []
  for (let k = 0; k + 1 < points.length; k += 2) {
    const u = points[k]!
    const v = points[k + 1]!
    out.push(
      Array.from({ length: 24 }, (_, i) => {
        const t = (i / 24) * 2 * Math.PI
        return toPartFrame(face.frame, [
          u + LINE_MERGE_MARKER * Math.cos(t),
          v + LINE_MERGE_MARKER * Math.sin(t),
          face.w,
        ])
      }),
    )
  }
  return out
}

const place = (face: OperationFace, loops: OutlineLoop[]): OutlineLoop[] =>
  loops.map((l) => {
    const out = l.map((p) => toPartFrame(face.frame, p))
    return l.open ? Object.assign(out, { open: true as const }) : out
  })

/**
 * DF145: a selected region facing's open sides (on the stock edges, where the rows run off), in
 * the part frame at its face: the dashed guide beside its solid inner sides.
 */
export function facingRegionGuide(
  op: Operation,
  stock: Stock,
  table: SurfaceTable,
  ctx?: ShapeContext,
): OutlineLoop[] {
  if (op.kind !== 'facing' || op.region === undefined) return []
  const face = operationFace(op, stock, table)
  return place(face, facingRegionSides(op, face, face.w, ctx).open)
}

/**
 * The operation's shape where it starts and where it ends, in the part frame: the top loop at its
 * `on` face and the bottom loop at its floor (facing: the new face; profile: the stock face and
 * the opposite one; chamfer: its diameter at the face and the edge's where the cone meets it,
 * read from the part's operations `ops`).
 */
export function operationOutline(
  op: Operation,
  stock: Stock,
  table: SurfaceTable,
  ctx?: ShapeContext,
  ops: readonly Operation[] = [],
): OutlineLoop[] {
  const face = operationFace(op, stock, table)
  const through = -face.local.thickness
  switch (op.kind) {
    case 'facing': {
      const floor = face.w - op.depth.canonical
      if (op.region === undefined)
        return place(face, [rectangleLoop(0, 0, face.local.length, face.local.width, floor)])
      // DF145: the region's inner sides at the face and at the new floor (the open sides are the
      // dashed guide, `facingRegionSides`)
      return place(face, [
        ...facingRegionSides(op, face, face.w, ctx).inner,
        ...facingRegionSides(op, face, floor, ctx).inner,
      ])
    }
    case 'pocket':
      return place(face, [
        ...shapeLoops(op.shape, face.w, ctx),
        ...shapeLoops(op.shape, face.w - op.depth.canonical, ctx),
      ])
    case 'drilling': {
      const circle: Shape = {
        kind: 'circle',
        center: op.center,
        anchor: CENTRE_ANCHOR,
        diameter: op.diameter,
      }
      const bottom =
        op.bottom === 'through' || op.depth.isNone()
          ? through
          : face.w - op.depth.unwrap().canonical
      return place(face, [shapeLoop(circle, face.w), shapeLoop(circle, bottom)])
    }
    case 'profile':
      return place(face, [
        ...shapeLoops(op.shape, face.w, ctx),
        ...shapeLoops(op.shape, through, ctx),
      ])
    case 'line':
      // a Line (engraved-patterns.md E1): its paths at the face (the groove is the solid)
      return place(
        face,
        op.paths.flatMap((p) => {
          // DF147 SL2: an inline Straight / Arc is one open line
          if (isInlinePath(p)) return inlineLoops(p, face.w)
          // an engraved pattern's owned shape (E3): its resolved lines, moved by the path centre
          const rec = ctx?.shapes?.get(p.shapeId)?.engraving
          return rec === undefined
            ? shapeLoops(p, face.w, ctx)
            : engravingLoops(rec, [p.center[0].canonical, p.center[1].canonical], face.w, ctx!)
        }),
      )
    case 'chamfer': {
      const edge = chamferEdge(ops, op.edgeOf)
      if (edge === undefined) {
        // a general edge (edge-chamfers.md E1): the edge's loops at the face
        const loop = ops.find((o) => o.id === op.edgeOf)
        return loop?.kind === 'pocket' || loop?.kind === 'profile'
          ? place(face, shapeLoops(loop.shape, face.w, ctx))
          : []
      }
      const [cu, cv] = edge.center
      // D45: the chamfer stores its width; its diameter at the face follows the edge
      const d = edge.diameter + 2 * op.width.canonical
      const depth = chamferDepth({
        edgeDiameter: edge.diameter,
        diameter: d,
        angle: op.angle.canonical,
      })
      return place(face, [
        circleLoop(cu, cv, d / 2, face.w),
        circleLoop(cu, cv, edge.diameter / 2, face.w - depth),
      ])
    }
  }
}

/** Where the error marker of a failing operation points: its shape's centre at its `on` face. */
export function markerPoint(
  op: Operation,
  stock: Stock,
  table: SurfaceTable,
  ops: readonly Operation[] = [],
): Vec3 {
  const face = operationFace(op, stock, table)
  const at = (u: number, v: number, w = face.w) => toPartFrame(face.frame, [u, v, w])
  switch (op.kind) {
    case 'facing':
      return at(face.local.length / 2, face.local.width / 2, face.w - op.depth.canonical)
    case 'pocket':
    case 'profile':
      return at(...shapeCentre(op.shape))
    case 'line':
      return op.paths[0] === undefined
        ? at(0, 0)
        : isInlinePath(op.paths[0])
          ? at(...inlineCentre(op.paths[0]))
          : at(...shapeCentre(op.paths[0]))
    case 'drilling':
      return at(op.center[0].canonical, op.center[1].canonical)
    case 'chamfer': {
      const edge = chamferEdge(ops, op.edgeOf)
      if (edge !== undefined) return at(...edge.center)
      const loop = ops.find((o) => o.id === op.edgeOf)
      return loop?.kind === 'pocket' || loop?.kind === 'profile'
        ? at(...shapeCentre(loop.shape))
        : at(0, 0)
    }
  }
}

/** Face-frame axes of the selected operation's face: origin, `u` and `v` (unit), the normal. */
export interface FrameAxes {
  readonly origin: Vec3
  readonly u: Vec3
  readonly v: Vec3
  readonly n: Vec3
  /** Length of the drawn axes (mm): 0.6 of the shorter side of the face rectangle. */
  readonly length: number
}

/** The face frame of the operation's `on` face, at that face's level (design-v0.2.md#face-frame). */
export function frameAxes(op: Operation, stock: Stock, table: SurfaceTable): FrameAxes {
  return surfaceAxes(op.on, stock, table)
}

/** The face frame of a surface at its level (a selected face's axes, DF22). */
export function surfaceAxes(on: string, stock: Stock, table: SurfaceTable): FrameAxes {
  const face = surfaceFace(on, stock, table)
  const { u, v, n } = face.frame
  return {
    origin: toPartFrame(face.frame, [0, 0, face.w]),
    u,
    v,
    n,
    length: Math.max(1, Math.min(face.local.length, face.local.width) * 0.6),
  }
}

/**
 * The point the position fields give, on the `on` face (task F2): a pocket's or profile's
 * anchor point, a drilling's centre. Facings have none.
 */
export function anchorPoint(
  op: Operation,
  stock: Stock,
  table: SurfaceTable,
): { at: Vec3; u: Vec3; v: Vec3 } | null {
  // a chamfer sits on its edge's axis: no anchor of its own
  if (op.kind === 'facing' || op.kind === 'chamfer') return null
  const face = operationFace(op, stock, table)
  const first = op.kind === 'line' ? op.paths[0] : undefined
  if (op.kind === 'line' && first === undefined) return null
  const c =
    op.kind === 'drilling'
      ? op.center
      : op.kind === 'line'
        ? isInlinePath(first!)
          ? first.start
          : first!.center
        : op.shape.center
  return {
    at: toPartFrame(face.frame, [c[0].canonical, c[1].canonical, face.w]),
    u: face.frame.u,
    v: face.frame.v,
  }
}
