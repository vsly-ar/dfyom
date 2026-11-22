/**
 * Named shapes of a part: the model (items with `Quantity` values), DTO conversion and
 * `resolveShape` – items to a region or an open path through the 2D port, cached per definition.
 * Doc: docs/architecture/shapes.md#resolving-a-shape, docs/architecture/shapes.md#implementation-k2,
 * docs/modes/design-v0.3.md#what-a-shape-is
 *
 * Resolution is pure and synchronous (it runs in the command step, shapes.md § Where the 2D layer
 * runs). Placement on a face (anchor, rotation, mirror) is the operation's (K3); this module
 * resolves in the shape frame.
 */
import type { Issue } from '../../shared/errors/app-error'
import { collect, Err, fail, Ok, type AppResult } from '../../shared/result'
import type { Vec2 } from '../geometry/model'
import { chainLength, elementPointAt } from '../geometry/2d/measure'
import {
  arcRadius,
  chainBounds,
  regionArea,
  regionLoops,
  type Bounds2,
  type Element,
  type Path,
  type Region,
} from '../geometry/2d/model'
import type { Region2dPort } from '../geometry/2d/port'
import { quantityFromDTO } from '../library/item'
import type { Quantity } from '../quantity/quantity'
import type { QuantityDTO } from '../quantity/quantity.dto'
import { AREA_EPSILON, itemChain } from './shape-items'
import type {
  ShapeDTO,
  ShapeItem,
  ShapeItemDTO,
  ShapePoint,
  ShapeSegment,
  ShapeSource,
} from './shape.dto'

/** A part's named shape with loaded quantities. */
export interface NamedShape {
  readonly id: string
  readonly name: string
  readonly items: readonly ShapeItem<Quantity>[]
  readonly source?: ShapeSource | undefined
}

/** Default name of `shape<n>`: "Shape n" (design-v0.3.md § What a shape is). */
export const shapeName = (n: number): string => `Shape ${n}`

// ── generic item mapping ────────────────────────────────────────────────────────────────────

type ParamPath = readonly (string | number)[]

/**
 * The item with every quantity mapped by `f` (given its parameter path inside the item, e.g.
 * `['segments', 2, 'to', 0]`); other fields are copied, optional ones only when present.
 */
export function mapItem<A, B>(item: ShapeItem<A>, f: (a: A, path: ParamPath) => B): ShapeItem<B> {
  const pt = (p: ShapePoint<A>, ...path: (string | number)[]): ShapePoint<B> => [
    f(p[0], [...path, 0]),
    f(p[1], [...path, 1]),
  ]
  const opt = <K extends string>(key: K, v: A | undefined): { [P in K]?: B } =>
    (v === undefined ? {} : { [key]: f(v, [key]) }) as { [P in K]?: B }
  switch (item.kind) {
    case 'rectangle':
      return {
        kind: 'rectangle',
        op: item.op,
        center: pt(item.center, 'center'),
        length: f(item.length, ['length']),
        width: f(item.width, ['width']),
        cornerRadius: f(item.cornerRadius, ['cornerRadius']),
        ...opt('rotation', item.rotation),
      }
    case 'circle':
      return {
        kind: 'circle',
        op: item.op,
        center: pt(item.center, 'center'),
        diameter: f(item.diameter, ['diameter']),
      }
    case 'obround':
      return {
        kind: 'obround',
        op: item.op,
        center: pt(item.center, 'center'),
        length: f(item.length, ['length']),
        width: f(item.width, ['width']),
        ...opt('rotation', item.rotation),
      }
    case 'polygon':
      return {
        kind: 'polygon',
        op: item.op,
        center: pt(item.center, 'center'),
        sides: f(item.sides, ['sides']),
        diameter: f(item.diameter, ['diameter']),
        ...(item.across === undefined ? {} : { across: item.across }),
        ...opt('cornerRadius', item.cornerRadius),
        ...opt('rotation', item.rotation),
      }
    case 'path':
      return {
        kind: 'path',
        op: item.op,
        start: pt(item.start, 'start'),
        segments: item.segments.map((s, k): ShapeSegment<B> => {
          const to = pt(s.to, 'segments', k, 'to')
          if (s.kind !== 'arc') return { kind: s.kind, to }
          return {
            kind: 'arc',
            to,
            radius: f(s.radius, ['segments', k, 'radius']),
            cw: s.cw,
            ...(s.large === undefined ? {} : { large: s.large }),
          }
        }),
        closed: item.closed,
        ...(item.fillets === undefined
          ? {}
          : {
              fillets: item.fillets.map((x, i) => ({
                vertex: x.vertex,
                radius: f(x.radius, ['fillets', i, 'radius']),
              })),
            }),
      }
  }
}

/** Every quantity of an item with its parameter path (`center.0`, `segments.2.radius`, …). */
export function itemQuantities<A>(item: ShapeItem<A>): { path: ParamPath; value: A }[] {
  const out: { path: ParamPath; value: A }[] = []
  mapItem(item, (value, path) => out.push({ path, value }))
  return out
}

// ── DTO ↔ model ─────────────────────────────────────────────────────────────────────────────

/** The shape from its DTO; quantity issues carry `items.<n>.<param>` paths. */
export function shapeFromDTO(dto: ShapeDTO): AppResult<NamedShape> {
  const results: AppResult<unknown>[] = []
  const items = dto.items.map((item, n) =>
    mapItem(item, (q: QuantityDTO, path) => {
      const r = quantityFromDTO(q, 'items', n, ...path)
      results.push(r)
      return r.unwrapOr(undefined as unknown as Quantity)
    }),
  )
  return collect(results).map(() => ({
    id: dto.id,
    name: dto.name,
    items,
    ...(dto.source === undefined ? {} : { source: dto.source }),
  }))
}

export function itemToDTO(item: ShapeItem<Quantity>): ShapeItemDTO {
  return mapItem(item, (q) => q.toDTO())
}

export function shapeToDTO(s: NamedShape): ShapeDTO {
  return {
    id: s.id,
    name: s.name,
    items: s.items.map(itemToDTO),
    ...(s.source === undefined ? {} : { source: { ...s.source } }),
  }
}

/** The resolver's numbers: lengths in mm, angles in degrees, `sides` as a number. */
export type ShapeDefinition = readonly ShapeItem<number>[]

export const definitionOf = (items: readonly ShapeItem<Quantity>[]): ShapeDefinition =>
  items.map((item) => mapItem(item, (q) => q.canonical))

// ── resolving ───────────────────────────────────────────────────────────────────────────────

/** A resolved shape in its shape frame: a region (closed items) or one open path. */
export type ResolvedShape =
  | { readonly kind: 'region'; readonly region: Region }
  | { readonly kind: 'path'; readonly path: Path }

const WHERE = 'resolveShape'

function invalid(issues: Issue[]): AppResult<never> {
  return fail('model.invariant', `${issues.length} invalid shape value(s)`, {
    issues,
    where: WHERE,
  })
}

/** Item structure: the first item adds, an open path is the only item. */
function structureIssues(def: ShapeDefinition): Issue[] {
  const out: Issue[] = []
  if (def.length === 0)
    out.push({ path: ['items'], rule: 'empty', message: 'needs at least one item' })
  if (def[0] !== undefined && def[0].op !== 'add')
    out.push({ path: ['items', 0, 'op'], rule: 'firstItemAdd', message: 'the first item must add' })
  if (def.length > 1)
    def.forEach((item, n) => {
      if (item.kind === 'path' && !item.closed)
        out.push({
          path: ['items', n, 'closed'],
          rule: 'openPathAlone',
          message: 'an open path must be the only item of its shape',
        })
    })
  return out
}

/**
 * Steps 1–3 of shapes.md § Resolving a shape, uncached: items to chains, the fold of their `op`
 * through the port, validation. Errors are `model.invariant` with `items.<n>.<param>` paths, or
 * the port's `geometry.evaluation` (a bug: inputs are checked first).
 */
export function resolveDefinition(
  port: Region2dPort,
  def: ShapeDefinition,
): AppResult<ResolvedShape> {
  const structure = structureIssues(def)
  if (structure.length > 0) return invalid(structure)
  const issues: Issue[] = []
  const chains = def.map((item, n) => itemChain(item, n, issues))
  if (issues.length > 0) return invalid(issues)
  const first = chains[0]!
  if (!first.closed) return Ok({ kind: 'path', path: first.loop })
  let acc: Region | undefined
  for (const [n, chain] of chains.entries()) {
    const item = def[n]!
    const region = port.normalise([chain!.loop])
    if (region.isErr()) return Err(region.unwrapErr().prefixIssues('items', n).withContext(WHERE))
    if (acc === undefined) {
      acc = region.unwrap()
      continue
    }
    const r =
      item.op === 'add'
        ? port.union(acc, region.unwrap())
        : item.op === 'subtract'
          ? port.difference(acc, region.unwrap())
          : port.intersect(acc, region.unwrap())
    if (r.isErr()) return Err(r.unwrapErr().prefixIssues('items', n).withContext(WHERE))
    acc = r.unwrap()
  }
  // the port's booleans return normalised regions; one more pass only after a fold
  let region = acc!
  if (def.length > 1) {
    const r = port.normalise(regionLoops(region))
    if (r.isErr()) return Err(r.unwrapErr().withContext(WHERE))
    region = r.unwrap()
  }
  const area = regionArea(region)
  if (region.pieces.length === 0 || area <= AREA_EPSILON)
    return invalid([
      { path: ['items'], rule: 'shapeEmpty', message: 'the shape has no area', params: { area } },
    ])
  return Ok({ kind: 'region', region })
}

// ── cache ───────────────────────────────────────────────────────────────────────────────────

/** Entries kept per port: a project's shapes plus the variants of an editing session. */
export const SHAPE_CACHE_SIZE = 128

/** Least recently used results by definition key (`Map` keeps insertion order). */
class ShapeCache {
  private readonly entries = new Map<string, AppResult<ResolvedShape>>()
  get(key: string): AppResult<ResolvedShape> | undefined {
    const hit = this.entries.get(key)
    if (hit !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, hit)
    }
    return hit
  }
  set(key: string, value: AppResult<ResolvedShape>): void {
    this.entries.set(key, value)
    if (this.entries.size > SHAPE_CACHE_SIZE)
      this.entries.delete(this.entries.keys().next().value as string)
  }
}

const caches = new WeakMap<Region2dPort, ShapeCache>()

/**
 * `resolveDefinition`, cached per port by the definition's numbers (results are plain data and
 * deterministic, so equal numbers give equal results; errors are cached too). Commands, queries
 * and later the geometry and toolpath mappers call it many times per edit.
 */
export function resolveShape(port: Region2dPort, def: ShapeDefinition): AppResult<ResolvedShape> {
  let cache = caches.get(port)
  if (cache === undefined) {
    cache = new ShapeCache()
    caches.set(port, cache)
  }
  const key = JSON.stringify(def)
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const r = resolveDefinition(port, def)
  cache.set(key, r)
  return r
}

/** The port, or the error of a host without one (services.region2d, commands.md § Services). */
export function requirePort(
  port: Region2dPort | undefined,
  where: string,
): AppResult<Region2dPort> {
  return port === undefined
    ? fail('internal.unexpected', 'no 2D geometry port in this host', { where })
    : Ok(port)
}

// ── summary for queries ─────────────────────────────────────────────────────────────────────

/** Elements as plain data for queries (mm). */
export type ElementOut =
  | { kind: 'line'; a: [number, number]; b: [number, number] }
  | {
      kind: 'arc'
      a: [number, number]
      b: [number, number]
      centre: [number, number]
      ccw: boolean
    }

const pt = (p: Vec2): [number, number] => [p[0], p[1]]
const elementOut = (e: Element): ElementOut =>
  e.kind === 'line'
    ? { kind: 'line', a: pt(e.a), b: pt(e.b) }
    : { kind: 'arc', a: pt(e.a), b: pt(e.b), centre: pt(e.centre), ccw: e.ccw }

export interface ShapeSummary {
  readonly kind: 'region' | 'path'
  /** Region pieces (outer loop counter-clockwise, holes clockwise); one open path. */
  readonly pieces?: { outer: ElementOut[]; holes: ElementOut[][] }[]
  readonly path?: ElementOut[]
  readonly elements: number
  /** mm²; 0 for a path. */
  readonly area: number
  readonly bounds: { min: [number, number]; max: [number, number] }
  /** mm; for a path its length. */
  readonly length: number
  /**
   * Smallest radius a tool cutting the region's interior meets (0: a sharp corner); absent when
   * the region has no such corner, and for a path.
   */
  readonly smallestInsideRadius?: number
}

/**
 * The smallest inside radius of a region: with the interior on the left of every loop, a vertex
 * turning left without an arc is 0, an arc turning left (counter-clockwise) is its radius.
 */
export function smallestInsideRadius(region: Region): number | undefined {
  let min: number | undefined
  const take = (r: number) => {
    min = min === undefined ? r : Math.min(min, r)
  }
  for (const loop of regionLoops(region)) {
    const els = loop.elements
    for (let i = 0; i < els.length; i++) {
      const e = els[i]!
      if (e.kind === 'arc' && e.ccw) take(arcRadius(e))
      const next = els[(i + 1) % els.length]!
      const t1 = elementPointAt(e, 1).tangent
      const t2 = elementPointAt(next, 0).tangent
      const turn = Math.atan2(t1[0] * t2[1] - t1[1] * t2[0], t1[0] * t2[0] + t1[1] * t2[1])
      if (turn > 1e-6) take(0)
    }
  }
  return min
}

export function shapeSummary(r: ResolvedShape): ShapeSummary {
  const loops = r.kind === 'region' ? regionLoops(r.region) : [r.path]
  const all = loops.flatMap((l) => l.elements)
  const b: Bounds2 = chainBounds(all) ?? { min: [0, 0], max: [0, 0] }
  const common = {
    elements: all.length,
    bounds: { min: pt(b.min), max: pt(b.max) },
    length: loops.reduce((s, l) => s + chainLength(l), 0),
  }
  if (r.kind === 'path')
    return { kind: 'path', path: r.path.elements.map(elementOut), area: 0, ...common }
  const inside = smallestInsideRadius(r.region)
  return {
    kind: 'region',
    pieces: r.region.pieces.map((p) => ({
      outer: p.outer.elements.map(elementOut),
      holes: p.holes.map((h) => h.elements.map(elementOut)),
    })),
    area: regionArea(r.region),
    ...common,
    ...(inside === undefined ? {} : { smallestInsideRadius: inside }),
  }
}
