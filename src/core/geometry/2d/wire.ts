/**
 * The port's wire format: CavalierContours polylines as flat `[x, y, bulge, …]` vertex lists
 * (bulge = tan(sweep / 4), positive counter-clockwise). Converts the analytic elements both ways,
 * checks the input and merges elements shorter than `MIN_ELEMENT_LENGTH`.
 * Doc: docs/architecture/shapes.md#2d-port
 */
import type { Issue } from '../../../shared/errors/app-error'
import { AppError } from '../../../shared/errors/app-error'
import { Err, Ok, type AppResult } from '../../../shared/result'
import type { Vec2 } from '../model'
import {
  arc,
  arcRadius,
  arcSweep,
  isFullCircle,
  line,
  MIN_ELEMENT_LENGTH,
  POSITION_EPSILON,
  type Element,
  type Loop,
} from './model'

export interface WireLoop {
  readonly closed: boolean
  /** x, y, bulge per vertex; an open polyline's last vertex is its end point (bulge 0). */
  readonly v: ArrayLike<number>
}

/** Rules of `geometry.evaluation` errors raised by the 2D port. */
export type Region2dRule =
  | 'notFinite'
  | 'empty'
  | 'notChained'
  | 'arcInvalid'
  | 'degenerate'
  | 'resultInvalid'
  | 'offsetInvalid'
  | 'outOfRange'
  | 'kernel'

export function region2dError(
  rule: Region2dRule,
  message: string,
  where: string,
  params?: Readonly<Record<string, unknown>>,
): AppError {
  const issue: Issue = { path: [], rule, message, ...(params === undefined ? {} : { params }) }
  return new AppError('geometry.evaluation', message, { issues: [issue], where })
}

const finite = (p: Vec2): boolean => Number.isFinite(p[0]) && Number.isFinite(p[1])
const dist = (a: Vec2, b: Vec2): number => Math.hypot(b[0] - a[0], b[1] - a[1])

/** Checks a chain of elements: finite, chained end to start, arcs with one radius. */
export function checkChain(
  elements: readonly Element[],
  closed: boolean,
  where: string,
): AppResult<void> {
  if (elements.length === 0)
    return Err(region2dError('empty', 'a loop or path has no elements', where))
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i]!
    if (!finite(e.a) || !finite(e.b) || (e.kind === 'arc' && !finite(e.centre)))
      return Err(
        region2dError('notFinite', 'an element has a non-finite coordinate', where, { element: i }),
      )
    if (e.kind === 'arc') {
      const ra = arcRadius(e)
      const rb = dist(e.centre, e.b)
      if (ra <= POSITION_EPSILON || Math.abs(ra - rb) > POSITION_EPSILON * Math.max(1, ra))
        return Err(
          region2dError(
            'arcInvalid',
            'an arc does not lie on one circle around its centre',
            where,
            {
              element: i,
              ra,
              rb,
            },
          ),
        )
    }
    const next = i + 1 < elements.length ? elements[i + 1] : closed ? elements[0] : undefined
    if (next !== undefined && dist(e.b, next.a) > POSITION_EPSILON)
      return Err(
        region2dError('notChained', 'an element does not end where the next one starts', where, {
          element: i,
          gap: dist(e.b, next.a),
        }),
      )
  }
  return Ok(undefined)
}

/** Bulge of an element (0 for a line). */
function bulge(e: Element): number {
  return e.kind === 'line' ? 0 : Math.tan(arcSweep(e) / 4)
}

/**
 * Elements to wire vertices: full circles become two half arcs, elements shorter than
 * `MIN_ELEMENT_LENGTH` are merged into their neighbours. Fails on invalid input or when nothing
 * is left.
 */
export function toWire(
  elements: readonly Element[],
  closed: boolean,
  where: string,
): AppResult<WireLoop> {
  const checked = checkChain(elements, closed, where)
  if (checked.isErr()) return Err(checked.unwrapErr())
  const verts: [number, number, number][] = []
  for (const e of elements) {
    if (e.kind === 'arc' && isFullCircle(e)) {
      const b = e.ccw ? 1 : -1
      verts.push([e.a[0], e.a[1], b])
      verts.push([2 * e.centre[0] - e.a[0], 2 * e.centre[1] - e.a[1], b])
    } else verts.push([e.a[0], e.a[1], bulge(e)])
  }
  if (!closed) {
    const last = elements[elements.length - 1]!
    verts.push([last.b[0], last.b[1], 0])
  }
  const merged = mergeShort(verts, closed)
  if (merged.length < 2 || (closed && merged.length < 3 && merged.every((v) => v[2] === 0)))
    return Err(
      region2dError('degenerate', 'a loop or path is shorter than the smallest element', where),
    )
  return Ok({ closed, v: merged.flat() })
}

/**
 * Drops vertices that start an element shorter than `MIN_ELEMENT_LENGTH`: the vertex before keeps
 * its position and takes the dropped vertex's bulge (the next element then starts up to that far
 * from where it did). An open polyline keeps its end point.
 */
function mergeShort(
  verts: [number, number, number][],
  closed: boolean,
): [number, number, number][] {
  const out: [number, number, number][] = []
  for (const v of verts) {
    const prev = out[out.length - 1]
    if (prev !== undefined && Math.hypot(v[0] - prev[0], v[1] - prev[1]) < MIN_ELEMENT_LENGTH) {
      prev[2] = v[2]
      continue
    }
    out.push([v[0], v[1], v[2]])
  }
  if (!closed && out.length >= 2) {
    // the end point must stay: if it was merged away, move the last kept vertex onto it
    const end = verts[verts.length - 1]!
    const last = out[out.length - 1]!
    if (last[0] !== end[0] || last[1] !== end[1]) {
      last[0] = end[0]
      last[1] = end[1]
      last[2] = 0
    }
  } else if (!closed && out.length === 1) out.push(verts[verts.length - 1]!)
  while (closed && out.length > 1) {
    const first = out[0]!
    const last = out[out.length - 1]!
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) >= MIN_ELEMENT_LENGTH) break
    out.pop()
  }
  return out
}

/** Wire vertices to elements; zero-length segments are skipped. */
export function fromWire(w: WireLoop, where: string): AppResult<Loop> {
  const n = w.v.length / 3
  const elements: Element[] = []
  const count = w.closed ? n : n - 1
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % n
    const a: Vec2 = [w.v[3 * i]!, w.v[3 * i + 1]!]
    const b: Vec2 = [w.v[3 * j]!, w.v[3 * j + 1]!]
    const bu = w.v[3 * i + 2]!
    if (!finite(a) || !finite(b) || !Number.isFinite(bu))
      return Err(
        region2dError('resultInvalid', 'the 2D library returned a non-finite vertex', where),
      )
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const chord = Math.hypot(dx, dy)
    if (chord < 1e-12) continue
    if (Math.abs(bu) < 1e-12) {
      elements.push(line(a, b))
      continue
    }
    const k = (1 - bu * bu) / (4 * bu)
    const centre: Vec2 = [(a[0] + b[0]) / 2 - dy * k, (a[1] + b[1]) / 2 + dx * k]
    elements.push(arc(a, b, centre, bu > 0))
  }
  if (elements.length === 0)
    return Err(region2dError('resultInvalid', 'the 2D library returned an empty loop', where))
  return Ok({ elements })
}
