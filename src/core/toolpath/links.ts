/**
 * Safe links between operations (hardening DF64, phase L1): a post-pass over a setup's ordered,
 * current toolpaths that replaces the climb to the clearance height between two toolpaths of
 * one tool run (no pause between them) by the lowest safe level over the in-process stock and
 * the clamps, and checks every link it writes against the field (the export guard). Pure,
 * deterministic, headless. Doc: docs/modes/safe-links.md
 */
import type { Move, Pass, Toolpath, ToolpathTool, Vec3 } from './model'
import { STOCK_CELL, StockHeights, type FieldExtent } from './stock-heights'
import { moveEnd } from './stats'

/** Retraction policy between operations (setup field `retraction`, default `minimum`). */
export const RETRACTIONS = ['minimum', 'full'] as const
export type Retraction = (typeof RETRACTIONS)[number]

/** Radial margin of a link's corridor beyond the tool's radius (mm). */
export const LINK_RADIAL_MARGIN = 1
/** Link levels are rounded up to this (mm): stable goldens. */
export const LINK_LEVEL_STEP = 0.1

const EPS = 1e-9
/** The guard's slack for float noise (mm). */
const GUARD_SLACK = 1e-6

/** One toolpath of the setup in machining order, with what links need to know about it. */
export interface LinkOperation {
  readonly toolpath: Toolpath
  readonly tool: ToolpathTool
  /** The tool's stickout (mm): the cleared footprint counts only up to the tip + stickout. */
  readonly stickout?: number
  /** A tool change or another `M0` comes before it: it is entered from the clearance height. */
  readonly pauseBefore: boolean
  /**
   * The tool's own holder (DF132 H6, a library tool's override); absent = the setup's
   * `LinkSettings.holder` (the machine's).
   */
  readonly holder?: LinkHolder
  /**
   * Already cut (DF135, docs/modes/cut-state.md): not in the program, so never linked into or
   * out of; its removal still lowers the field for the operations after it.
   */
  readonly cut?: boolean
}

/** What the links read of the setup's workholding (`WorkholdingObstacles` in plan/workholding). */
export interface LinkObstacles {
  /** mm `floorAlong` keeps around every item, sideways and above (the workholding margin). */
  readonly margin: number
  /** The lowest safe Z over the items for a tool of `radius` along a→b (XY); −∞ when none is near. */
  floorAlong(a: readonly [number, number], b: readonly [number, number], radius: number): number
}

/**
 * The machine's tool holder over the links (hardening DF132 H4, docs/modes/tool-holder.md#travel-links-at-clearance):
 * the collet nut from the nose up `nutLength`, the spindle body above it to infinity (mm).
 */
export interface LinkHolder {
  readonly nutDiameter: number
  readonly nutLength: number
  readonly bodyDiameter: number
  /**
   * How far the nut and body stay above an item's top on a link (mm): the workholding margin, at
   * least the minimum stickout's 5 mm (`STICKOUT_CLEARANCE`), so a link the floor raised never
   * asks for a longer stickout in the read-out (tool-holder.md § Implementation (H4)).
   */
  readonly above: number
}

/**
 * The holder floor (DF132 H4): the lowest tip Z at which the nut and the body of a tool with
 * `stickout` pass every item near a→b. For each part, where the corridor grown by its radius
 * (+ the margin) meets an item: item top + `above` − the part's height above the tip. −∞ without
 * a holder, items or a stickout (today's links).
 */
export function holderFloor(
  obstacles: LinkObstacles | undefined,
  holder: LinkHolder | undefined,
  a: readonly [number, number],
  b: readonly [number, number],
  stickout: number | undefined,
): number {
  if (obstacles === undefined || holder === undefined || stickout === undefined) return -Infinity
  // floorAlong is the item's top + margin: swap the margin for `above`
  const lift = holder.above - obstacles.margin
  const nut = obstacles.floorAlong(a, b, holder.nutDiameter / 2) + lift - stickout
  const body =
    obstacles.floorAlong(a, b, holder.bodyDiameter / 2) + lift - stickout - holder.nutLength
  return Math.max(nut, body)
}

/** The floor outside the cleared footprint: none with modelled items, else the clamp height. */
const clampOf = (s: LinkSettings): number =>
  s.obstacles !== undefined ? -Infinity : (s.clampHeight ?? Infinity)

/**
 * The tool of a link: its radius, and the holder and stickout of each of the two operations it
 * joins (the holder floor keeps both above the items, H6; a stickout absent = no floor for it).
 */
interface LinkTool {
  readonly radius: number
  readonly holders: readonly {
    readonly holder: LinkHolder | undefined
    readonly stickout: number | undefined
  }[]
}

/**
 * The corridor's need: the field and clamps (`corridorFloor`), the modelled items and the
 * holder floor over them (DF132 H4).
 */
function linkFloor(
  f: StockHeights,
  a: Vec3,
  b: Vec3,
  tool: LinkTool,
  s: LinkSettings,
  clamp = clampOf(s),
): number {
  const need = corridorFloor(f, a, b, tool.radius, s.margin, clamp)
  // the items are in the setup frame, the moves in the WCS: add a moved zero back (alignment S12)
  const [zx, zy] = s.zero ?? [0, 0]
  const sa: [number, number] = [a[0] + zx, a[1] + zy]
  const sb: [number, number] = [b[0] + zx, b[1] + zy]
  const items = s.obstacles?.floorAlong(sa, sb, tool.radius) ?? -Infinity
  const holders = tool.holders.map((h) => holderFloor(s.obstacles, h.holder, sa, sb, h.stickout))
  return Math.max(need, items, ...holders)
}

export interface LinkSettings {
  readonly retraction: Retraction
  /** The setup's clearance height above the stock top (mm). */
  readonly clearance: number
  /** Vertical margin: the setup's retract height (mm). */
  readonly margin: number
  /** How far clamps rise above the stock top (mm); absent = unknown. Ignored with `obstacles`. */
  readonly clampHeight?: number
  /**
   * The setup's modelled workholding (docs/modes/workholding.md#obstacle-interface-for-df64s-link-pass):
   * when present the clamps are known, every link stays at or above `floorAlong` of its across
   * segment, and `clampHeight` is ignored. Its data (prisms, margin) is part of the cache key.
   */
  readonly obstacles?: LinkObstacles
  /**
   * The machine's tool holder (DF132 H4): with `obstacles`, every link also keeps the nut and the
   * body above the items (`holderFloor`). Absent = the tool alone (today's links).
   */
  readonly holder?: LinkHolder
  /** The stock as it sits in the setup: X, Y extents and thickness (mm). */
  readonly stock: Vec3
  /** The machine's max rate per axis (mm/min), for the link times; absent = not timed. */
  readonly rates?: Vec3
  /**
   * The work zero in the setup frame (mm; alignment DF78): the toolpaths are in the WCS, shifted
   * by it, so the stock sits at `−zero` and the obstacles are read at `+zero`. Absent = [0, 0].
   */
  readonly zero?: readonly [number, number]
  /** The field's cell size (mm); default `STOCK_CELL` (tests: coarser never lowers a link). */
  readonly cell?: number
}

/** One link from operation `index − 1` into operation `index`. */
export interface Link {
  readonly index: number
  /** The last point of the earlier toolpath below the clearance height. */
  readonly exit: Vec3
  /** Where the later toolpath's first run of vertical rapids ends. */
  readonly entry: Vec3
  /** The crossing level; the clearance height when not lowered. */
  readonly level: number
  /** What the field and the clamps need under the corridor (−∞ none; +∞ unknown clamps). */
  readonly floor: number
  readonly low: boolean
  /** Rapid time at the clearance height and as linked (s, no acceleration; 0 untimed). */
  readonly fullSeconds: number
  readonly seconds: number
  /**
   * At the clearance height only because the corridor leaves the cleared footprint with no clamp
   * height: the time with a clamp height of 0 (s).
   */
  readonly withClampSeconds?: number
  /** How a lowered link rewrites the two toolpaths (low links only). */
  readonly edit?: LinkEdit
}

/**
 * A lowered link as moves (safe-links.md#where-it-runs): the earlier toolpath's last move (its
 * rapid up to the clearance height) becomes `tail` (up to the level, across), the later
 * toolpath's first `trim` moves (its approach from the clearance height) become `head` (down to
 * the entry). Every point is a rapid's end, in the toolpaths' frame.
 */
export interface LinkEdit {
  readonly trim: number
  readonly tail: readonly Vec3[]
  readonly head: readonly Vec3[]
}

/** A link rapid that passes lower than the field allows (a bug; it blocks the export). */
export interface LinkCollision {
  readonly index: number
  readonly from: Vec3
  readonly to: Vec3
  /** The lowest safe Z for that rapid. */
  readonly needed: number
}

export interface LinksSummary {
  /** Links between operations of one tool run with no pause. */
  readonly count: number
  /** Lowered below the clearance height. */
  readonly low: number
  readonly atClearance: number
  /** Their rapid time as linked (s). */
  readonly seconds: number
  /** Time saved against the clearance height (s). */
  readonly savedSeconds: number
}

export interface SetupLinks {
  /** The toolpaths with their links (same objects where nothing changed). */
  readonly toolpaths: readonly Toolpath[]
  readonly links: readonly Link[]
  readonly summary: LinksSummary
  /** Links a clamp height would lower (no clamp height set): count and seconds saved. */
  readonly clampHeightUnknown?: { readonly links: number; readonly savedSeconds: number }
  readonly collisions: readonly LinkCollision[]
}

// ── Toolpath ends ─────────────────────────────────────────────────────────────────────────

const flat = (tp: Toolpath): Move[] => tp.passes.flatMap((p) => p.moves)
const sameXY = (a: Vec3, b: Vec3) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS

/** The exit: the toolpath ends with a vertical rapid up to the clearance height from below it. */
function exitOf(tp: Toolpath, clearance: number): Vec3 | undefined {
  const moves = flat(tp)
  const last = moves.at(-1)
  const before = moves.at(-2)
  if (last?.kind !== 'rapid' || before === undefined) return undefined
  const exit = moveEnd(before)
  if (Math.abs(last.to[2] - clearance) > EPS || !(exit[2] < clearance - EPS)) return undefined
  return sameXY(exit, last.to) ? exit : undefined
}

/**
 * The entry: the toolpath starts with a rapid at the clearance height, then its first run of
 * vertical rapids down; `trim` moves lead to it. The entry is at the clearance height when the
 * toolpath feeds straight down from there.
 */
function entryOf(tp: Toolpath, clearance: number): { entry: Vec3; trim: number } | undefined {
  const moves = flat(tp)
  const first = moves[0]
  if (first?.kind !== 'rapid' || Math.abs(first.to[2] - clearance) > EPS) return undefined
  let entry = first.to
  let k = 1
  for (; k < moves.length; k++) {
    const m = moves[k]!
    if (m.kind !== 'rapid' || !sameXY(m.to, entry) || !(m.to[2] < entry[2])) break
    entry = m.to
  }
  return { entry, trim: k }
}

/** The toolpath without its first `n` moves, `head` in front. */
function withHead(tp: Toolpath, n: number, head: readonly Move[]): Toolpath {
  let left = n
  const passes: Pass[] = tp.passes.map((p) => {
    const drop = Math.min(left, p.moves.length)
    left -= drop
    return drop === 0 ? p : { ...p, moves: p.moves.slice(drop) }
  })
  const k = Math.max(
    0,
    passes.findIndex((p) => p.moves.length > 0),
  )
  const at = passes[k]!
  passes[k] = { ...at, moves: [...head, ...at.moves] }
  return { ...tp, passes }
}

/** The toolpath without its last `n` moves, `tail` after them. */
function withTail(tp: Toolpath, n: number, tail: readonly Move[]): Toolpath {
  let left = n
  const passes: Pass[] = [...tp.passes]
  for (let i = passes.length - 1; i >= 0 && left > 0; i--) {
    const p = passes[i]!
    const drop = Math.min(left, p.moves.length)
    left -= drop
    passes[i] = { ...p, moves: p.moves.slice(0, p.moves.length - drop) }
  }
  let k = passes.length - 1
  while (k > 0 && passes[k]!.moves.length === 0) k--
  const at = passes[k]!
  passes[k] = { ...at, moves: [...at.moves, ...tail] }
  return { ...tp, passes }
}

// ── Timing ────────────────────────────────────────────────────────────────────────────────

/** Rapid time of a polyline at the axes' max rates, no acceleration (as the export stats). */
function rapidSeconds(points: readonly Vec3[], rates: Vec3 | undefined): number {
  if (rates === undefined) return 0
  let s = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    s += Math.max(...[0, 1, 2].map((k) => Math.abs(b[k]! - a[k]!) / rates[k]!)) * 60
  }
  return s
}

// ── Corridor ──────────────────────────────────────────────────────────────────────────────

/**
 * The lowest Z a horizontal rapid of `tool` from `a` to `b` may run at: over the cells within the
 * tool's radius + the radial margin of the path, the material and the clamp floor + the vertical
 * margin; the cells wholly under the tool at either end (its own column) need only the
 * material and the proven clamp floor, without margin. `clamp`: the floor outside the cleared
 * footprint (the clamp height; +∞ unknown). −∞ when nothing is below.
 */
export function corridorFloor(
  f: StockHeights,
  a: Vec3,
  b: Vec3,
  radius: number,
  margin: number,
  clamp: number,
): number {
  const c = f.cell
  const half = c / 2
  const grown = radius + LINK_RADIAL_MARGIN + half * Math.SQRT2
  const g2 = grown * grown
  const r2 = radius * radius
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const ci0 = Math.floor((Math.min(a[0], b[0]) - grown) / c) - f.i0
  const ci1 = Math.floor((Math.max(a[0], b[0]) + grown) / c) - f.i0
  const cj0 = Math.floor((Math.min(a[1], b[1]) - grown) / c) - f.j0
  const cj1 = Math.floor((Math.max(a[1], b[1]) + grown) / c) - f.j0
  // a corridor leaving the field crosses unknown ground: no material, no clamp floor proven
  if (ci0 < 0 || cj0 < 0 || ci1 >= f.nx || cj1 >= f.ny) return clamp + margin
  const far2 = (x: number, y: number, p: Vec3) =>
    (Math.abs(x - p[0]) + half) ** 2 + (Math.abs(y - p[1]) + half) ** 2
  let need = -Infinity
  for (let j = cj0; j <= cj1; j++) {
    const y = (f.j0 + j) * c + half
    for (let i = ci0; i <= ci1; i++) {
      const x = (f.i0 + i) * c + half
      let t = l2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l2 : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const ex = x - a[0] - t * dx
      const ey = y - a[1] - t * dy
      if (ex * ex + ey * ey > g2) continue
      const k = j * f.nx + i
      const material = f.height(k)
      const floor = f.floor[k]!
      if (far2(x, y, a) <= r2 || far2(x, y, b) <= r2) {
        // its own column at either end: the tool stood (or descends) there
        need = Math.max(need, material, floor === Infinity ? -Infinity : floor)
        continue
      }
      need = Math.max(need, Math.max(material, floor === Infinity ? clamp : floor) + margin)
    }
  }
  return need
}

const roundUp = (z: number) => Math.ceil(z / LINK_LEVEL_STEP - 1e-6) * LINK_LEVEL_STEP

/** The XY extent of every move, grown by `grow`. */
function extentOf(ops: readonly LinkOperation[], grow: number): FieldExtent {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const op of ops)
    for (const p of op.toolpath.passes)
      for (const m of p.moves) {
        const [x, y] = moveEnd(m)
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return { minX: minX - grow, minY: minY - grow, maxX: maxX + grow, maxY: maxY + grow }
}

// ── The pass ──────────────────────────────────────────────────────────────────────────────

/**
 * The setup's links (docs/modes/safe-links.md#where-it-runs): pass 1 builds the cleared footprint
 * from the whole program, pass 2 walks the toolpaths in order, links each into the next one of
 * the same tool run without a pause at the lowest safe level over the field, checks the rapids
 * it wrote (the guard) and stamps the toolpath into the field. `retraction: 'full'` returns the
 * toolpaths unchanged (every link at the clearance height).
 */
export function planLinks(ops: readonly LinkOperation[], s: LinkSettings): SetupLinks {
  const clearance = s.clearance
  const out: Toolpath[] = ops.map((o) => o.toolpath)
  const links: Link[] = []
  const collisions: LinkCollision[] = []
  let unknownLinks = 0
  let unknownSaved = 0
  const minimum = s.retraction === 'minimum'
  let field: StockHeights | undefined
  if (minimum && ops.length > 1) {
    const rMax = Math.max(...ops.map((o) => o.tool.diameter / 2))
    field = new StockHeights(
      [s.stock[0], s.stock[1]],
      extentOf(ops, rMax + LINK_RADIAL_MARGIN + 2 * (s.cell ?? STOCK_CELL)),
      s.cell ?? STOCK_CELL,
      [-(s.zero?.[0] ?? 0), -(s.zero?.[1] ?? 0)],
    )
    for (const op of ops) field.clear(op.tool, undefined, flat(op.toolpath), clearance, op.stickout)
  }
  const through = -s.stock[2]
  // the program's operation before (cut ones are not in it, DF135)
  let prev: LinkOperation | undefined
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    if (op.cut === true) {
      field?.cut(op.tool, undefined, flat(op.toolpath), through)
      continue
    }
    if (prev !== undefined && !op.pauseBefore) {
      const exit = exitOf(prev.toolpath, clearance)
      const start = entryOf(op.toolpath, clearance)
      if (exit !== undefined && start !== undefined) {
        const { entry, trim } = start
        const descent = flat(op.toolpath)
          .slice(1, trim)
          .map((m) => moveEnd(m))
        const fullSeconds = rapidSeconds(
          [exit, [exit[0], exit[1], clearance], [entry[0], entry[1], clearance], ...descent],
          s.rates,
        )
        const full: Link = {
          index: i,
          exit,
          entry,
          level: clearance,
          floor: Infinity,
          low: false,
          fullSeconds,
          seconds: fullSeconds,
        }
        let link = full
        if (field !== undefined && entry[2] < clearance - EPS) {
          // one tool run: the nut and body of both operations, each with its stickout (the
          // shorter one decides for one holder; H6: the safe envelope of both holders)
          const tool: LinkTool = {
            radius: op.tool.diameter / 2,
            holders: [prev, op].map((o) => ({
              holder: o.holder ?? s.holder,
              stickout: o.stickout,
            })),
          }
          const needFor = (clamp: number) => linkFloor(field!, exit, entry, tool, s, clamp)
          const levelFor = (need: number) =>
            Math.max(exit[2], entry[2], need === -Infinity ? -Infinity : roundUp(need))
          const floor = needFor(clampOf(s))
          const level = levelFor(floor)
          const seconds = (z: number) =>
            rapidSeconds([exit, [exit[0], exit[1], z], [entry[0], entry[1], z], entry], s.rates)
          if (level < clearance - EPS) {
            const legs = linkMoves(exit, entry, level)
            const edit: LinkEdit = {
              trim,
              tail: legs.tail.map(moveEnd),
              head: legs.head.map(moveEnd),
            }
            link = { ...full, level, floor, low: true, seconds: seconds(level), edit }
            collisions.push(...guard(field, i, exit, [...legs.tail, ...legs.head], tool, s))
          } else if (s.clampHeight !== undefined || s.obstacles !== undefined)
            link = { ...full, floor }
          else {
            const zero = levelFor(needFor(0))
            if (zero < clearance - EPS) {
              link = { ...full, floor, withClampSeconds: seconds(zero) }
              unknownLinks++
              unknownSaved += fullSeconds - seconds(zero)
            }
          }
        }
        links.push(link)
      }
    }
    field?.cut(op.tool, undefined, flat(op.toolpath), through)
    prev = op
  }
  const low = links.filter((l) => l.low).length
  return {
    toolpaths: linkedToolpaths(
      out,
      links.flatMap((l) => (l.edit === undefined ? [] : [{ index: l.index, ...l.edit }])),
    ),
    links,
    summary: {
      count: links.length,
      low,
      atClearance: links.length - low,
      seconds: links.reduce((t, l) => t + l.seconds, 0),
      savedSeconds: links.reduce((t, l) => t + l.fullSeconds - l.seconds, 0),
    },
    ...(unknownLinks > 0
      ? { clampHeightUnknown: { links: unknownLinks, savedSeconds: unknownSaved } }
      : {}),
    collisions,
  }
}

/**
 * The toolpaths with their lowered links applied, in link order (the exported moves; the plan and
 * run scenes draw these, DF64 L3). An edit whose toolpaths are missing is skipped.
 */
export function linkedToolpaths(
  toolpaths: readonly Toolpath[],
  edits: readonly ({ readonly index: number } & LinkEdit)[],
): Toolpath[] {
  const out = [...toolpaths]
  const rapids = (ps: readonly Vec3[]): Move[] => ps.map((to) => ({ kind: 'rapid', to }))
  for (const e of edits) {
    const before = out[e.index - 1]
    const after = out[e.index]
    if (before === undefined || after === undefined) continue
    out[e.index - 1] = withTail(before, 1, rapids(e.tail))
    out[e.index] = withHead(after, e.trim, rapids(e.head))
  }
  return out
}

/** Up at the exit (the earlier toolpath's tail), across and down (the later one's head). */
function linkMoves(exit: Vec3, entry: Vec3, level: number): { tail: Move[]; head: Move[] } {
  const tail: Move[] = []
  if (level > exit[2] + EPS) tail.push({ kind: 'rapid', to: [exit[0], exit[1], level] })
  if (!sameXY(exit, entry)) tail.push({ kind: 'rapid', to: [entry[0], entry[1], level] })
  const head: Move[] = []
  if (level > entry[2] + EPS) head.push({ kind: 'rapid', to: entry })
  return { tail, head }
}

/**
 * The export guard (safe-links.md#verification-on-the-virtual-machine, 1): every rapid written
 * for a link is vertical or horizontal, at most the clearance height, and every horizontal one
 * runs at or above its corridor's floor in the field as it is at that time, the items and the
 * holder floor (DF132 H4).
 */
function guard(
  f: StockHeights,
  index: number,
  exit: Vec3,
  moves: readonly Move[],
  tool: LinkTool,
  s: LinkSettings,
): LinkCollision[] {
  const out: LinkCollision[] = []
  let at = exit
  for (const m of moves) {
    const to = moveEnd(m)
    const vertical = sameXY(at, to)
    const horizontal = Math.abs(to[2] - at[2]) < EPS
    if (m.kind !== 'rapid' || (!vertical && !horizontal) || to[2] > s.clearance + EPS)
      out.push({ index, from: at, to, needed: s.clearance })
    else if (horizontal && !vertical) {
      const needed = linkFloor(f, at, to, tool, s)
      if (to[2] < needed - GUARD_SLACK) out.push({ index, from: at, to, needed })
    }
    at = to
  }
  return out
}
