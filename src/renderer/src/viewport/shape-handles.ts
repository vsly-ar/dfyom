// Shape Editor handle maths (task U1), pure and in the shape frame (mm, y up): the handles of one
// item (points, sizes and radii, centres), the item a drag of one of them gives (Shift: 15° steps),
// what the value chip and the handle's name read, and where an issue marks the outline red.
// Every handle edits quantities that are also inspector fields (ui.md § Shapes: numbers first).
// Doc: docs/conventions/ui.md#shape-editor, docs/modes/design-v0.3.md#shape-definition
import { itemChain } from '../../../core/design/shape-items'
import type { ShapeItem } from '../../../core/design/shape.dto'
import { line, type Element } from '../../../core/geometry/2d/model'
import type { Vec2 } from '../../../core/geometry/model'

type Item = ShapeItem<number>
type PathItem = Extract<Item, { kind: 'path' }>
type ParamPath = readonly (string | number)[]

export type HandleKind = 'point' | 'size' | 'centre'

/** What a handle edits, for its chip and name. */
export type HandleRole =
  | { readonly kind: 'centre' }
  | { readonly kind: 'start' }
  | { readonly kind: 'end'; readonly segment: number }
  | { readonly kind: 'radius'; readonly segment: number }
  | { readonly kind: 'size'; readonly field: 'length' | 'width' | 'diameter' | 'cornerRadius' }

export interface ShapeHandle {
  /** Stable within the item: `center`, `start`, `seg.2.to`, `seg.2.radius`, `length`, … */
  readonly id: string
  readonly kind: HandleKind
  readonly role: HandleRole
  readonly at: Vec2
  /** The quantities it edits (a formula among them locks the handle). */
  readonly paths: readonly ParamPath[]
}

const DEG = Math.PI / 180
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]]
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k]
const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1]
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1])
const axes = (deg: number): { ux: Vec2; uy: Vec2 } => {
  const c = Math.cos(deg * DEG)
  const s = Math.sin(deg * DEG)
  return { ux: [c, s], uy: [-s, c] }
}
/** Sizes never drag below this (an invalid size is shown red by the resolver, not reached here). */
const MIN_SIZE = 1e-3

/** Arc geometry of a path segment from `a`: centre, bulge direction, sagitta and midpoint. */
export function arcGeometry(
  a: Vec2,
  b: Vec2,
  radius: number,
  cw: boolean,
  large: boolean,
): { centre: Vec2; mid: Vec2; bulge: Vec2; chordMid: Vec2; chord: number } | undefined {
  const chord = dist(a, b)
  if (chord < 1e-9) return undefined
  const m: Vec2 = mul(add(a, b), 0.5)
  const n: Vec2 = [-(b[1] - a[1]) / chord, (b[0] - a[0]) / chord] // left normal of a → b
  const h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) ** 2))
  const bulge: Vec2 = cw ? n : mul(n, -1) // a counter-clockwise arc bulges to the right
  const s = large ? radius + h : radius - h
  return {
    centre: add(m, mul(bulge, s - radius)),
    mid: add(m, mul(bulge, s)),
    bulge,
    chordMid: m,
    chord,
  }
}

/** The end of segment `k` (−1: the start). */
const vertex = (p: PathItem, k: number): Vec2 => (k < 0 ? p.start : p.segments[k]!.to)

function polygonHandle(item: Extract<Item, { kind: 'polygon' }>): Vec2 {
  const n = Math.max(3, Math.round(item.sides))
  const rot = item.rotation ?? 0
  // flat side at the bottom at rotation 0: flats at −90° + k·360/n, corners half a step on
  const first = -90 + (item.across === 'flats' ? 0 : 180 / n) + rot
  const step = 360 / n
  // the corner (or flat) nearest the +x direction, so the handle sits on the right
  const k = Math.round((0 - first) / step)
  const a = (first + k * step) * DEG
  const r = item.diameter / 2
  return [item.center[0] + r * Math.cos(a), item.center[1] + r * Math.sin(a)]
}

/** The handles of an item (shown on the selected item only). */
export function itemHandles(item: Item): ShapeHandle[] {
  const centre = (at: Vec2): ShapeHandle => ({
    id: 'center',
    kind: 'centre',
    role: { kind: 'centre' },
    at,
    paths: [
      ['center', 0],
      ['center', 1],
    ],
  })
  const size = (
    field: 'length' | 'width' | 'diameter' | 'cornerRadius',
    at: Vec2,
  ): ShapeHandle => ({
    id: field,
    kind: 'size',
    role: { kind: 'size', field },
    at,
    paths: [[field]],
  })
  switch (item.kind) {
    case 'rectangle': {
      const { ux, uy } = axes(item.rotation ?? 0)
      const c = item.center
      const r = item.cornerRadius
      const corner = add(add(c, mul(ux, item.length / 2 - r)), mul(uy, item.width / 2 - r))
      const diag = mul(add(ux, uy), Math.SQRT1_2)
      return [
        centre(c),
        size('length', add(c, mul(ux, item.length / 2))),
        size('width', add(c, mul(uy, item.width / 2))),
        size('cornerRadius', add(corner, mul(diag, r))),
      ]
    }
    case 'circle':
      return [centre(item.center), size('diameter', add(item.center, [item.diameter / 2, 0]))]
    case 'obround': {
      const { ux, uy } = axes(item.rotation ?? 0)
      return [
        centre(item.center),
        size('length', add(item.center, mul(ux, item.length / 2))),
        size('width', add(item.center, mul(uy, item.width / 2))),
      ]
    }
    case 'polygon':
      return [centre(item.center), size('diameter', polygonHandle(item))]
    case 'offset':
      // no handles: the item follows its source shape (design-llm-first.md § Offset item)
      return []
    case 'path': {
      const out: ShapeHandle[] = [
        {
          id: 'start',
          kind: 'point',
          role: { kind: 'start' },
          at: item.start,
          paths: [
            ['start', 0],
            ['start', 1],
          ],
        },
      ]
      item.segments.forEach((s, k) => {
        out.push({
          id: `seg.${k}.to`,
          kind: 'point',
          role: { kind: 'end', segment: k },
          at: s.to,
          paths: [
            ['segments', k, 'to', 0],
            ['segments', k, 'to', 1],
          ],
        })
        if (s.kind !== 'arc') return
        const g = arcGeometry(vertex(item, k - 1), s.to, s.radius, s.cw, Boolean(s.large))
        if (g !== undefined)
          out.push({
            id: `seg.${k}.radius`,
            kind: 'size',
            role: { kind: 'radius', segment: k },
            at: g.mid,
            paths: [['segments', k, 'radius']],
          })
      })
      return out
    }
  }
}

/**
 * Above this many segments a path shows only the handles of its selected segment (L3-7, D33): an
 * imported outline with a handle on every point is crowded. ui.md § Shape Editor.
 */
export const MANY_SEGMENTS = 20

/** Whether `item` is a path with more than `MANY_SEGMENTS` segments. */
export const hasManySegments = (item: Item | undefined): boolean =>
  item?.kind === 'path' && item.segments.length > MANY_SEGMENTS

/**
 * The handles shown for `item`: all of them, except on a path with many segments, where only the
 * selected segment's (its start and end points and an arc's radius) show, and none without one.
 */
export function shownHandles(
  item: Item,
  handles: readonly ShapeHandle[],
  segment: number | null,
): readonly ShapeHandle[] {
  if (!hasManySegments(item)) return handles
  if (segment === null) return []
  const ids = new Set([
    segment === 0 ? 'start' : `seg.${segment - 1}.to`,
    `seg.${segment}.to`,
    `seg.${segment}.radius`,
  ])
  return handles.filter((h) => ids.has(h.id))
}

/**
 * The elements of each segment of a path, without fillets or the closing line (click targets and
 * the selected segment's highlight). A segment that does not resolve is its chord.
 */
export function segmentElements(item: PathItem): Element[][] {
  const chain = itemChain({ ...item, fillets: [], closed: false }, 0, [])
  const out: Element[][] = []
  let at = 0
  const elements = chain?.loop.elements ?? []
  item.segments.forEach((s, k) => {
    const mine: Element[] = []
    // pushArc may split one arc into several elements: take them until this segment's end
    while (at < elements.length) {
      const e = elements[at++]!
      mine.push(e)
      if (dist(e.b, s.to) < 1e-6) break
    }
    out.push(mine.length > 0 ? mine : [line(vertex(item, k - 1), s.to)])
  })
  return out
}

/** `p` constrained to 15° steps around `origin` (Shift), keeping its distance. */
export function constrain15(origin: Vec2, p: Vec2): Vec2 {
  const d = sub(p, origin)
  const r = Math.hypot(d[0], d[1])
  if (r < 1e-12) return p
  const a = Math.round(Math.atan2(d[1], d[0]) / (15 * DEG)) * 15 * DEG
  return [origin[0] + r * Math.cos(a), origin[1] + r * Math.sin(a)]
}

export interface DragOptions {
  /** Shift: points move in 15° steps (from the previous vertex, or from where the drag began). */
  readonly shift?: boolean
  /** Where the handle was when the drag began (the origin of a constrained centre move). */
  readonly from?: Vec2
}

/**
 * The item with handle `id` dragged to `p` (shape frame). Sizes follow the pointer's projection on
 * their axis (symmetric about the centre); an arc's radius follows its sagitta, flipping to the
 * large arc past a half circle. Unknown ids leave the item unchanged.
 */
export function dragHandle(item: Item, id: string, p: Vec2, opts: DragOptions = {}): Item {
  const shift = opts.shift ?? false
  if (item.kind === 'offset') return item
  if (id === 'center' && item.kind !== 'path') {
    const to = shift && opts.from ? constrain15(opts.from, p) : p
    return { ...item, center: [to[0], to[1]] }
  }
  switch (item.kind) {
    case 'rectangle':
    case 'obround': {
      const { ux, uy } = axes(item.rotation ?? 0)
      const d = sub(p, item.center)
      if (id === 'length') return { ...item, length: Math.max(MIN_SIZE, 2 * dot(d, ux)) }
      if (id === 'width') return { ...item, width: Math.max(MIN_SIZE, 2 * dot(d, uy)) }
      if (id === 'cornerRadius' && item.kind === 'rectangle') {
        const k = add(add(item.center, mul(ux, item.length / 2)), mul(uy, item.width / 2))
        const diag = mul(add(ux, uy), Math.SQRT1_2)
        const along = dot(sub(k, p), diag) // distance of the arc's midpoint from the sharp corner
        const max = Math.min(item.length, item.width) / 2
        return { ...item, cornerRadius: Math.min(max, Math.max(0, along / (Math.SQRT2 - 1))) }
      }
      return item
    }
    case 'circle':
    case 'polygon':
      return id === 'diameter'
        ? { ...item, diameter: Math.max(MIN_SIZE, 2 * dist(p, item.center)) }
        : item
    case 'path': {
      if (id === 'start') {
        const to = shift && item.segments[0] ? constrain15(item.segments[0].to, p) : p
        return { ...item, start: [to[0], to[1]] }
      }
      const m = /^seg\.(\d+)\.(to|radius)$/.exec(id)
      const k = m ? Number(m[1]) : -1
      const seg = item.segments[k]
      if (!m || seg === undefined) return item
      const segments = [...item.segments]
      if (m[2] === 'to') {
        const to = shift ? constrain15(vertex(item, k - 1), p) : p
        segments[k] = { ...seg, to: [to[0], to[1]] }
        return { ...item, segments }
      }
      if (seg.kind !== 'arc') return item
      const g = arcGeometry(vertex(item, k - 1), seg.to, seg.radius, seg.cw, Boolean(seg.large))
      if (g === undefined) return item
      const s = Math.max(g.chord * 1e-3, dot(sub(p, g.chordMid), g.bulge))
      const half = g.chord / 2
      const radius = (s * s + half * half) / (2 * s)
      segments[k] = { ...seg, radius, large: s > half }
      return { ...item, segments }
    }
  }
}

/** What the value chip and the handle's name read: a point's coordinates or one size in mm. */
export type HandleReadout =
  | { readonly kind: 'point'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'length'
      readonly field: 'length' | 'width' | 'diameter' | 'cornerRadius' | 'radius'
      readonly mm: number
    }

export function handleReadout(item: Item, handle: ShapeHandle): HandleReadout {
  const role = handle.role
  if (role.kind === 'size') {
    const v = (item as Record<string, unknown>)[role.field]
    return { kind: 'length', field: role.field, mm: typeof v === 'number' ? v : 0 }
  }
  if (role.kind === 'radius' && item.kind === 'path') {
    const s = item.segments[role.segment]
    return { kind: 'length', field: 'radius', mm: s?.kind === 'arc' ? s.radius : 0 }
  }
  return { kind: 'point', x: handle.at[0], y: handle.at[1] }
}

/**
 * Where an issue of item `n` marks the outline: one segment of a path (its `segments.<k>` or its
 * fillet's vertex), the closing line (`closed`), or the whole item.
 */
export type BadMark =
  | { readonly kind: 'segment'; readonly segment: number }
  | { readonly kind: 'closing' }
  | { readonly kind: 'item' }

export function badMark(path: ParamPath, item: Item | undefined): BadMark {
  if (item?.kind === 'path') {
    if (path[0] === 'segments' && typeof path[1] === 'number')
      return { kind: 'segment', segment: path[1] }
    if (path[0] === 'closed') return { kind: 'closing' }
    if (path[0] === 'fillets' && typeof path[1] === 'number') {
      const v = item.fillets?.[path[1]]?.vertex
      if (v !== undefined && v > 0 && v <= item.segments.length)
        return { kind: 'segment', segment: v - 1 }
    }
  }
  return { kind: 'item' }
}

/** The two ends of a path segment (a closing line: last end → start). */
export function segmentEnds(item: PathItem, mark: BadMark): readonly [Vec2, Vec2] | undefined {
  if (mark.kind === 'closing')
    return item.segments.length > 0 ? [item.segments.at(-1)!.to, item.start] : undefined
  if (mark.kind !== 'segment' || item.segments[mark.segment] === undefined) return undefined
  return [vertex(item, mark.segment - 1), item.segments[mark.segment]!.to]
}

/** A keyboard nudge (arrows): 1 mm, 0.1 mm with Alt, 10 mm with Shift (ui.md § Accessibility). */
export function nudgeStep(e: { altKey: boolean; shiftKey: boolean }): number {
  return e.altKey ? 0.1 : e.shiftKey ? 10 : 1
}
