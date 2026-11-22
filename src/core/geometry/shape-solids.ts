/**
 * Solids of shape operations (v0.3 G1): pockets of general regions (holes = islands) and profiles
 * on general loops and open paths – slots `outside` / `inside` / `on` (through or blind), tabs on
 * general loops – as labelled prisms in the operation's face frame.
 * Doc: docs/architecture/shapes.md#geometry-for-shape-operations, #implementation-g1
 *
 * Slot outlines come from the 2D port (offsets, `offsetPath`, booleans); prisms from `prism.ts`.
 */
import { Err, fail, Ok, type AppResult } from '../../shared/result'
import type { LabelledMesh } from './loft'
import {
  AIR,
  localSolids,
  Table,
  type LocalMesh,
  type LocalNominal,
  type LocalSolids,
} from './local-solids'
import {
  OVERSHOOT,
  type OperationGeometry,
  type StockGeometry,
  type Vec2,
  type Vec3,
} from './model'
import { pocketRegion, profileChain, shapeOutline, tabStretches, type Outline } from './outline'
import {
  chordCount,
  flattenLoop,
  flattenRegion,
  prismMesh,
  type FlattenSense,
  type PrismLabels,
  type Triangulate,
} from './prism'
import { generalTabBands } from './tab-bands'
import { chainPointAt, elementClosest, elementPointAt, regionContains } from './2d/measure'
import {
  chainBounds,
  regionLoops,
  reverseLoop,
  type Bounds2,
  type Element,
  type Loop,
  type Region,
} from './2d/model'
import type { Region2dPort } from './2d/port'

/** What the general builders need besides the operation: the caps' triangulator and the 2D port. */
export interface ShapeSolidsContext {
  readonly triangulate: Triangulate
  readonly region2d: Region2dPort
}

type Pocket = Extract<OperationGeometry, { kind: 'pocket' }>
type Profile = Extract<OperationGeometry, { kind: 'profile' }>

const ORIGIN: Vec3 = [0, 0, 0]

const roleOf = (e: Element, i: number): string => `${e.kind === 'line' ? 'wall' : 'corner'}[${i}]`

/** `wall[i]` / `corner[i]` per element of `loops` (index across all loops), in element order. */
function elementRoles(table: Table, loops: readonly Loop[]): number[] {
  const out: number[] = []
  for (const l of loops) for (const e of l.elements) out.push(table.add(roleOf(e, out.length)))
  return out
}

function emptyShape(op: { id: string }): AppResult<never> {
  return fail('geometry.evaluation', `${op.id}: the shape has no area`, {
    issues: [{ path: ['shape'], rule: 'shapeEmpty', message: 'the shape has no area', params: {} }],
    where: 'shapeSolids',
  })
}

const regionOf = (loop: Loop): Region => ({ pieces: [{ outer: loop, holes: [] }] })

/** A prism of `region` flattened as `sense` says. */
function prism(
  region: Region,
  sense: FlattenSense,
  top: number,
  bottom: number,
  labels: PrismLabels,
  ctx: ShapeSolidsContext,
): AppResult<LabelledMesh> {
  return prismMesh(flattenRegion(region, sense), top, bottom, labels, ctx.triangulate)
}

/**
 * A pocket of a general region: the prism of the region (holes are islands at full height) from
 * `ov` above the stock face down to the floor; no floor fillet (`floorRadiusShape`, Q16).
 */
export function shapePocket(op: Pocket, ctx: ShapeSolidsContext): AppResult<LocalSolids> {
  const table = new Table()
  const floor = table.add('floor')
  const { region } = pocketRegion(op)
  if (region.pieces.length === 0) return emptyShape(op)
  const roles = elementRoles(table, regionLoops(region))
  const zf = op.onZ - op.depth
  return prism(
    region,
    'shrink',
    OVERSHOOT,
    zf,
    { wall: (i) => roles[i]!, top: AIR, bottom: floor },
    ctx,
  ).map((mesh) => localSolids(op.id, table, { removal: [{ mesh, at: ORIGIN }] }))
}

/**
 * A profile on a general loop or open path (or a v0.1 contour that only the general builders
 * take: `on`, blind, tab positions):
 * - `outside`: removal = the loop grown by `slotWidth` (walls `offcut`), cut = the loop
 *   (circumscribed, walls by element);
 * - `inside`: removal = the loop (walls by element), cut = the loop shrunk by `slotWidth`
 *   (`offcut`); none when that is empty (the slot covers the opening: no tabs);
 * - `on`: removal = the band `slotWidth / 2` both sides of the loop (`offset` both ways) or path
 *   (`offsetPath`, round ends), walls labelled by the nearest element of the loop or path; a
 *   blind groove ends at `depth` below the stock face with a `floor`.
 * Tabs (closed loops cut through only) are retained offset bands across the slot.
 */
export function shapeProfile(
  op: Profile,
  stock: StockGeometry,
  ctx: ShapeSolidsContext,
): AppResult<LocalSolids> {
  const port = ctx.region2d
  const { chain, closed } = profileChain(op)
  if (chain.elements.length === 0) return emptyShape(op)
  const table = new Table()
  const s = op.slotWidth
  const T = stock.thickness
  const blind = op.side === 'on' && op.depth !== undefined
  const offcut = op.side === 'on' ? AIR : table.add('offcut')
  const floor = blind ? table.add('floor') : AIR
  const roles = elementRoles(table, [chain])
  const shape = regionOf(chain)
  // removal: ov above the face down through (−T − ov) or to the blind floor
  const top = OVERSHOOT
  const bottom = blind ? -op.depth! : -T - OVERSHOOT
  const n = chain.elements.length
  // the slot as one ring region: its loops from the shape take the elements' roles, the others
  // are `offcut`. Flattened `shrink`, the shape side (a reversed hole for `outside`) comes out
  // circumscribed and the offcut side inscribed, as removal − kept side would; one prism instead
  // of a 3D boolean of two full-area prisms
  const ring = (region: Region, shapeAt: number, reversed: boolean): AppResult<LabelledMesh> => {
    const wall = (i: number): number => {
      const j = i - shapeAt
      if (j < 0 || j >= n) return offcut
      return roles[reversed ? n - 1 - j : j]!
    }
    return prism(region, 'shrink', top, bottom, { wall, top: AIR, bottom: AIR }, ctx)
  }

  let removal: AppResult<LabelledMesh>
  let covers = false
  switch (op.side) {
    case 'outside': {
      // the grown loop, its holes (voids the growth closed in), then the shape reversed
      const grown = port.offset(shape, -s)
      if (grown.isErr()) return Err(grown.unwrapErr())
      const pieces = grown.unwrap().pieces
      const p = pieces[0]
      if (pieces.length !== 1 || p === undefined) {
        const message = `profile ${op.id}: the grown loop is ${pieces.length} pieces`
        return fail('internal.unexpected', message, { where: 'shapeProfile' })
      }
      const shapeAt = [p.outer, ...p.holes].reduce((k, l) => k + l.elements.length, 0)
      const region = { pieces: [{ outer: p.outer, holes: [...p.holes, reverseLoop(chain)] }] }
      removal = ring(region, shapeAt, true)
      break
    }
    case 'inside': {
      const inset = port.offset(shape, s)
      if (inset.isErr()) return Err(inset.unwrapErr())
      const pieces = inset.unwrap().pieces
      covers = pieces.length === 0
      // the shape, the inset's loops reversed as holes (the slug)
      const holes = pieces.flatMap((q) => [reverseLoop(q.outer), ...q.holes.map(reverseLoop)])
      removal = ring({ pieces: [{ outer: chain, holes }] }, 0, false)
      break
    }
    case 'on': {
      const band = closed
        ? port
            .offset(shape, -s / 2)
            .andThen((g) => port.offset(shape, s / 2).andThen((i) => port.difference(g, i)))
        : port.offsetPath(chain, s / 2)
      removal = band.andThen((b) => {
        const labelOf = nearestElementLabels(b, chain, roles, s)
        return prism(b, 'shrink', top, bottom, { wall: labelOf, top: AIR, bottom: floor }, ctx)
      })
      break
    }
  }
  if (removal.isErr()) return Err(removal.unwrapErr())

  const retained: LocalMesh[] = []
  const nominal: LocalNominal<never>[] = []
  if (closed && !blind && !covers) {
    const stretches = [...tabStretches(op)].sort((a, b) => a.from - b.from)
    const slots = stretches.length > 0 ? tabSlots(op, chain, port) : undefined
    if (slots?.isErr()) return Err(slots.unwrapErr())
    for (const [i, stretch] of stretches.entries()) {
      const tab = shapeTab(op, chain, stretch, i, T, table, slots!.unwrap(), ctx)
      if (tab.isErr()) return Err(tab.unwrapErr().withContext('tab', { index: i }))
      retained.push({ mesh: tab.unwrap().band, at: ORIGIN })
      nominal.push({
        region: `tab[${i}]`,
        parameter: 'tabs',
        mesh: { mesh: tab.unwrap().nominal, at: ORIGIN },
        minusRemoval: false,
      })
    }
  }
  return Ok(
    localSolids(op.id, table, {
      removal: [{ mesh: removal.unwrap(), at: ORIGIN }],
      cut: [],
      retained,
      nominal,
    }),
  )
}

/**
 * Wall labels of an `on` groove's band: each band element takes the role of the element of the
 * centre loop or path nearest to its midpoint (a grid over the centre elements' boxes keeps it
 * near-linear). Returns the label of band element `i` (index across the band's loops).
 */
function nearestElementLabels(
  band: Region,
  centre: Loop,
  roles: readonly number[],
  slotWidth: number,
): (i: number) => number {
  const els = centre.elements
  const reach = slotWidth / 2 + 0.1
  const boxes = els.map((e) => chainBounds([e])!)
  const all = chainBounds(els)!
  const cell = Math.max(slotWidth, 1)
  const cols = Math.max(1, Math.ceil((all.max[0] - all.min[0] + 2 * reach) / cell))
  const rows = Math.max(1, Math.ceil((all.max[1] - all.min[1] + 2 * reach) / cell))
  const cellOf = (x: number, y: number): [number, number] => [
    Math.min(cols - 1, Math.max(0, Math.floor((x - all.min[0] + reach) / cell))),
    Math.min(rows - 1, Math.max(0, Math.floor((y - all.min[1] + reach) / cell))),
  ]
  const grid = new Map<number, number[]>()
  boxes.forEach((b: Bounds2, k) => {
    const [c0, r0] = cellOf(b.min[0] - reach, b.min[1] - reach)
    const [c1, r1] = cellOf(b.max[0] + reach, b.max[1] + reach)
    for (let c = c0; c <= c1; c++)
      for (let r = r0; r <= r1; r++) {
        const key = r * cols + c
        const list = grid.get(key)
        if (list === undefined) grid.set(key, [k])
        else list.push(k)
      }
  })
  const nearest = (p: Vec2): number => {
    const [c, r] = cellOf(p[0], p[1])
    const candidates = grid.get(r * cols + c) ?? els.map((_, k) => k)
    let best = 0
    let bestD = Infinity
    for (const k of candidates) {
      const q = elementClosest(els[k]!, p)
      const d = Math.hypot(p[0] - q[0], p[1] - q[1])
      if (d < bestD) {
        bestD = d
        best = k
      }
    }
    return best
  }
  const labels = regionLoops(band).flatMap((l) =>
    l.elements.map((e) => roles[nearest(elementPointAt(e, 0.5).point)]!),
  )
  return (i) => labels[i] ?? AIR
}

/** Offsets (inward > 0) the slot spans: exactly, and with the tab's overshoot on both sides. */
function slotOffsets(op: Profile): { exact: [number, number]; grown: [number, number] } {
  const s = op.slotWidth
  const ov = OVERSHOOT
  switch (op.side) {
    case 'outside':
      return { exact: [-s, 0], grown: [-s - ov, ov] }
    case 'inside':
      return { exact: [0, s], grown: [-ov, s + ov] }
    case 'on':
      return { exact: [-s / 2, s / 2], grown: [-s / 2 - ov, s / 2 + ov] }
  }
}

/**
 * One tab on a general loop (docs/architecture/shapes.md#implementation-g1): the band T2's
 * toolpaths leave (`generalTabBands` of tab-bands.ts: per element of the stretch a quad or an
 * annular sector across the given offsets, end faces on the loop normals, sectors at the outer
 * side of corners; not bent on the medial axis), its pieces united by the 2D port and clipped to
 * the slot between true offsets of the loop. `band`: across
 * the slot plus `ov` on both sides, from below the stock bottom to the tab top (labels
 * `tab[i].top`, `tab[i].end[0|1]`, else `air`); `nominal`: exactly across the slot from the stock
 * bottom (all `air`).
 */
/** The slot between true offsets of the loop, exact and grown by `ov` across (one per profile). */
interface TabSlots {
  readonly exact: Region
  readonly grown: Region
}

function tabSlots(op: Profile, loop: Loop, port: Region2dPort): AppResult<TabSlots> {
  const shape = regionOf(loop)
  const { exact, grown } = slotOffsets(op)
  const offset = (d: number): AppResult<Region> => (d === 0 ? Ok(shape) : port.offset(shape, d))
  const slotOf = ([lo, hi]: [number, number]): AppResult<Region> =>
    offset(lo).andThen((o) => offset(hi).andThen((i) => port.difference(o, i)))
  return slotOf(exact).andThen((e) => slotOf(grown).map((g) => ({ exact: e, grown: g })))
}

function shapeTab(
  op: Profile,
  loop: Loop,
  stretch: { readonly from: number; readonly to: number },
  index: number,
  T: number,
  table: Table,
  slots: TabSlots,
  ctx: ShapeSolidsContext,
): AppResult<{ band: LabelledMesh; nominal: LabelledMesh }> {
  const port = ctx.region2d
  const { exact, grown } = slotOffsets(op)
  const p0 = chainPointAt(loop, stretch.from, true)
  const p1 = chainPointAt(loop, stretch.to, true)
  if (p0.isErr()) return Err(p0.unwrapErr())
  if (p1.isErr()) return Err(p1.unwrapErr())
  const start = p0.unwrap()
  const end = p1.unwrap()
  const centre = (stretch.from + stretch.to) / 2
  const width = stretch.to - stretch.from
  // the band, clipped to the slot between true offsets: near a corner the band's side reaches
  // past the slot, into material the slot never cut
  const bandOf = (range: [number, number], slot: Region): AppResult<Region> =>
    port
      .normalise(generalTabBands(loop, [centre], width, range[0], range[1])[0]!.map((p) => p.loop))
      .andThen((band) => port.intersect(band, slot))
  const bandRegion = bandOf(grown, slots.grown)
  const exactRegion = bandOf(exact, slots.exact)
  if (bandRegion.isErr()) return Err(bandRegion.unwrapErr())
  if (exactRegion.isErr()) return Err(exactRegion.unwrapErr())
  // the exact slot where the band is: on the band's boundary, inside it ⇔ inside the slot, and
  // tested against a few elements instead of the whole slot's (`regionContains` is linear in
  // them, once per band chord)
  const local = port.intersect(bandRegion.unwrap(), slots.exact)
  if (local.isErr()) return Err(local.unwrapErr())
  const slot = local.unwrap()

  const topFace = table.add(`tab[${index}].top`)
  const ends = [table.add(`tab[${index}].end[0]`), table.add(`tab[${index}].end[1]`)] as const
  // a wall chord on the normal line through a stretch end is that end face (the nearer end when
  // both lines hold it); bends count as end faces (docs/architecture/geometry.md)
  const offLine = (f: { point: Vec2; tangent: Vec2 }, q: Vec2): number =>
    Math.abs((q[0] - f.point[0]) * f.tangent[0] + (q[1] - f.point[1]) * f.tangent[1])
  const tol = 1e-4
  const wall = (_: number, a: Vec2, b: Vec2): number => {
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const dist = (f: { point: Vec2 }) => Math.hypot(mid[0] - f.point[0], mid[1] - f.point[1])
    const hits = [0, 1].filter((k) => {
      const f = k === 0 ? start : end
      return offLine(f, a) <= tol && offLine(f, b) <= tol
    })
    // off both normal lines: a bend of the band inside the slot (where its pieces meet at a
    // corner) belongs to the nearer end face; outside the slot it is air
    if (hits.length === 0)
      return regionContains(slot, mid) ? ends[dist(start) <= dist(end) ? 0 : 1] : AIR
    const k = hits.length === 1 || dist(start) <= dist(end) ? hits[0]! : hits[1]!
    return ends[k]!
  }
  const tabTop = -T + op.tabs.thickness
  const band = prism(
    bandRegion.unwrap(),
    'shrink',
    tabTop,
    -T - 2 * OVERSHOOT,
    { wall, top: topFace, bottom: AIR },
    ctx,
  )
  const nominal = prism(
    exactRegion.unwrap(),
    'shrink',
    tabTop,
    -T,
    { wall: () => AIR, top: AIR, bottom: AIR },
    ctx,
  )
  return band.andThen((m) => nominal.map((n) => ({ band: m, nominal: n })))
}

/** Chords one evaluation builds within its 50 ms budget (spike S3, D29); `dfm.shapeHeavy` above. */
export const SHAPE_CHORD_BUDGET = 3000

/**
 * Chords of a shape's own loops or path at the chord tolerance: the evaluation cost measure of
 * `dfm.shapeHeavy` (docs/modes/design-v0.3.md#dfm-checks-for-shapes; ≈ 3 000 chords per 50 ms).
 */
export function outlineChords(outline: Outline): number {
  if (outline.kind === 'path') return flattenLoop(outline.path, 'shrink').points.length
  return chordCount(flattenRegion(outline.region, 'shrink'))
}

/** Chords of a pocket's or profile's shape (`outlineChords` of its placed outline). */
export const shapeChords = (op: Pocket | Profile): number => outlineChords(shapeOutline(op.shape))
