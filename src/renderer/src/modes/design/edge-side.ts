// The side arrow of a selected one-sided chamfer (DF147 SL4 follow-up), pure: the groove's wall
// chamfer as the geometry input builds it (centre path, half width, kept side, face frame), an
// arrow at the path's middle from each wall out into its side, and a pick strip along each side
// of the groove (clicking a side picks it). Part frame, mm.
// Doc: docs/conventions/ui.md#chamfer-inspector, docs/modes/engraved-patterns.md#implementation-sl3sl4
import { toGeometryInput } from '../../../../core/design/geometry-input'
import { toPartFrame } from '../../../../core/geometry/face'
import { chainLength, chainPointAt } from '../../../../core/geometry/2d/measure'
import type { Element } from '../../../../core/geometry/2d/model'
import type { Region2dPort } from '../../../../core/geometry/2d/port'
import type { Vec2 } from '../../../../core/geometry/model'
import type { EdgeSide } from '../../../../core/geometry/wall-chamfer'
import type { Vec3 } from '../../viewport'
import type { DesignPart } from './model'
import { operationFace } from './outline'

/** An arrow: its shaft and the two ends of its head (part frame). */
export interface SideArrow {
  readonly from: Vec3
  readonly to: Vec3
  readonly head: readonly [Vec3, Vec3]
}

export interface EdgeSideGeometry {
  /** The side that stays now. */
  readonly kept: EdgeSide
  /** The groove's centre path, sampled (part frame). */
  readonly path: readonly Vec3[]
  readonly closed: boolean
  readonly arrows: Readonly<Record<EdgeSide, SideArrow>>
  /** Per side, quads along the groove from its wall out (part frame, each counter-clockwise). */
  readonly strips: Readonly<Record<EdgeSide, readonly (readonly [Vec3, Vec3, Vec3, Vec3])[]>>
}

/** The arrow is this long past the wall, at least (mm); else the groove's width. */
export const ARROW_MM = 4
/** Each pick strip reaches this far past the wall, at least (mm); else twice the groove's width. */
export const STRIP_MM = 6
/** The path is sampled about this often (mm), arcs chorded. */
const SAMPLE_MM = 0.5

const cache = new WeakMap<DesignPart, Map<string, EdgeSideGeometry | null>>()

/** The side arrow's geometry of chamfer `chamferId`; undefined when it is no wall chamfer. */
export function edgeSideGeometry(
  part: DesignPart,
  chamferId: string,
  port: Region2dPort | undefined,
): EdgeSideGeometry | undefined {
  const loaded = part.loaded
  if (loaded === undefined || part.table === undefined) return undefined
  let byOp = cache.get(part)
  if (byOp === undefined) cache.set(part, (byOp = new Map()))
  const key = `${chamferId}:${port === undefined ? 0 : 1}`
  const hit = byOp.get(key)
  if (hit !== undefined) return hit ?? undefined
  const input = toGeometryInput(loaded.part, loaded.stock, port)
  const g = input.isOk() ? input.unwrap().operations.find((o) => o.id === chamferId) : undefined
  const op = loaded.part.operations.find((o) => o.id === chamferId)
  let out: EdgeSideGeometry | undefined
  if (g?.kind === 'chamfer' && 'wall' in g && g.wall !== undefined && op !== undefined) {
    const face = operationFace(op, loaded.stock, part.table)
    out = sideGeometry(g.wall, (p) => toPartFrame(face.frame, [p[0], p[1], face.w]))
  }
  byOp.set(key, out ?? null)
  return out
}

/** The arrows and strips of a wall (face frame) mapped by `at` into the part frame. */
export function sideGeometry(
  wall: {
    readonly elements: readonly Element[]
    readonly closed?: true
    readonly halfWidth: number
    readonly side: EdgeSide
  },
  at: (p: Vec2) => Vec3,
): EdgeSideGeometry | undefined {
  const chain = { elements: wall.elements }
  const closed = wall.closed === true
  const length = chainLength(chain)
  if (!(length > 0)) return undefined
  const n = Math.max(2, Math.ceil(length / SAMPLE_MM))
  const pts: { p: Vec2; t: Vec2 }[] = []
  for (let k = 0; k <= n; k++) {
    const r = chainPointAt(chain, (length * k) / n, closed)
    if (r.isErr()) return undefined
    pts.push({ p: r.unwrap().point, t: r.unwrap().tangent })
  }
  const g = wall.halfWidth
  const reach = Math.max(STRIP_MM, 4 * g)
  const off = (q: { p: Vec2; t: Vec2 }, s: number): Vec2 => [
    q.p[0] - q.t[1] * s,
    q.p[1] + q.t[0] * s,
  ]
  const strip = (sign: 1 | -1) =>
    pts.slice(1).map((b, i) => {
      const a = pts[i]!
      const quad = [
        off(a, sign * g),
        off(b, sign * g),
        off(b, sign * (g + reach)),
        off(a, sign * (g + reach)),
      ]
      // counter-clockwise on the face (the right side runs backwards)
      return (sign > 0 ? quad : [...quad].reverse()).map(at) as unknown as readonly [
        Vec3,
        Vec3,
        Vec3,
        Vec3,
      ]
    })
  const mid = pts[Math.floor(n / 2)]!
  const long = Math.max(ARROW_MM, 2 * g)
  const arrow = (sign: 1 | -1): SideArrow => {
    const tip = off(mid, sign * (g + long))
    const back = off(mid, sign * (g + long * 0.6))
    const w = long * 0.25
    return {
      from: at(off(mid, sign * g)),
      to: at(tip),
      head: [
        at([back[0] + mid.t[0] * w, back[1] + mid.t[1] * w]),
        at([back[0] - mid.t[0] * w, back[1] - mid.t[1] * w]),
      ],
    }
  }
  return {
    kept: wall.side,
    path: pts.map((q) => at(q.p)),
    closed,
    arrows: { left: arrow(1), right: arrow(-1) },
    strips: { left: strip(1), right: strip(-1) },
  }
}
