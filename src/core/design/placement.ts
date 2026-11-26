/**
 * Placing an operation's shape on its face (step 4 of resolving a shape): the shape's definition
 * (a named shape's items, or a rotated rectangle as one item), mirrored and rotated, numbered from
 * its start points, and anchored by its placed bounding box. Cached per (definition, rotation,
 * mirror) beside `resolveShape`.
 * Doc: docs/architecture/shapes.md#implementation-k3, docs/modes/design-v0.3.md#placing-a-shape-on-a-face
 *
 * Pure; the `Region2dPort` is passed in (`services.region2d` in commands, the host's port in the
 * evaluation and toolpath mappers).
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type { Vec2 } from '../geometry/model'
import { chainBounds, line, regionLoops, type Bounds2 } from '../geometry/2d/model'
import {
  numberRegion,
  orientPath,
  orientRegion,
  translatePath,
  translateRegion,
  type Orientation,
} from '../geometry/2d/place'
import type { Region2dPort } from '../geometry/2d/port'
import { Rational } from '../quantity/rational'
import { chainLength } from '../geometry/2d/measure'
import { shapeRotation, type Operation, type Part, type Shape } from './operation'
import type { PatternDefinition } from './pattern/layout'
import type { ShapeDefinition } from './shape'
import { definitionOf, resolveShape, type AnyShapeDefinition, type ResolvedShape } from './shape'
import { resolveEngraving } from './engraving/resolve'
import { isOpenShape } from './surfaces'
import type { ShapeFacts, ShapeFactsTable } from './validate'

const WHERE = 'placeShape'

/**
 * The resolver's definition of an operation's shape: a named shape's items, else one item. An
 * owned pattern shape (patterns P1) is its pattern with the cell's items in place (a named cell
 * from `shapes`, so the pattern follows edits of that shape: the definition is the cache key).
 */
export function shapeDefinition(
  s: Shape,
  shapes: Part['shapes'],
  /** Owned shapes being nested (P4 stacks): a cycle is a corrupt part, not a hang. */
  seen: ReadonlySet<string> = new Set(),
): AppResult<AnyShapeDefinition> {
  const missing = (shapeId: string) =>
    fail('internal.unexpected', `shape ${shapeId} is not loaded`, {
      where: WHERE,
      data: { shapeId },
    })
  switch (s.kind) {
    case 'named': {
      const named = shapes?.get(s.shapeId)
      if (named === undefined) return missing(s.shapeId)
      const p = named.pattern
      // offset items carry their sources (design-llm-first.md § Offset item)
      if (p === undefined) return Ok(definitionOf(named.items, shapes, s.shapeId))
      let cell: ShapeDefinition
      if ('item' in p.cell) cell = [p.cell.item]
      else {
        const c = shapes?.get(p.cell.shapeId)
        if (c === undefined) return missing(p.cell.shapeId)
        cell = definitionOf(c.items, shapes, p.cell.shapeId)
      }
      // a boundary shape (patterns P2) is carried by its items too, so its edits restale
      let area: { items: ShapeDefinition; center: [number, number]; rotation: number } | undefined
      if (p.area !== undefined) {
        const a = shapes?.get(p.area.shapeId)
        if (a === undefined) return missing(p.area.shapeId)
        area = {
          items: definitionOf(a.items, shapes, p.area.shapeId),
          center: p.area.center,
          rotation: p.area.rotation,
        }
      }
      // a stacked pattern (patterns P4) nests the definition of the one below it
      let floor: readonly [PatternDefinition] | undefined
      if (p.floor !== undefined) {
        if (seen.has(s.shapeId) || seen.has(p.floor)) return missing(p.floor)
        const below = shapeDefinition(
          { ...s, shapeId: p.floor },
          shapes,
          new Set([...seen, s.shapeId]),
        )
        if (below.isErr()) return below
        const d = below.unwrap()
        if (d.length !== 1 || d[0]!.kind !== 'pattern') return missing(p.floor)
        floor = d as readonly [PatternDefinition]
      }
      const { cell: _, area: _a, floor: _f, ...rest } = p
      return Ok([
        {
          kind: 'pattern',
          op: 'add',
          ...rest,
          cell,
          ...(area === undefined ? {} : { area }),
          ...(floor === undefined ? {} : { floor }),
        },
      ])
    }
    case 'rectangle':
      return Ok([
        {
          kind: 'rectangle',
          op: 'add',
          center: [0, 0],
          length: s.length.canonical,
          width: s.width.canonical,
          cornerRadius: s.cornerRadius.canonical,
        },
      ])
    case 'circle':
      return Ok([{ kind: 'circle', op: 'add', center: [0, 0], diameter: s.diameter.canonical }])
  }
}

/** The orientation of an operation's shape (rotation, mirror). */
export const shapeOrientation = (s: Shape): Orientation => ({
  rotation: shapeRotation(s),
  mirror: s.kind === 'named' && s.mirror,
})

/** A resolved shape oriented in the face frame's axes and numbered, with its exact bounds. */
export interface OrientedShape {
  readonly shape: ResolvedShape
  readonly bounds: Bounds2
}

/** Entries kept per port (as the resolve cache). */
const ORIENTED_CACHE_SIZE = 128
const caches = new WeakMap<Region2dPort, Map<string, AppResult<OrientedShape>>>()

function orient(r: ResolvedShape, o: Orientation): OrientedShape {
  const shape: ResolvedShape =
    r.kind === 'region'
      ? {
          kind: 'region',
          region: numberRegion(orientRegion(r.region, o)),
          ...(r.pattern === undefined ? {} : { pattern: r.pattern }),
        }
      : { kind: 'path', path: orientPath(r.path, o) }
  if (r.kind === 'region' && r.frame !== undefined) {
    // a pattern anchors by its frame (the boundary rectangle), whatever cells fit (patterns P1)
    const { min, max } = r.frame
    const corner = (x: number, y: number) =>
      orientPath({ elements: [line([x, y], [x, y + 1])] }, o).elements[0]!.a
    const pts = [corner(min[0], min[1]), corner(max[0], min[1]), corner(max[0], max[1])]
    pts.push(corner(min[0], max[1]))
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const bounds: Bounds2 = {
      min: [Math.min(...xs), Math.min(...ys)],
      max: [Math.max(...xs), Math.max(...ys)],
    }
    return { shape, bounds }
  }
  const loops = shape.kind === 'region' ? regionLoops(shape.region) : [shape.path]
  const bounds = chainBounds(loops.flatMap((l) => l.elements)) ?? { min: [0, 0], max: [0, 0] }
  return { shape, bounds }
}

/**
 * The definition resolved (`resolveShape`), mirrored, rotated about the shape frame's origin and
 * numbered; cached per port by (definition, rotation, mirror). The translation is applied by
 * `placeShape` per call (it is linear in the elements).
 */
export function orientedShape(
  port: Region2dPort,
  def: AnyShapeDefinition,
  o: Orientation,
): AppResult<OrientedShape> {
  let cache = caches.get(port)
  if (cache === undefined) caches.set(port, (cache = new Map()))
  const key = `${o.rotation}|${o.mirror ? 1 : 0}|${JSON.stringify(def)}`
  const hit = cache.get(key)
  if (hit !== undefined) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const r = resolveShape(port, def).map((resolved) => orient(resolved, o))
  cache.set(key, r)
  if (cache.size > ORIENTED_CACHE_SIZE) cache.delete(cache.keys().next().value as string)
  return r
}

/** An operation's shape placed in its face frame. */
export interface PlacedShape {
  /** Region or open path relative to `centre`, numbered (design-v0.3.md#surfaces). */
  readonly outline: ResolvedShape
  /** Centre of the placed bounding box, `[u, v]` in the face frame (mm). */
  readonly centre: Vec2
  /** Size of the placed bounding box along `u` and `v` (mm). */
  readonly size: Vec2
}

const half = (p: 'min' | 'centre' | 'max', extent: number) =>
  p === 'min' ? -extent / 2 : p === 'max' ? extent / 2 : 0

/**
 * The shape placed on its face: the oriented shape's bounding box anchored so its `anchor` point
 * lies at `center` (design-v0.3.md: rotation about the anchor point, anchors on the placed box).
 * Errors: the shape's own (`model.invariant` at `items.…`, prefixed with the shape id for a named
 * shape) or `internal.unexpected` for a shape that is not loaded.
 */
export function placeShape(
  port: Region2dPort,
  s: Shape,
  shapes: Part['shapes'],
): AppResult<PlacedShape> {
  const def = shapeDefinition(s, shapes)
  if (def.isErr()) return def
  const o = orientedShape(port, def.unwrap(), shapeOrientation(s))
  if (o.isErr()) {
    const e = s.kind === 'named' ? o.unwrapErr().prefixIssues('shapes', s.shapeId) : o.unwrapErr()
    return Err(e.withContext(WHERE))
  }
  const { shape, bounds } = o.unwrap()
  const size: Vec2 = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]]
  const mid: Vec2 = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2]
  const centre: Vec2 = [
    s.center[0].canonical - half(s.anchor.u, size[0]),
    s.center[1].canonical - half(s.anchor.v, size[1]),
  ]
  const shift: Vec2 = [-mid[0], -mid[1]]
  const outline: ResolvedShape =
    shape.kind === 'region'
      ? { kind: 'region', region: translateRegion(shape.region, shift) }
      : { kind: 'path', path: translatePath(shape.path, shift) }
  return Ok({ outline, centre, size })
}

/** Placed extents as exact rationals for re-anchoring (rounded to 1e-9 mm). */
export function exactExtents(size: Vec2): readonly [Rational, Rational] {
  const r = (x: number) => Rational.create(BigInt(Math.round(x * 1e9)), 1_000_000_000n).unwrap()
  return [r(size[0]), r(size[1])]
}

/**
 * Validation facts of the named shapes of `ops` (validate.ts `ShapeFacts`): open from the
 * definition; with the port, loop count and loop length of the placed shape. A shape that does
 * not resolve fails with its own error.
 */
export function shapeFacts(
  ops: readonly Operation[],
  shapes: Part['shapes'],
  port: Region2dPort | undefined,
): AppResult<ShapeFactsTable> {
  const out = new Map<string, ShapeFacts>()
  for (const op of ops) {
    // E4: an engraved pattern's owned lines resolve here, so their issues (`engravingTooMany`)
    // reach the feature's fields as a pattern's cells' do
    if (op.kind === 'line' && port !== undefined)
      for (const p of op.paths) {
        const rec = shapes?.get(p.shapeId)?.engraving
        if (rec === undefined) continue
        const r = resolveEngraving(rec, shapes, port)
        if (r.isErr())
          return Err(r.unwrapErr().prefixIssues('operations', op.id, 'shapes', p.shapeId))
      }
    if ((op.kind !== 'pocket' && op.kind !== 'profile') || op.shape.kind !== 'named') continue
    const open = isOpenShape(op.shape, shapes)
    if (port === undefined) {
      out.set(op.id, { open })
      continue
    }
    const placed = placeShape(port, op.shape, shapes)
    if (placed.isErr()) return Err(placed.unwrapErr().prefixIssues('operations', op.id))
    const o = placed.unwrap().outline
    if (o.kind === 'path') out.set(op.id, { open: true, loops: 1, length: chainLength(o.path) })
    else {
      const loops = o.region.pieces.reduce((n, p) => n + 1 + p.holes.length, 0)
      const outer = o.region.pieces[0]?.outer
      out.set(op.id, { open, loops, length: outer === undefined ? 0 : chainLength(outer) })
    }
  }
  return Ok(out)
}
