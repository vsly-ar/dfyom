/**
 * An engraved pattern's owned shape resolved (engraved-patterns.md § Engraved pattern, E3): the
 * motif's lines (a preset's, or the part's named shapes' loops and open paths with their levels)
 * placed once in the face frame — at `center` and `size`, or with `fit: 'boundary'` scaled to fit
 * the boundary less the margin and centred — each as the Line geometry takes a path (a closed loop
 * or one open path, centre [0, 0]) with its levels. Read by the Line's geometry input (owned
 * `<id>_line`), the viewport, the read-out and the findings; cached by the record and the shapes
 * it reads. E4: with a `layout` the motif is a tile placed at every node of Pattern's lattice
 * (layout.ts's node code: square, staggered, hex, polar; polar tiles optionally `radial`), kept
 * whole or clipped at the boundary less the margin (clip-lines.ts), then coincident elements are
 * removed (the higher level kept) and lines whose ends meet across tiles chained (line.ts), so
 * the owned Line cuts each seam once and runs on across it.
 * Doc: docs/modes/engraved-patterns.md#engraved-pattern-feature,
 * docs/modes/engraved-patterns.md#implementation-e3, docs/modes/engraved-patterns.md#implementation-e4
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
import { ClipBoundary, clipLine } from '../../geometry/2d/clip-lines'
import { orientRegion, translateRegion } from '../../geometry/2d/place'
import type { Region2dPort } from '../../geometry/2d/port'
import type { Region } from '../../geometry/2d/model'
import { chainOpen, dropCoincident, sliceProfile, type RawLine } from '../../geometry/line'
import type { LinePathLevels, Shape as ShapeGeometry, Vec2 } from '../../geometry/model'
import { polarNodes, rowNodes, type LatticeNode } from '../pattern/layout'
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
  /** E4: tiles placed (kept whole or clipped); 1 for `single`. */
  readonly tiles: number
  /** E4: coincident elements removed across tiles. */
  readonly coincident: number
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

/**
 * The boundary less the margin: its box (face frame; undefined when nothing is left) and, for
 * clipping and whole tiles (E4), the region itself (`clip`: computed on request — the face
 * rectangle less the margin, or the named boundary placed and offset inwards by the margin, as
 * Pattern's area).
 */
interface Area {
  readonly box: Bounds2 | undefined
  readonly region: () => AppResult<Region>
}

const rectRegion = (b: Bounds2): Region => {
  const c: Vec2[] = [b.min, [b.max[0], b.min[1]], b.max, [b.min[0], b.max[1]]]
  return { pieces: [{ outer: { elements: c.map((p, i) => line(p, c[(i + 1) % 4]!)) }, holes: [] }] }
}

function areaOf(
  rec: EngravingRecord,
  shapes: Shapes,
  port: Region2dPort | undefined,
): AppResult<Area> {
  const m = rec.margin
  let box: Bounds2 = rec.boundary
  let placed: { region: Region; port: Region2dPort } | undefined
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
    if (b === undefined) return Ok({ box: undefined, region: () => Ok({ pieces: [] }) })
    const h: Vec2 = [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2]
    const c = rec.area.center
    box = { min: [c[0] - h[0], c[1] - h[1]], max: [c[0] + h[0], c[1] + h[1]] }
    placed = {
      region: translateRegion(turned, [
        c[0] - (b.min[0] + b.max[0]) / 2,
        c[1] - (b.min[1] + b.max[1]) / 2,
      ]),
      port: p.unwrap(),
    }
  }
  const lo: Vec2 = [box.min[0] + m, box.min[1] + m]
  const hi: Vec2 = [box.max[0] - m, box.max[1] - m]
  const inner: Bounds2 | undefined =
    hi[0] > lo[0] && hi[1] > lo[1] ? { min: lo, max: hi } : undefined
  let memo: AppResult<Region> | undefined
  const region = (): AppResult<Region> => {
    if (memo !== undefined) return memo
    if (placed === undefined) memo = Ok(inner === undefined ? { pieces: [] } : rectRegion(inner))
    else memo = m > 0 ? placed.port.offset(placed.region, m) : Ok(placed.region)
    return memo
  }
  return Ok({ box: inner, region })
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
  if (rec.layout !== undefined) return tiled(rec, raw, frame, area.unwrap())
  const a = area.unwrap().box
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
  if (rec.fit === 'clip') {
    // E4: one motif cut at the boundary less the margin, as tiles are
    const region = area.unwrap().region()
    if (region.isErr()) return region
    const clipped = clipLines(
      raw.map((l) =>
        rawLine(
          l,
          l.elements.map((e) => mapElement(e, place)),
        ),
      ),
      new ClipBoundary(region.unwrap()),
      false,
    )
    const lines = clipped.map(engravingLine)
    return Ok({ lines, facts: factsOf(lines, frameW * k, a, 1, 0) })
  }
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
      bounds: boundsOf(lines),
      area: a,
      tiles: 1,
      coincident: 0,
    },
  })
}

const lineElements = (l: EngravingLine): readonly Element[] =>
  l.shape.contour.kind === 'path'
    ? l.shape.contour.path.elements
    : l.shape.contour.kind === 'region'
      ? regionLoops(l.shape.contour.region).flatMap((x) => x.elements)
      : []

const boundsOf = (lines: readonly EngravingLine[]): Bounds2 | undefined =>
  chainBounds(lines.flatMap(lineElements))

function factsOf(
  lines: readonly EngravingLine[],
  size: number,
  area: Bounds2 | undefined,
  tiles: number,
  coincident: number,
): EngravingFacts {
  let elements = 0
  let length = 0
  for (const l of lines)
    for (const e of lineElements(l)) {
      elements++
      length += elementLength(e)
    }
  return {
    lines: lines.length,
    elements,
    length,
    size,
    bounds: boundsOf(lines),
    area,
    tiles,
    coincident,
  }
}

// ── E4: tiles ──────────────────────────────────────────────────────────────────────────────

/** A placed motif line with its level as the profile (`d` = level, so "deeper" = higher level). */
function rawLine(l: MotifLine, elements: readonly Element[]): RawLine {
  let L = 0
  for (const e of elements) L += elementLength(e)
  const lv = l.levels
  const profile =
    lv === undefined
      ? { s: [0, L], d: [1, 1] }
      : l.closed
        ? { s: [0, L], d: [Math.max(...lv.level), Math.max(...lv.level)] }
        : { s: lv.u.map((u) => u * L), d: [...lv.level] }
  return { elements, closed: l.closed, profile }
}

/** A resolved line (level profile) as the Line takes a path; level 1 throughout = no levels. */
function engravingLine(l: RawLine): EngravingLine {
  const flat = l.profile.d.every((d) => Math.abs(d - 1) <= 1e-12)
  if (l.closed)
    return {
      shape: {
        center: [0, 0],
        contour: {
          kind: 'region',
          region: { pieces: [{ outer: { elements: [...l.elements] }, holes: [] }] },
        },
      },
      levels: flat ? null : { kind: 'loops', level: Math.max(...l.profile.d) },
    }
  const L = l.profile.s.at(-1)! || 1
  return {
    shape: { center: [0, 0], contour: { kind: 'path', path: { elements: [...l.elements] } } },
    levels: flat
      ? null
      : { kind: 'path', u: l.profile.s.map((s) => s / L), level: [...l.profile.d] },
  }
}

/** Lines cut at the boundary: whole when inside, dropped outside, else their inside pieces. */
function clipLines(
  lines: readonly RawLine[],
  boundary: ClipBoundary,
  wholeOnly: boolean,
): RawLine[] {
  const out: RawLine[] = []
  for (const l of lines) {
    const c = clipLine(l.elements, l.closed, boundary)
    if (c === 'inside') out.push(l)
    else if (c === 'outside' || wholeOnly) continue
    else
      for (const run of c) {
        const piece = sliceProfile(l.profile, run.from, run.to)
        out.push({ elements: run.elements, closed: false, profile: piece })
      }
  }
  return out
}

const tooMany = () =>
  invalid(
    ['layout'],
    'engravingTooMany',
    `more than ${ENGRAVING_ELEMENTS_MAX} lines and arcs: enlarge the tile, widen the spacing or use a simpler motif`,
  )

/**
 * The motif as tiles on the record's lattice: the frame's centre on every node (pitch = the
 * frame at `size` plus the gap, or the given pitch; hex rows 60° apart), each tile turned by
 * `rotation` (+ the lattice angle; polar `radial`: + its node's direction − 90°, so the tile's top
 * faces outwards; `flip`: + 180°). With `clip` the lines are cut at the area, else only tiles
 * wholly inside are kept. Then coincident elements go and lines meeting across tiles chain.
 */
function tiled(
  rec: EngravingRecord,
  raw: readonly MotifLine[],
  frame: Bounds2,
  area: Area,
): AppResult<ResolvedEngraving> {
  const layout = rec.layout!
  const frameW = frame.max[0] - frame.min[0]
  const frameH = frame.max[1] - frame.min[1]
  const k = rec.size !== undefined && frameW > 0 ? rec.size / frameW : 1
  const w = frameW * k
  const h = frameH * k
  const a0 = area.box
  const none = (): AppResult<ResolvedEngraving> =>
    Ok({ lines: [], facts: factsOf([], w, a0, 0, 0) })
  if (a0 === undefined || !(w > 0 && h > 0)) return none()
  let pa: number
  let pb: number
  if ('gap' in layout.spacing) {
    pa = w + layout.spacing.gap
    pb = layout.lattice === 'hex' ? (pa * Math.sqrt(3)) / 2 : h + layout.spacing.gap
  } else [pa, pb] = layout.spacing.pitch
  if (!(pa > 0 && pb > 0)) return none()
  const count = raw.reduce((n, l) => n + l.elements.length, 0)
  const spanW = a0.max[0] - a0.min[0]
  const spanH = a0.max[1] - a0.min[1]
  // a first estimate of the tiles over the area stops a far too small pitch before the nodes
  if ((((spanW + w) * (spanH + h)) / (pa * pb)) * count > ENGRAVING_ELEMENTS_MAX * 4)
    return tooMany()
  const mid: Vec2 = [(frame.min[0] + frame.max[0]) / 2, (frame.min[1] + frame.max[1]) / 2]
  const origin: Vec2 = layout.origin ?? [(a0.min[0] + a0.max[0]) / 2, (a0.min[1] + a0.max[1]) / 2]
  const polar = layout.lattice === 'polar'
  const flip = layout.alternate === 'flip'
  const nodes: LatticeNode[] = polar
    ? polarNodes(origin, a0.min, a0.max, pa, pb, layout.angle, flip)
    : rowNodes(origin, a0.min, a0.max, pa, pb, layout, flip)
  // the tile's reach from its node (any turn): half its drawn box's diagonal about the frame centre
  const drawn = chainBounds(raw.flatMap((l) => l.elements))!
  const reach =
    k *
    Math.max(
      ...[
        drawn.min,
        drawn.max,
        [drawn.min[0], drawn.max[1]] as Vec2,
        [drawn.max[0], drawn.min[1]] as Vec2,
      ].map((c) => Math.hypot(c[0] - mid[0], c[1] - mid[1])),
    )
  const clip = rec.fit === 'clip'
  const region = area.region()
  if (region.isErr()) return region
  const boundary = new ClipBoundary(region.unwrap())
  const rect = rec.area === undefined
  const placed: RawLine[] = []
  let tiles = 0
  let elements = 0
  for (const n of nodes) {
    const at = n.at
    if (
      at[0] + reach < a0.min[0] ||
      at[0] - reach > a0.max[0] ||
      at[1] + reach < a0.min[1] ||
      at[1] - reach > a0.max[1]
    )
      continue
    const radial =
      polar && rec.radial === true && Math.hypot(at[0] - origin[0], at[1] - origin[1]) > 1e-9
        ? (Math.atan2(at[1] - origin[1], at[0] - origin[0]) * 180) / Math.PI - 90
        : 0
    const turn = rec.rotation + (polar ? radial : layout.angle) + (n.flip ? 180 : 0)
    const place = similarity(mid, turn, k, at)
    const lines = raw.map((l) =>
      rawLine(
        l,
        l.elements.map((e) => mapElement(e, place)),
      ),
    )
    const box = chainBounds(lines.flatMap((l) => l.elements))!
    const inside = rect
      ? box.min[0] >= a0.min[0] - 1e-9 &&
        box.max[0] <= a0.max[0] + 1e-9 &&
        box.min[1] >= a0.min[1] - 1e-9 &&
        box.max[1] <= a0.max[1] + 1e-9
      : boundary.near(box).length === 0 && boundary.contains(at)
    let kept: RawLine[]
    if (inside) kept = lines
    else if (boundary.near(box).length === 0) kept = []
    else {
      kept = clipLines(lines, boundary, !clip)
      // whole tiles only: a tile losing any line is left out
      if (!clip && kept.length < lines.length) kept = []
    }
    if (kept.length === 0) continue
    tiles++
    for (const l of kept) elements += l.elements.length
    if (elements > ENGRAVING_ELEMENTS_MAX * 2) return tooMany()
    placed.push(...kept)
  }
  // seams: coincident elements once (the higher level kept), then lines meeting chained
  const { lines: once, coincident } = dropCoincident(placed)
  const chained = chainOpen(once)
  const lines = chained.map(engravingLine)
  const facts = factsOf(lines, w, a0, tiles, coincident)
  if (facts.elements > ENGRAVING_ELEMENTS_MAX) return tooMany()
  return Ok({ lines, facts })
}
