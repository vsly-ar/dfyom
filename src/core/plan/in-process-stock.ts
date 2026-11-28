/**
 * The in-process stock display (hardening DF135, cut-state slice C5): the material left after a
 * plan's already-cut operations, for the Plan and Run viewports. The removal is the simulated cut
 * (`simulateHeightmap`, deviation.md's cut map) of the cut operations' own toolpaths, in machining
 * order over every setup; the surface is drawn from the ±z maps as a closed height-field solid in
 * the part frame. Pure and headless: the renderer runs it on the toolpaths it already reads.
 * Doc: docs/modes/cut-state.md#in-process-stock-display-c5
 */
import type { StockSize } from '../geometry/face'
import { faceToFace } from '../geometry/face'
import { chainBounds, type Region } from '../geometry/2d/model'
import { regionContains } from '../geometry/2d/measure'
import type { Region2dPort } from '../geometry/2d/port'
import type { StockGeometry, Vec2 } from '../geometry/model'
import { pocketRegion } from '../geometry/outline'
import { holeRegion, isOpening, openingRegion, slotRegion } from '../geometry/through-depth'
import { recutUnits } from '../design/already-cut'
import type { Toolpath } from '../toolpath/model'
import { toolpathTool } from '../toolpath/inputs'
import {
  SIMULATE_CELL,
  type CutMap,
  type SimulateInput,
  type SimulateSetup,
} from '../toolpath/simulate'
import { setupAlignment } from './alignment'
import { asCutRemovals } from './as-cut'
import { cutTest } from './cut'
import type { LoadedPlan } from './plan'
import type { SetupDTO } from './plan.dto'
import { setupDirection, setupRotation } from './setups'

/** Most cells of the display map (per direction): the cell grows past 0.5 mm above it. */
export const IN_PROCESS_CELLS_MAX = 150_000

/** A cut operation's toolpath as the window read it (`plan.toolpath.get`). */
export interface CutToolpathEntry {
  readonly toolpath: Toolpath | null
  readonly stale: boolean
}

/** What the display can draw for a plan right now. */
export type InProcessStockInput =
  /** No operation of the plan is already cut: the stock is the raw blank. */
  | { readonly kind: 'none' }
  /** A cut operation has no toolpath yet: nothing is drawn until it is generated. */
  | { readonly kind: 'waiting'; readonly missing: readonly string[] }
  | {
      readonly kind: 'ready'
      readonly simulate: SimulateInput
      /** The cut plan operations, in machining order. */
      readonly operations: readonly string[]
      /** C4 follow-up: the recut units' as-cut removals, stamped into the maps (`stampAsCut`). */
      readonly stamps: readonly AsCutStamp[]
      /** The recut units the stamps belong to. */
      readonly recut: readonly string[]
      /** Some cut operation is in a side setup (±x, ±y): its removal is not drawn. */
      readonly sides: boolean
      /** Some cut toolpath is stale (drawn as last generated, as Plan draws outdated toolpaths). */
      readonly outdated: boolean
      /** Equal keys give equal maps (the window's cache). */
      readonly key: string
    }

/** The display cell (mm): 0.5 mm, coarser so a map stays within `IN_PROCESS_CELLS_MAX`. */
export function inProcessCell(stock: StockSize): number {
  const fit = Math.sqrt((stock.length * stock.width) / IN_PROCESS_CELLS_MAX)
  return Math.max(SIMULATE_CELL, Math.ceil(fit * 20) / 20)
}

/**
 * The simulated cut's input for the plan's in-process stock: the toolpaths of its already-cut
 * operations (the plan's design copy, `cutTest`) per setup in machining order, in the setups'
 * WCS. `toolpathOf` reads the window's toolpaths; `zeroOf` the setup's work zero as the window
 * knows it (default: `setupAlignment`'s, without the 2D port).
 */
export function inProcessStockInput(
  plan: LoadedPlan,
  toolpathOf: (planOperationId: string) => CutToolpathEntry | undefined,
  zeroOf?: (setup: SetupDTO) => Vec2,
  stamps: readonly AsCutStamp[] = [],
): InProcessStockInput {
  const isCut = cutTest(plan.dto.design.part)
  const stock: StockSize = {
    length: plan.stock.length.canonical,
    width: plan.stock.width.canonical,
    thickness: plan.stock.thickness.canonical,
  }
  const setups: SimulateSetup[] = []
  const operations: string[] = []
  const missing: string[] = []
  const keys: string[] = []
  let outdated = false
  for (const setup of plan.setups) {
    const cut = setup.operations.filter(isCut)
    if (cut.length === 0) continue
    const zero = zeroOf?.(setup) ?? setupAlignment(plan, setup).zero
    const direction = setupDirection(setup)
    const rotation = setupRotation(setup)
    const toolpaths: SimulateSetup['toolpaths'][number][] = []
    for (const op of cut) {
      operations.push(op.id)
      const entry = toolpathOf(op.id)
      const tp = entry?.toolpath ?? null
      if (entry?.stale === true) outdated = true
      const toolId = op.tool ?? tp?.tool
      const tool = toolId === undefined ? undefined : plan.tools.get(toolId)
      if (tp === null || tool === undefined || toolId === undefined) {
        missing.push(op.id)
        continue
      }
      toolpaths.push({ tool: toolpathTool(tool, toolId), toolpath: tp })
      keys.push(`${op.id}:${toolId}:${toolpathSignature(tp)}`)
    }
    setups.push({ direction, rotation, zero, toolpaths })
    keys.push(`${setup.id}:${direction}:${rotation}:${zero[0]},${zero[1]}`)
  }
  if (operations.length === 0 && stamps.length === 0) return { kind: 'none' }
  if (missing.length > 0) return { kind: 'waiting', missing }
  // a stamp's face needs its map even with no cut toolpath there
  for (const st of stamps)
    if (!setups.some((s) => s.direction === st.direction))
      setups.push({ direction: st.direction, rotation: 0, zero: [0, 0], toolpaths: [] })
  if (stamps.length > 0) keys.push(`asCut:${JSON.stringify(stamps)}`)
  const cell = inProcessCell(stock)
  return {
    kind: 'ready',
    simulate: { stock, cell, setups },
    operations,
    stamps,
    recut: [...new Set(stamps.map((st) => st.unit))],
    sides: setups.some((s) => s.direction !== '+z' && s.direction !== '-z'),
    outdated,
    key: [plan.dto.id, stock.length, stock.width, stock.thickness, cell, ...keys].join('|'),
  }
}

/**
 * A recut unit's as-cut removal as the display draws it (DF135 C4 follow-up): a region of a ±z
 * face (its face frame) or the whole face, lowered to `floor` (z in that frame, ≤ 0).
 */
export interface AsCutStamp {
  readonly unit: string
  readonly direction: '+z' | '-z'
  readonly region: Region | 'face'
  readonly floor: number
}

/**
 * The stamps of the plan's recut units (DF135 C4 follow-up): the regions C4 counts as removed
 * (`asCutRemovals`) – a facing's face, a pocket's region inset by its floor fillet, a blind
 * profile's slot, a blind hole's disc, an opening's interior through – each to its floor. As-cut
 * chamfers and Lines have no region (their material shows as still there, the safe side); side
 * faces have no map. Empty without the 2D port or recut units.
 * Doc: docs/modes/cut-state.md#in-process-stock-display-c5
 */
export function asCutStamps(plan: LoadedPlan, port: Region2dPort | undefined): AsCutStamp[] {
  if (port === undefined || recutUnits(plan.dto.design.part).size === 0) return []
  const stock: StockGeometry = {
    length: plan.stock.length.canonical,
    width: plan.stock.width.canonical,
    thickness: plan.stock.thickness.canonical,
  }
  const out: AsCutStamp[] = []
  for (const { geometry: g, unit } of asCutRemovals(plan, port)) {
    const direction = g.direction ?? '+z'
    if (direction !== '+z' && direction !== '-z') continue
    const add = (region: Region | 'face' | undefined, floor: number) => {
      if (region !== undefined && floor < 0) out.push({ unit, direction, region, floor })
    }
    if (g.kind === 'facing') add('face', -g.depth)
    else if (g.kind === 'pocket' && g.roughing !== true) {
      const r = pocketRegion(g).region
      add(
        g.floorRadius > 0 ? port.offset(r, g.floorRadius).mapOr(undefined, (x) => x) : r,
        g.onZ - g.depth,
      )
    } else if (g.kind === 'profile' && g.depth !== undefined && g.roughing !== true)
      add(slotRegion(g, stock, port), -g.depth)
    else if (isOpening(g)) add(openingRegion(g, stock, port), -stock.thickness)
    else if (g.kind === 'drilling' && g.bottom.kind !== 'through')
      add(holeRegion(g, stock, port), g.onZ - g.bottom.depth)
  }
  return out
}

/**
 * `maps` with every stamp lowered in (a cell whose centre lies in the stamp's region goes down to
 * its floor, never below the stock's other face; a stamp only lowers). Maps are copied.
 */
export function stampAsCut(
  maps: readonly CutMap[],
  stamps: readonly AsCutStamp[],
  stock: StockSize,
): CutMap[] {
  if (stamps.length === 0) return [...maps]
  return maps.map((m) => {
    const own = stamps.filter((st) => st.direction === m.direction)
    if (own.length === 0) return m
    const h = Float32Array.from(m.h)
    const c = m.cell
    for (const st of own) {
      const floor = Math.max(-stock.thickness, st.floor)
      let i0 = 0
      let i1 = m.nu - 1
      let j0 = 0
      let j1 = m.nv - 1
      if (st.region !== 'face') {
        const lo: [number, number] = [Infinity, Infinity]
        const hi: [number, number] = [-Infinity, -Infinity]
        for (const p of st.region.pieces) {
          const b = chainBounds(p.outer.elements)
          if (b === undefined) continue
          lo[0] = Math.min(lo[0], b.min[0])
          lo[1] = Math.min(lo[1], b.min[1])
          hi[0] = Math.max(hi[0], b.max[0])
          hi[1] = Math.max(hi[1], b.max[1])
        }
        if (!(lo[0] <= hi[0] && lo[1] <= hi[1])) continue
        i0 = Math.max(0, Math.floor(lo[0] / c - 0.5))
        i1 = Math.min(m.nu - 1, Math.ceil(hi[0] / c - 0.5))
        j0 = Math.max(0, Math.floor(lo[1] / c - 0.5))
        j1 = Math.min(m.nv - 1, Math.ceil(hi[1] / c - 0.5))
      }
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const k = j * m.nu + i
          if (h[k]! <= floor) continue
          if (st.region !== 'face' && !regionContains(st.region, [(i + 0.5) * c, (j + 0.5) * c]))
            continue
          h[k] = floor
        }
    }
    return { ...m, h }
  })
}

/** A cheap identity of a toolpath's moves (counts, lengths and time at full precision). */
function toolpathSignature(tp: Toolpath): string {
  let moves = 0
  for (const p of tp.passes) moves += p.moves.length
  const s = tp.stats
  return `${tp.passes.length}/${moves}/${s.cutLength}/${s.rapidLength}/${s.estimatedSeconds}`
}

/** The in-process stock as a triangle mesh in the part frame (mm). */
export interface InProcessStockMesh {
  /** xyz per vertex. */
  readonly positions: Float32Array
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  readonly indices: Uint32Array
}

const EMPTY = 1e-3

/**
 * The solid the ±z cut maps leave: per cell the material from the bottom map's top (part frame,
 * the raw bottom without one) up to the top map's (the raw top without one); a column with none
 * left is empty. Vertices sit at the cell centres (the outermost on the stock's sides), so the top
 * and bottom surfaces are smooth height fields joined by four side walls; an empty column drops
 * its triangles (a through cut has no inner wall). Maps of side directions are ignored.
 */
export function inProcessStockMesh(maps: readonly CutMap[], stock: StockSize): InProcessStockMesh {
  const top = maps.find((m) => m.direction === '+z')
  const bottom = maps.find((m) => m.direction === '-z')
  const cell = top?.cell ?? bottom?.cell ?? SIMULATE_CELL
  const { length: L, width: W, thickness: T } = stock
  const nu = Math.max(2, Math.ceil(L / cell - 1e-9))
  const nv = Math.max(2, Math.ceil(W / cell - 1e-9))
  const xs = axis(nu, cell, L)
  const ys = axis(nv, cell, W)
  const n = nu * nv
  const zTop = new Float64Array(n)
  const zBottom = new Float64Array(n).fill(-T)
  if (top !== undefined)
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) zTop[j * nu + i] = read(top, i, j)
  if (bottom !== undefined) {
    // the bottom face frame is mirrored: read each column where the bottom map holds it
    const { m, t } = faceToFace('+z', '-z', stock)
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const x = xs[i]!
        const y = ys[j]!
        const u = m[0][0] * x + m[0][1] * y + t[0]
        const v = m[1][0] * x + m[1][1] * y + t[1]
        const bi = Math.min(bottom.nu - 1, Math.max(0, Math.floor(u / bottom.cell)))
        const bj = Math.min(bottom.nv - 1, Math.max(0, Math.floor(v / bottom.cell)))
        zBottom[j * nu + i] = -T - bottom.h[bj * bottom.nu + bi]!
      }
  }
  const filled = new Uint8Array(n)
  for (let k = 0; k < n; k++) filled[k] = zTop[k]! - zBottom[k]! > EMPTY ? 1 : 0
  const positions = new Float32Array(2 * n * 3)
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const k = j * nu + i
      positions.set([xs[i]!, ys[j]!, zTop[k]!], 3 * k)
      positions.set([xs[i]!, ys[j]!, zBottom[k]!], 3 * (n + k))
    }
  const tris: number[] = []
  const at = (i: number, j: number) => j * nu + i
  for (let j = 0; j + 1 < nv; j++)
    for (let i = 0; i + 1 < nu; i++) {
      const a = at(i, j)
      const b = at(i + 1, j)
      const c = at(i + 1, j + 1)
      const d = at(i, j + 1)
      if (!(filled[a] && filled[b] && filled[c] && filled[d])) continue
      tris.push(a, b, c, a, c, d) // top, seen from +z
      tris.push(n + a, n + c, n + b, n + a, n + d, n + c) // bottom, seen from −z
    }
  // the side walls, walking the border counter-clockwise seen from +z (outside on the right)
  const border: number[] = []
  for (let i = 0; i < nu; i++) border.push(at(i, 0))
  for (let j = 1; j < nv; j++) border.push(at(nu - 1, j))
  for (let i = nu - 2; i >= 0; i--) border.push(at(i, nv - 1))
  for (let j = nv - 2; j >= 0; j--) border.push(at(0, j))
  for (let s = 0; s + 1 < border.length; s++) {
    const a = border[s]!
    const b = border[s + 1]!
    if (!(filled[a] && filled[b])) continue
    tris.push(a, n + a, n + b, a, n + b, b)
  }
  return { positions, indices: Uint32Array.from(tris) }
}

/** Vertex coordinates along an axis: cell centres, the first and last on the stock's sides. */
function axis(count: number, cell: number, size: number): Float64Array {
  const out = new Float64Array(count)
  for (let i = 0; i < count; i++) out[i] = Math.min(size, (i + 0.5) * cell)
  out[0] = 0
  out[count - 1] = size
  return out
}

/** The top map's material top at display cell (i, j) (the same grid as the `+z` map). */
function read(map: CutMap, i: number, j: number): number {
  return map.h[Math.min(map.nv - 1, j) * map.nu + Math.min(map.nu - 1, i)]!
}

/** The volume a closed, outward-wound mesh encloses (mm³; the divergence theorem). Pure. */
export function meshVolume(mesh: InProcessStockMesh): number {
  const p = mesh.positions
  let v = 0
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = 3 * mesh.indices[t]!
    const b = 3 * mesh.indices[t + 1]!
    const c = 3 * mesh.indices[t + 2]!
    v +=
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
      p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
      p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)
  }
  return v / 6
}
