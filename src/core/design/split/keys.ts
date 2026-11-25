/**
 * Keys on split lines (split parts 4b-2): puzzle (a round head on a neck) and dovetail (a
 * trapezoid with 10° flanks) keys, one generator. Per pair of pieces across a line: the runs of the
 * line inside the footprint, the key size from the outline's tool, the band height and the run,
 * the positions clear of features and the part edge, the knob (male, lower piece) and socket
 * (female, offset by the clearance) as closed path items of the piece outlines' shapes, and the
 * issues `keyFit` reports. Pure.
 * Doc: docs/modes/split-parts.md#implementation-4b, docs/modes/split-parts.md#joints
 */
import type { Vec2 } from '../../geometry/model'
import type { ShapeItem, ShapeSegment } from '../shape.dto'
import type { SplitDTO } from '../part.dto'
import { EPS, type Cell, type Layout } from './layout'
import { materialAt, type Removal } from './removals'

/** A key's socket clearance when none is set (mm): socket side only, the knob keeps its size. */
export const KEY_CLEARANCE_DEFAULT = 0.15
/** The largest clearance accepted (mm). */
export const KEY_CLEARANCE_MAX = 1
/** A key's neck at least this (mm) and 3 × the outline's tool Ø: the `thinJoint` limit. */
export const KEY_NECK_MIN = 10
/** A dovetail key's flank angle from the line's normal (degrees). */
export const DOVETAIL_FLANK_DEG = 10
/** Puzzle head radius per neck width: head Ø = neck / 0.6 (a jigsaw knob). */
const PUZZLE_HEAD = 1 / 1.2
/** One key per this much (mm) of a run, 1 to `KEYS_MAX`. */
const KEYS_PER = 200
const KEYS_MAX = 4
/** A key takes at most a third of its share of the run. */
const RUN_PER_KEY = 3
/** The knob's base reaches this far (mm) into the male piece, so it overlaps the piece. */
const STRIP = 1
/** A straight bit (mm) kept on a puzzle neck between its two fillets. */
const FLANK = 0.5
/** Sampling step (mm) along a line and across a key. */
const STEP = 0.5

export type KeyKind = 'puzzle' | 'dovetail'
export const isKeyKind = (k: SplitDTO['joint']['kind']): k is KeyKind =>
  k === 'puzzle' || k === 'dovetail'

/** A key's numbers (mm), local frame: u along the line, w across it into the female piece. */
export interface KeySize {
  readonly kind: KeyKind
  /** The neck: a puzzle neck's width, a dovetail's width at the line. */
  readonly neck: number
  /** Puzzle head radius; dovetail half width at the tip. */
  readonly head: number
  /** Puzzle head centre's distance from the line; dovetail depth. */
  readonly h: number
  /** How far the knob reaches across the line. */
  readonly depth: number
  /** The knob's corner radius: the outline tool's radius + the clearance. */
  readonly fillet: number
  /** Half the key's extent along the line, its base strip included. */
  readonly half: number
  /** The largest tool Ø that cuts both the knob and the socket. */
  readonly maxTool: number
}

const tan = Math.tan((DOVETAIL_FLANK_DEG * Math.PI) / 180)
const cos = Math.cos((DOVETAIL_FLANK_DEG * Math.PI) / 180)
const sin = Math.sin((DOVETAIL_FLANK_DEG * Math.PI) / 180)

/** A key of neck `n` for a tool Ø `tool` and clearance `c`. */
function sized(kind: KeyKind, n: number, tool: number, c: number): KeySize {
  const f = tool / 2 + c
  const q = n / 2
  const grow = 1.2 * c
  if (kind === 'puzzle') {
    const a = n * PUZZLE_HEAD
    // the head sits where a fillet of radius f fits between the neck and the head, plus a flank
    const h = f + FLANK + Math.sqrt((a + f) ** 2 - (q + f) ** 2)
    return {
      kind,
      neck: n,
      head: a,
      h,
      depth: h + a,
      fillet: f,
      half: Math.max(a, q + 1.5 * f) + STRIP + grow,
      maxTool: Math.min(2 * f, n + 2 * c),
    }
  }
  // the flank holds both corner fillets (tangent length f / tan 40° each)
  const e = Math.max(n, 2.6 * (f + c))
  const t = q + e * tan
  return {
    kind,
    neck: n,
    head: t,
    h: e,
    depth: e,
    fillet: f,
    half: Math.max(t, q + 1.5 * f) + STRIP + grow,
    maxTool: Math.min(2 * f, n + 2 * c),
  }
}

/**
 * The key for a share of a run (mm along the line): the nominal neck max(10 mm, 3 × tool Ø,
 * thickness / 2), shrunk to fit a third of the share down to tool Ø + 2 mm (the socket's neck lets
 * the tool through); undefined when even that does not fit.
 */
export function keySize(
  kind: KeyKind,
  tool: number,
  c: number,
  thickness: number,
  share: number,
): KeySize | undefined {
  const fits = (n: number) => RUN_PER_KEY * 2 * sized(kind, n, tool, c).half <= share + EPS
  const n0 = Math.max(KEY_NECK_MIN, 3 * tool, thickness / 2)
  if (fits(n0)) return sized(kind, n0, tool, c)
  const nMin = tool + 2
  if (!fits(nMin)) return undefined
  let lo = nMin
  let hi = n0
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return sized(kind, Math.floor(lo * 100) / 100, tool, c)
}

/** The largest tool Ø (mm, 0.1 steps down) a key on `share` fits with; undefined below 1 mm. */
function largestTool(
  kind: KeyKind,
  tool: number,
  c: number,
  thickness: number,
  share: number,
): number | undefined {
  for (let d = Math.floor(tool * 10) / 10; d >= 1; d -= 0.1)
    if (keySize(kind, d, c, thickness, share) !== undefined) return Math.round(d * 10) / 10
  return undefined
}

/** One key: on the line `axis` = `at`, centred at `u` along it, between two pieces of a band. */
export interface Key {
  readonly axis: 'x' | 'y'
  readonly at: number
  readonly u: number
  readonly male: Cell
  readonly female: Cell
  readonly size: KeySize
  readonly clearance: number
}

/** Why a run (or one key's share of it) has no key. */
export interface KeyIssue {
  readonly axis: 'x' | 'y'
  readonly at: number
  readonly male: Cell
  readonly female: Cell
  /** The run along the line (mm). */
  readonly run: readonly [number, number]
  /** `short`: no key fits; `tool`: one fits a smaller tool (`maxTool`); `near`: no place clear. */
  readonly reason: 'short' | 'tool' | 'near'
  readonly maxTool?: number
  /** The tool Ø the keys were sized for. */
  readonly tool: number
}

export interface KeyPlan {
  readonly keys: readonly Key[]
  readonly issues: readonly KeyIssue[]
}

/** The clearance of a split's keys (mm). */
export function keyClearance(split: SplitDTO): number {
  const c = split.joint.clearance
  return c === undefined
    ? KEY_CLEARANCE_DEFAULT
    : Number(BigInt(c.exact.num)) / Number(BigInt(c.exact.den))
}

/** Local (u along the line, w across) → part frame, for the line `axis` = `at`. */
const toPart = (axis: 'x' | 'y', at: number, u: number, w: number): Vec2 =>
  axis === 'x' ? [at + w, u] : [u, at + w]

const inRect = (c: Cell, p: Vec2) =>
  p[0] >= c.rect.x0 - EPS &&
  p[0] <= c.rect.x1 + EPS &&
  p[1] >= c.rect.y0 - EPS &&
  p[1] <= c.rect.y1 + EPS

/**
 * The keys of a split whose lines are keyed: per line, per pair of pieces across it (the lower
 * piece along the axis is male), per run of the line inside the footprint: one key per 200 mm, at
 * the middle of its share, else the nearest place where the key and a wall of one tool Ø around it
 * are solid through the band (no removal, inside both cells and the footprint). `tool`: the
 * outline's tool Ø; `top`/`bottom`: the part's faced top and bottom (part-frame z).
 */
export function planKeys(
  layout: Layout,
  split: SplitDTO,
  rs: readonly Removal[],
  W: number,
  tool: number,
  top: number,
  bottom: number,
): KeyPlan {
  const kind = split.joint.kind
  if (!isKeyKind(kind)) return { keys: [], issues: [] }
  const c = keyClearance(split)
  const fp = layout.footprint.region
  const keys: Key[] = []
  const issues: KeyIssue[] = []
  const lines = split.lines.map((l) => ({
    axis: l.axis,
    at: Number(BigInt(l.at.exact.num)) / Number(BigInt(l.at.exact.den)),
  }))
  const seen = new Set<string>()
  for (const line of lines) {
    const key = `${line.axis}:${line.at}`
    if (seen.has(key)) continue
    seen.add(key)
    const { axis, at } = line
    for (const male of layout.cells) {
      if (Math.abs((axis === 'x' ? male.rect.x1 : male.rect.y1) - at) > EPS) continue
      const female = layout.cells.find(
        (f) =>
          f.iz === male.iz &&
          (axis === 'x'
            ? f.iy === male.iy && Math.abs(f.rect.x0 - at) <= EPS
            : f.ix === male.ix && Math.abs(f.rect.y0 - at) <= EPS),
      )
      if (female === undefined) continue
      const zb = Math.max(male.band.zb, bottom)
      const zt = Math.min(male.band.zt, top)
      if (zt - zb <= EPS) continue
      const zBreaks = [zb, ...new Set(rs.flatMap((r) => [r.zlo, r.zhi]))]
        .filter((z) => z >= zb - EPS && z <= zt + EPS)
        .concat([zt])
        .sort((p, q) => p - q)
      const zs = zBreaks
        .slice(1)
        .flatMap((z, i) => (z - zBreaks[i]! > EPS ? [(z + zBreaks[i]!) / 2] : []))
      const solid = (p: Vec2) => zs.every((z) => materialAt(fp, rs, W, p[0], p[1], z))
      const [lo, hi] = axis === 'x' ? [male.rect.y0, male.rect.y1] : [male.rect.x0, male.rect.x1]
      for (const run of runs(lo, hi, (u) => solidAcross(fp, axis, at, u))) {
        const length = run[1] - run[0]
        const base = { axis, at, male, female, run, tool }
        let count = Math.min(KEYS_MAX, Math.max(1, Math.round(length / KEYS_PER)))
        let size: KeySize | undefined
        for (; count >= 1; count--) {
          size = keySize(kind, tool, c, zt - zb, length / count)
          if (size !== undefined) break
        }
        if (size === undefined) {
          const maxTool = largestTool(kind, tool, c, zt - zb, length)
          issues.push(
            maxTool === undefined
              ? { ...base, reason: 'short' }
              : { ...base, reason: 'tool', maxTool },
          )
          continue
        }
        const s = size
        const wall = tool
        // a column across the line at u: solid from a wall below the line to a wall past the key
        const ws: number[] = []
        for (let w = -wall; w < s.depth + c + wall; w += 1) ws.push(w)
        ws.push(s.depth + c + wall)
        const memo = new Map<number, boolean>()
        const column = (u: number) => {
          const k = Math.round(u / STEP)
          let v = memo.get(k)
          if (v === undefined) {
            const uu = k * STEP
            v = ws.every((w) => {
              const p = toPart(axis, at, uu, w)
              return inRect(w < 0 ? male : female, p) && solid(p)
            })
            memo.set(k, v)
          }
          return v
        }
        const reach = s.half + wall
        const clear = (u: number) => {
          for (let x = u - reach; x <= u + reach + EPS; x += STEP) if (!column(x)) return false
          return column(u + reach)
        }
        const share = length / count
        for (let i = 0; i < count; i++) {
          const segLo = run[0] + i * share
          const segHi = segLo + share
          const mid = (segLo + segHi) / 2
          let found: number | undefined
          for (
            let d = 0;
            mid - d >= segLo + s.half - EPS || mid + d <= segHi - s.half + EPS;
            d += STEP
          ) {
            const tries = d === 0 ? [mid] : [mid - d, mid + d]
            for (const u of tries) {
              if (u - s.half < segLo - EPS || u + s.half > segHi + EPS) continue
              if (clear(u)) {
                found = Math.round(u * 100) / 100
                break
              }
            }
            if (found !== undefined) break
          }
          if (found === undefined) issues.push({ ...base, run: [segLo, segHi], reason: 'near' })
          else keys.push({ axis, at, u: found, male, female, size: s, clearance: c })
        }
      }
    }
  }
  return { keys, issues }
}

/** Both sides of the line `axis` = `at` are inside the footprint at `u`. */
function solidAcross(fp: Layout['footprint']['region'], axis: 'x' | 'y', at: number, u: number) {
  const d = 0.01
  const a = toPart(axis, at, u, -d)
  const b = toPart(axis, at, u, d)
  return materialAt(fp, [], 0, a[0], a[1], 0) && materialAt(fp, [], 0, b[0], b[1], 0)
}

/** The intervals of [lo, hi] where `inside` holds, sampled every `STEP`. */
function runs(lo: number, hi: number, inside: (u: number) => boolean): [number, number][] {
  const out: [number, number][] = []
  const n = Math.max(1, Math.ceil((hi - lo) / STEP))
  const h = (hi - lo) / n
  let start: number | undefined
  for (let i = 0; i <= n; i++) {
    const u = lo + i * h
    const ok = i < n && inside(Math.min(hi - 1e-3, Math.max(lo + 1e-3, u + h / 2)))
    if (ok && start === undefined) start = u
    if (!ok && start !== undefined) {
      out.push([start, u])
      start = undefined
    }
  }
  return out
}

// ── the knob and the socket ───────────────────────────────────────────────────────────────

/** A path point and segment list in the local frame, with fillets at vertices. */
interface LocalPath {
  readonly start: Vec2
  readonly segments: readonly (
    | { readonly kind: 'line'; readonly to: Vec2 }
    | { readonly kind: 'arc'; readonly to: Vec2; readonly radius: number; readonly large: boolean }
  )[]
  readonly fillets: readonly { readonly vertex: number; readonly radius: number }[]
}

/**
 * The knob (`male`) or the socket (the knob offset by the clearance; its fillets at the line
 * tangent to it, so the gap narrows to 0 there) of a key, counter-clockwise in the local frame:
 * the base strip below the line, the neck, the head (an arc, or the dovetail's tip), back down.
 * The socket's fillet at the line sits right below the knob's (radius f − c / (1 + sin flank)),
 * so it stays inside the knob's corner: the pieces never overlap.
 */
export function keyLocalPath(size: KeySize, c: number, side: 'male' | 'female'): LocalPath {
  const g = side === 'male' ? 0 : c
  const f = size.fillet
  const B = size.half
  const q = size.neck / 2
  const base = [
    [-B, -STRIP],
    [B, -STRIP],
    [B, 0],
  ] as const
  if (size.kind === 'puzzle') {
    const qq = q + g
    const a = size.head + g
    const yj = size.h - Math.sqrt(a * a - qq * qq)
    const r = f - g
    return {
      start: base[0],
      segments: [
        { kind: 'line', to: base[1] },
        { kind: 'line', to: base[2] },
        { kind: 'line', to: [qq, 0] },
        { kind: 'line', to: [qq, yj] },
        { kind: 'arc', to: [-qq, yj], radius: a, large: true },
        { kind: 'line', to: [-qq, 0] },
        { kind: 'line', to: [-B, 0] },
      ],
      fillets: [3, 4, 5, 6].map((vertex) => ({ vertex, radius: r })),
    }
  }
  const qq = q + g / cos
  const e = size.h + g
  const t = qq + e * tan
  return {
    start: base[0],
    segments: [
      { kind: 'line', to: base[1] },
      { kind: 'line', to: base[2] },
      { kind: 'line', to: [qq, 0] },
      { kind: 'line', to: [t, e] },
      { kind: 'line', to: [-t, e] },
      { kind: 'line', to: [-qq, 0] },
      { kind: 'line', to: [-B, 0] },
    ],
    fillets: [
      { vertex: 3, radius: f - g / (1 + sin) },
      { vertex: 4, radius: f + g },
      { vertex: 5, radius: f + g },
      { vertex: 6, radius: f - g / (1 + sin) },
    ],
  }
}

/** A closed path item of a shape definition (mm). */
export type PathItem = Extract<ShapeItem<number>, { kind: 'path' }>

const micro = (v: number) => Math.round(v * 1e6) / 1e6

/**
 * A key's knob or socket as a closed path item in the part frame (mm): `add` on the male piece's
 * outline shape, `subtract` on the female's. Lengths rounded to 1 µm (as stored).
 */
export function keyItem(key: Key, side: 'male' | 'female'): PathItem {
  const local = keyLocalPath(key.size, key.clearance, side)
  // a line along y maps (u, w) → (at + w, u): a mirror, so arcs turn the other way
  const mirrored = key.axis === 'x'
  const P = (p: Vec2): [number, number] => {
    const q = toPart(key.axis, key.at, key.u + p[0], p[1])
    return [micro(q[0]), micro(q[1])]
  }
  const segments: ShapeSegment<number>[] = local.segments.map((s) =>
    s.kind === 'line'
      ? { kind: 'line', to: P(s.to) }
      : { kind: 'arc', to: P(s.to), radius: micro(s.radius), cw: mirrored, large: s.large },
  )
  return {
    kind: 'path',
    op: side === 'male' ? 'add' : 'subtract',
    start: P(local.start),
    segments,
    closed: true,
    fillets: local.fillets.map((f) => ({ vertex: f.vertex, radius: micro(f.radius) })),
  }
}

/** The knob's outline above the line in the part frame, for a preview (fillets left out). */
export function keyPreviewPoints(key: Key): Vec2[] {
  const local = keyLocalPath(key.size, key.clearance, 'male')
  const pts: Vec2[] = []
  for (const s of local.segments.slice(2, 6)) {
    if (s.kind === 'line') pts.push(s.to)
    else {
      // the head: counter-clockwise from its right end over the top to its left end
      const from = pts[pts.length - 1]!
      const cy = key.size.h
      const a0 = Math.atan2(from[1] - cy, from[0])
      const a1 = Math.atan2(s.to[1] - cy, s.to[0])
      const end = a1 < a0 ? a1 + 2 * Math.PI : a1
      for (let k = 1; k <= 16; k++) {
        const a = a0 + ((end - a0) * k) / 16
        pts.push([s.radius * Math.cos(a), cy + s.radius * Math.sin(a)])
      }
    }
  }
  return pts.map((p) => toPart(key.axis, key.at, key.u + p[0], p[1]))
}
