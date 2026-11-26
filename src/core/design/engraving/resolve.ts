/**
 * An engraved pattern's owned shape resolved (engraved-patterns.md § Engraved pattern, E3): the
 * motif's lines (a preset's, or the part's named shapes' loops and open paths with their levels)
 * placed once in the face frame — at `center` and `size`, or with `fit: 'boundary'` scaled to fit
 * the boundary less the margin and centred — each as the Line geometry takes a path (a closed loop
 * or one open path, centre [0, 0]) with its levels. Read by the Line's geometry input (owned
 * `<id>_line`), the viewport, the read-out and the findings; cached by the record and the shapes
 * it reads.
 * Doc: docs/modes/engraved-patterns.md#engraved-pattern-feature,
 * docs/modes/engraved-patterns.md#implementation-e3
 */
import { Err, fail, Ok, type AppResult } from '../../../shared/result'
import {
  arc,
  chainBounds,
  elementLength,
  line,
  regionLoops,
  type Bounds2,
  type Element,
} from '../../geometry/2d/model'
import { orientRegion } from '../../geometry/2d/place'
import type { Region2dPort } from '../../geometry/2d/port'
import type { LinePathLevels, Shape as ShapeGeometry, Vec2 } from '../../geometry/model'
import type { Part } from '../operation'
import type { EngravingRecord, ShapeItem } from '../shape.dto'
import { definitionOf, requirePort, resolveShape } from '../shape'
import { pathLevelProfile } from '../shape-items'
import { engravingPreset, presetLines, type MotifLine } from './presets'

/** Most elements (lines and arcs) of one engraved pattern (the SVG import limit, `engravingTooMany`). */
export const ENGRAVING_ELEMENTS_MAX = 20_000
/** From these many elements or this length (mm) the pattern is heavy (`dfm.engravingHeavy`). */
export const ENGRAVING_HEAVY_ELEMENTS = 5000
export const ENGRAVING_HEAVY_LENGTH = 10_000

/** One placed line: as a Line path's geometry (face frame, centre [0, 0]) with its levels. */
export interface EngravingLine {
  readonly shape: ShapeGeometry
  readonly levels: LinePathLevels | null
}

export interface EngravingFacts {
  /** Lines placed (loops and open paths). */
  readonly lines: number
  /** Elements over all lines. */
  readonly elements: number
  /** Total centreline length (mm). */
  readonly length: number
  /** The motif's frame width as placed (mm): `size`, or the fitted one. */
  readonly size: number
  /** The placed lines' bounds (face frame); undefined without lines. */
  readonly bounds: Bounds2 | undefined
  /** The boundary less the margin as a box (face frame); undefined when nothing is left. */
  readonly area: Bounds2 | undefined
}

export interface ResolvedEngraving {
  readonly lines: readonly EngravingLine[]
  readonly facts: EngravingFacts
}

/** The motif's lines in its own frame, the frame's box and where its lines are drawn. */
interface Motif {
  readonly lines: readonly MotifLine[]
  readonly frame: Bounds2
}

const invalid = (path: (string | number)[], rule: string, message: string): AppResult<never> =>
  fail('model.invariant', message, {
    issues: [{ path, rule, message }],
    where: 'resolveEngraving',
  })

type Shapes = Part['shapes']

/** A named shape's loops and open path as motif lines, with its levels (as the Line reads them). */
function shapeMotifLines(
  port: Region2dPort,
  shapes: Shapes,
  shapeId: string,
  k: number,
): AppResult<MotifLine[]> {
  const named = shapes?.get(shapeId)
  if (named === undefined)
    return invalid(['motif', 'shapeIds', k], 'unknownShape', `shape ${shapeId} is not loaded`)
  const def = definitionOf(named.items)
  const r = resolveShape(port, def)
  if (r.isErr()) return Err(r.unwrapErr().prefixIssues('motif', 'shapeIds', k))
  const s = r.unwrap()
  const paths = def.filter(
    (i): i is Extract<ShapeItem<number>, { kind: 'path' }> =>
      i.kind === 'path' && i.levels !== undefined,
  )
  if (s.kind === 'path') {
    const prof = paths[0] === undefined ? undefined : pathLevelProfile(paths[0])
    return Ok([
      { elements: s.path.elements, closed: false, ...(prof === undefined ? {} : { levels: prof }) },
    ])
  }
  // a closed shape takes one level, its items' deepest (engraved-patterns.md E2)
  const all = paths.flatMap((i) => (typeof i.levels === 'number' ? [i.levels] : i.levels!))
  const level = all.length === 0 ? 1 : Math.max(...all)
  return Ok(
    regionLoops(s.region).map((l) => ({
      elements: l.elements,
      closed: true,
      ...(level === 1 ? {} : { levels: { u: [0, 1], level: [level, level] } }),
    })),
  )
}

function motifOf(
  rec: EngravingRecord,
  shapes: Shapes,
  port: Region2dPort | undefined,
): AppResult<Motif> {
  if ('preset' in rec.motif) {
    const preset = engravingPreset(rec.motif.preset)
    return presetLines(rec.motif.preset).map((p) => ({
      lines: p.lines,
      frame: { min: [0, 0], max: [preset!.size[0], preset!.size[1]] },
    }))
  }
  const p = requirePort(port, 'resolveEngraving')
  if (p.isErr()) return p
  const lines: MotifLine[] = []
  for (const [k, id] of rec.motif.shapeIds.entries()) {
    const r = shapeMotifLines(p.unwrap(), shapes, id, k)
    if (r.isErr()) return r
    lines.push(...r.unwrap())
  }
  const frame = chainBounds(lines.flatMap((l) => l.elements))
  if (frame === undefined) return invalid(['motif'], 'engravingEmpty', 'the motif has no line')
  return Ok({ lines, frame })
}

/** The boundary less the margin as a box (face frame), or undefined when nothing is left. */
function areaOf(
  rec: EngravingRecord,
  shapes: Shapes,
  port: Region2dPort | undefined,
): AppResult<Bounds2 | undefined> {
  const m = rec.margin
  let box: Bounds2 = rec.boundary
  if (rec.area !== undefined) {
    const p = requirePort(port, 'resolveEngraving')
    if (p.isErr()) return p
    const named = shapes?.get(rec.area.shapeId)
    if (named === undefined)
      return invalid(
        ['boundary', 'shapeId'],
        'unknownShape',
        `shape ${rec.area.shapeId} is not loaded`,
      )
    const r = resolveShape(p.unwrap(), definitionOf(named.items))
    if (r.isErr()) return Err(r.unwrapErr().prefixIssues('boundary'))
    const s = r.unwrap()
    if (s.kind !== 'region')
      return invalid(['boundary'], 'engravingBoundaryOpen', 'the boundary must be a closed shape')
    const turned = orientRegion(s.region, { rotation: rec.area.rotation, mirror: false })
    const b = chainBounds(regionLoops(turned).flatMap((l) => l.elements))
    if (b === undefined) return Ok(undefined)
    const h: Vec2 = [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2]
    const c = rec.area.center
    box = { min: [c[0] - h[0], c[1] - h[1]], max: [c[0] + h[0], c[1] + h[1]] }
  }
  const lo: Vec2 = [box.min[0] + m, box.min[1] + m]
  const hi: Vec2 = [box.max[0] - m, box.max[1] - m]
  return Ok(hi[0] > lo[0] && hi[1] > lo[1] ? { min: lo, max: hi } : undefined)
}

/** A similarity (turn by `deg` about `about`, scale `k`, then `about` → `to`). */
function similarity(about: Vec2, deg: number, k: number, to: Vec2): (p: Vec2) => Vec2 {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r) * k
  const s = Math.sin(r) * k
  return (p) => {
    const x = p[0] - about[0]
    const y = p[1] - about[1]
    return [to[0] + c * x - s * y + 0, to[1] + s * x + c * y + 0]
  }
}

const mapElement = (e: Element, f: (p: Vec2) => Vec2): Element =>
  e.kind === 'line' ? line(f(e.a), f(e.b)) : arc(f(e.a), f(e.b), f(e.centre), e.ccw)

const CACHE_SIZE = 32
const cache = new Map<string, AppResult<ResolvedEngraving>>()

/** The definitions the record reads besides itself (motif and boundary shapes), for the cache key. */
function readsKey(rec: EngravingRecord, shapes: Shapes): string {
  const ids = [...('shapeIds' in rec.motif ? rec.motif.shapeIds : []), rec.area?.shapeId ?? '']
  return JSON.stringify([
    rec,
    ids.map((id) => {
      const s = shapes?.get(id)
      return s === undefined ? null : definitionOf(s.items)
    }),
  ])
}

/**
 * The engraving's lines placed in the face frame, with its facts. Issues (`model.invariant`) at
 * the feature's fields: `motif` (`unknownPreset`, `engravingEmpty`, `engravingTooMany`),
 * `boundary` (`engravingBoundaryOpen`). Nothing inside the area is no error
 * (`dfm.engravingEmpty`). The port is needed for a motif or boundary of named shapes only.
 */
export function resolveEngraving(
  rec: EngravingRecord,
  shapes: Shapes,
  port: Region2dPort | undefined,
): AppResult<ResolvedEngraving> {
  const key = readsKey(rec, shapes)
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const r = resolveUncached(rec, shapes, port)
  // a missing port is the caller's, not the record's: not cached
  if (r.isOk() || port !== undefined) {
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!)
    cache.set(key, r)
  }
  return r
}

function resolveUncached(
  rec: EngravingRecord,
  shapes: Shapes,
  port: Region2dPort | undefined,
): AppResult<ResolvedEngraving> {
  const motif = motifOf(rec, shapes, port)
  if (motif.isErr()) return motif
  const { lines: raw, frame } = motif.unwrap()
  const count = raw.reduce((n, l) => n + l.elements.length, 0)
  if (raw.length === 0) return invalid(['motif'], 'engravingEmpty', 'the motif has no line')
  if (count > ENGRAVING_ELEMENTS_MAX)
    return invalid(
      ['motif'],
      'engravingTooMany',
      `more than ${ENGRAVING_ELEMENTS_MAX} lines and arcs: use a simpler motif`,
    )
  const area = areaOf(rec, shapes, port)
  if (area.isErr()) return area
  const a = area.unwrap()
  const frameW = frame.max[0] - frame.min[0]
  const mid: Vec2 = [(frame.min[0] + frame.max[0]) / 2, (frame.min[1] + frame.max[1]) / 2]
  const areaMid: Vec2 =
    a === undefined
      ? [
          (rec.boundary.min[0] + rec.boundary.max[0]) / 2,
          (rec.boundary.min[1] + rec.boundary.max[1]) / 2,
        ]
      : [(a.min[0] + a.max[0]) / 2, (a.min[1] + a.max[1]) / 2]
  // the motif turned about its frame centre at scale 1: where its lines are drawn
  const turn = similarity(mid, rec.rotation, 1, [0, 0])
  const drawn = chainBounds(raw.flatMap((l) => l.elements.map((e) => mapElement(e, turn))))!
  let k = rec.size !== undefined && frameW > 0 ? rec.size / frameW : 1
  let to: Vec2 = rec.center ?? areaMid
  if (rec.fit === 'boundary') {
    const dw = drawn.max[0] - drawn.min[0]
    const dh = drawn.max[1] - drawn.min[1]
    if (a !== undefined) {
      const aw = a.max[0] - a.min[0]
      const ah = a.max[1] - a.min[1]
      k = Math.min(dw > 0 ? aw / dw : Infinity, dh > 0 ? ah / dh : Infinity)
      if (!Number.isFinite(k)) k = 1
    }
    // the drawn lines' box centre on the area's centre
    const dm: Vec2 = [(drawn.min[0] + drawn.max[0]) / 2, (drawn.min[1] + drawn.max[1]) / 2]
    to = [areaMid[0] - dm[0] * k, areaMid[1] - dm[1] * k]
  }
  const place = similarity(mid, rec.rotation, k, to)
  let length = 0
  const lines = raw.map((l): EngravingLine => {
    const elements = l.elements.map((e) => mapElement(e, place))
    for (const e of elements) length += elementLength(e)
    const levels: LinePathLevels | null =
      l.levels === undefined
        ? null
        : l.closed
          ? { kind: 'loops', level: Math.max(...l.levels.level) }
          : { kind: 'path', u: l.levels.u, level: l.levels.level }
    const shape: ShapeGeometry = l.closed
      ? {
          center: [0, 0],
          contour: { kind: 'region', region: { pieces: [{ outer: { elements }, holes: [] }] } },
        }
      : { center: [0, 0], contour: { kind: 'path', path: { elements } } }
    return { shape, levels }
  })
  return Ok({
    lines,
    facts: {
      lines: lines.length,
      elements: count,
      length,
      size: frameW * k,
      bounds: chainBounds(
        lines.flatMap((l) =>
          l.shape.contour.kind === 'path'
            ? l.shape.contour.path.elements
            : l.shape.contour.kind === 'region'
              ? regionLoops(l.shape.contour.region).flatMap((x) => x.elements)
              : [],
        ),
      ),
      area: a,
    },
  })
}
