/**
 * Keys on split lines (split parts 4b-2): puzzle (a round head on a neck) and dovetail (a
 * trapezoid with 10° flanks) keys, one generator. Per pair of pieces across a line: the runs of the
 * line inside the footprint, the key size from the outline's tool, the band height and the run,
 * the positions clear of features and the part edge, the knob (male, lower piece) and socket
 * (female, offset by the clearance) as closed path items of the piece outlines' shapes, and the
 * issues `keyFit` reports. Pure.
 * Doc: docs/modes/split-parts.md#implementation-4b, docs/modes/split-parts.md#joints
 */
import { regionContains } from '../../geometry/2d/measure'
import { arcRadius, arcSweep, elementLength, type ArcElement } from '../../geometry/2d/model'
import type { Vec2 } from '../../geometry/model'
import type { ShapeItem, ShapeSegment } from '../shape.dto'
import { isShapeLine, type SplitDTO } from '../part.dto'
import { EPS, type Cell, type Layout, type LinePath } from './layout'
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

/** Joints made of knobs on the piece outlines: puzzle, dovetail (4b-2) and finger (4d) keys. */
export type KeyKind = 'puzzle' | 'dovetail' | 'finger'
export const isKeyKind = (k: SplitDTO['joint']['kind']): k is KeyKind =>
  k === 'puzzle' || k === 'dovetail' || k === 'finger'
/** Joints with a clearance: every one but butt (keys, fingers, half laps; 4d). */
export const hasClearance = (k: SplitDTO['joint']['kind']): boolean => k !== 'butt'

/** A key's numbers (mm), local frame: u along the line, w across it into the female piece. */
export interface KeySize {
  readonly kind: KeyKind
  /** The neck: a puzzle neck's width, a dovetail's width at the line, a finger's width. */
  readonly neck: number
  /** Puzzle head radius; dovetail half width at the tip; half a finger. */
  readonly head: number
  /** Puzzle head centre's distance from the line; dovetail or finger depth. */
  readonly h: number
  /** How far the knob reaches across the line. */
  readonly depth: number
  /** The knob's corner radius (a finger's T-bone radius): the outline tool's radius + the clearance. */
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
export function sized(kind: KeyKind, n: number, tool: number, c: number): KeySize {
  const f = tool / 2 + c
  const q = n / 2
  const grow = 1.2 * c
  // a square finger (4d): its T-bones need 2f, the gaps between fingers n
  if (kind === 'finger')
    return {
      kind,
      neck: n,
      head: q,
      h: n,
      depth: n,
      fillet: f,
      half: q,
      maxTool: Math.min(2 * f, n),
    }
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
  const n0 = nominalNeck(tool, thickness)
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

/** A key's nominal neck (a finger's width): max(10 mm, 3 × tool Ø, thickness / 2). */
const nominalNeck = (tool: number, thickness: number) =>
  Math.max(KEY_NECK_MIN, 3 * tool, thickness / 2)

/**
 * The fingers on a run of `length` (4d): n fingers of width p and the gaps between and at both
 * ends (a female finger at each end), p = length / (2n + 1) from the nominal width; on a run
 * shorter than three nominal widths one finger of length / 3, down to tool Ø + 2 mm. The finger
 * centres are offsets from the run's start; undefined: none fits.
 */
export function fingerLayout(
  tool: number,
  c: number,
  thickness: number,
  length: number,
): { readonly size: KeySize; readonly at: readonly number[] } | undefined {
  const p0 = nominalNeck(tool, thickness)
  const n = Math.max(1, Math.floor((length / p0 - 1) / 2))
  const p = Math.floor((length / (2 * n + 1)) * 100) / 100
  if (p < tool + 2 - EPS) return undefined
  const start = (length - (2 * n + 1) * p) / 2
  return {
    size: sized('finger', p, tool, c),
    at: Array.from({ length: n }, (_, i) => start + (2 * i + 1) * p + p / 2),
  }
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
    if (
      (kind === 'finger'
        ? fingerLayout(d, c, thickness, share)
        : keySize(kind, d, c, thickness, share)) !== undefined
    )
      return Math.round(d * 10) / 10
  return undefined
}

/**
 * A key's frame on a line drawn as a path (4e): `u` runs from `o` along the unit `t`, `w` along
 * `n`, the right normal (into the female piece).
 */
export interface KeyFrame {
  readonly o: Vec2
  readonly t: Vec2
  readonly n: Vec2
}

/** One key: on the line `axis` = `at`, centred at `u` along it, between two pieces of a band. */
export interface Key {
  /** A straight line's axis and value (on a shape line, 4e: `x` and NaN; see `shape`). */
  readonly axis: 'x' | 'y'
  readonly at: number
  readonly u: number
  /** 4e, in a split with a shape line: the segment's frame, `u` measured from its origin. */
  readonly frame?: KeyFrame | undefined
  /** 4e: the line's index in `split.lines`, and its shape id on a shape line. */
  readonly line?: number | undefined
  readonly shape?: string | undefined
  readonly male: Cell
  readonly female: Cell
  readonly size: KeySize
  readonly clearance: number
  /** The band's height between the facings (mm), which sized the key. */
  readonly height: number
}

/** Why a run (or one key's share of it) has no key. */
export interface KeyIssue {
  readonly axis: 'x' | 'y'
  readonly at: number
  /** 4e: the line's index and its shape id on a shape line (as `Key`). */
  readonly line?: number | undefined
  readonly shape?: string | undefined
  readonly male: Cell
  readonly female: Cell
  /** The run along the line (mm). */
  readonly run: readonly [number, number]
  /**
   * `short`: no key fits; `tool`: one fits a smaller tool (`maxTool`); `near`: no place clear;
   * `curved` (4e): the pieces meet along arcs only, which take no key.
   */
  readonly reason: 'short' | 'tool' | 'near' | 'curved'
  readonly maxTool?: number
  /** The tool Ø the keys were sized for. */
  readonly tool: number
  /** The band's height between the facings (mm). */
  readonly height: number
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

/** A point of a key's local frame (`du` from its centre along the line, `w` across) in the part frame. */
export function keyPoint(key: Key, du: number, w: number): Vec2 {
  const f = key.frame
  if (f === undefined) return toPart(key.axis, key.at, key.u + du, w)
  const u = key.u + du
  return [f.o[0] + u * f.t[0] + w * f.n[0], f.o[1] + u * f.t[1] + w * f.n[1]]
}

/** Whether a key's local frame is a mirror of the part frame (arcs turn the other way). */
const mirroredKey = (key: Key) =>
  key.frame === undefined
    ? key.axis === 'x'
    : key.frame.t[0] * key.frame.n[1] - key.frame.t[1] * key.frame.n[0] < 0

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
  if (layout.paths !== undefined)
    return planPathKeys(layout, layout.paths, split, kind, rs, W, tool, top, bottom)
  const c = keyClearance(split)
  const fp = layout.footprint.region
  const keys: Key[] = []
  const issues: KeyIssue[] = []
  const lines = split.lines.flatMap((l) =>
    isShapeLine(l)
      ? []
      : [{ axis: l.axis, at: Number(BigInt(l.at.exact.num)) / Number(BigInt(l.at.exact.den)) }],
  )
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
      for (const run of runs(lo, hi, (u) => solidAcross(fp, axis, at, u)))
        placeRun(
          {
            kind,
            c,
            tool,
            height: zt - zb,
            run,
            male,
            female,
            pt: (u, w) => toPart(axis, at, u, w),
            inCell: inRect,
            solid,
            key: (u, size) => ({ axis, at, u, male, female, size, clearance: c, height: zt - zb }),
            base: { axis, at, male, female, run, tool, height: zt - zb },
          },
          keys,
          issues,
        )
    }
  }
  return { keys, issues }
}

/** One run of a line between two pieces, for `placeRun`. */
interface RunCtx {
  readonly kind: KeyKind
  readonly c: number
  readonly tool: number
  readonly height: number
  readonly run: readonly [number, number]
  readonly male: Cell
  readonly female: Cell
  /** (u along the line, w across into the female) → part frame. */
  readonly pt: (u: number, w: number) => Vec2
  readonly inCell: (cell: Cell, p: Vec2) => boolean
  readonly solid: (p: Vec2) => boolean
  readonly key: (u: number, size: KeySize) => Key
  readonly base: Omit<KeyIssue, 'reason' | 'maxTool'>
}

/**
 * The keys (or fingers) on one run: sized for the run, each at the middle of its share else the
 * nearest clear place; the issues where none fits or none is clear.
 */
function placeRun(r: RunCtx, keys: Key[], issues: KeyIssue[]): void {
  const { kind, c, tool, run, male, female, base } = r
  const length = run[1] - run[0]
  let count = Math.min(KEYS_MAX, Math.max(1, Math.round(length / KEYS_PER)))
  let size: KeySize | undefined
  // fingers (4d): the whole run, in one layout
  const fingers = kind === 'finger' ? fingerLayout(tool, c, r.height, length) : undefined
  if (kind === 'finger') size = fingers?.size
  else
    for (; count >= 1; count--) {
      size = keySize(kind, tool, c, r.height, length / count)
      if (size !== undefined) break
    }
  if (size === undefined) {
    const maxTool = largestTool(kind, tool, c, r.height, length)
    issues.push(
      maxTool === undefined ? { ...base, reason: 'short' } : { ...base, reason: 'tool', maxTool },
    )
    return
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
        const p = r.pt(uu, w)
        return r.inCell(w < 0 ? male : female, p) && r.solid(p)
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
  if (fingers !== undefined) {
    // every finger clear, else none on this run (a butt joint there)
    const us = fingers.at.map((d) => Math.round((run[0] + d) * 100) / 100)
    if (us.every((u) => clear(u))) for (const u of us) keys.push(r.key(u, s))
    else issues.push({ ...base, reason: 'near' })
    return
  }
  const share = length / count
  for (let i = 0; i < count; i++) {
    const segLo = run[0] + i * share
    const segHi = segLo + share
    const mid = (segLo + segHi) / 2
    let found: number | undefined
    for (let d = 0; mid - d >= segLo + s.half - EPS || mid + d <= segHi - s.half + EPS; d += STEP) {
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
    else keys.push(r.key(found, s))
  }
}

/** A sample's step (mm) along an arc when finding the pieces on its two sides (4e). */
const SIDE_STEP = 1

/**
 * The keys of a split with a shape line (4e): per line, per straight segment, per band, the runs
 * where the same two pieces meet across it (the left one male), placed as on a straight line in
 * the segment's frame; arcs take no key, so a pair of pieces that meets along arcs only gets a
 * `curved` issue. Straight lines are paths here too (drawn so their lower piece is the left one).
 */
function planPathKeys(
  layout: Layout,
  paths: readonly LinePath[],
  split: SplitDTO,
  kind: KeyKind,
  rs: readonly Removal[],
  W: number,
  tool: number,
  top: number,
  bottom: number,
): KeyPlan {
  const c = keyClearance(split)
  const fp = layout.footprint.region
  const keys: Key[] = []
  const issues: KeyIssue[] = []
  const mm = (q: { exact: { num: string; den: string } }) =>
    Number(BigInt(q.exact.num)) / Number(BigInt(q.exact.den))
  const inCell = (cell: Cell, p: Vec2) => regionContains(cell.cut ?? cell.region, p)
  const bands = [...new Set(layout.cells.map((x) => x.iz))]
  for (const lp of paths) {
    const l = split.lines[lp.index]!
    const named = isShapeLine(l)
      ? { axis: 'x' as const, at: Number.NaN, line: lp.index, shape: l.shape }
      : { axis: l.axis, at: mm(l.at), line: lp.index }
    for (const iz of bands) {
      const cells = layout.cells.filter((x) => x.iz === iz)
      const first = cells[0]
      if (first === undefined) continue
      const zb = Math.max(first.band.zb, bottom)
      const zt = Math.min(first.band.zt, top)
      if (zt - zb <= EPS) continue
      const zBreaks = [zb, ...new Set(rs.flatMap((r) => [r.zlo, r.zhi]))]
        .filter((z) => z >= zb - EPS && z <= zt + EPS)
        .concat([zt])
        .sort((p, q) => p - q)
      const zs = zBreaks
        .slice(1)
        .flatMap((z, i) => (z - zBreaks[i]! > EPS ? [(z + zBreaks[i]!) / 2] : []))
      const solid = (p: Vec2) => zs.every((z) => materialAt(fp, rs, W, p[0], p[1], z))
      // pairs that meet along the line: keyed somewhere, or along arcs
      const keyed = new Set<string>()
      const curved = new Map<string, { male: Cell; female: Cell; run: [number, number] }>()
      const pairAt = (p: Vec2, n: Vec2) => {
        const a: Vec2 = [p[0] - 0.01 * n[0], p[1] - 0.01 * n[1]]
        const b: Vec2 = [p[0] + 0.01 * n[0], p[1] + 0.01 * n[1]]
        if (!materialAt(fp, [], 0, a[0], a[1], 0) || !materialAt(fp, [], 0, b[0], b[1], 0))
          return undefined
        const male = cells.find((x) => inCell(x, a))
        const female = cells.find((x) => inCell(x, b))
        return male === undefined || female === undefined || male === female
          ? undefined
          : { male, female }
      }
      let along = 0
      for (const e of lp.path.elements) {
        const len = elementLength(e)
        if (e.kind === 'arc') {
          // arcs take no key: note the pairs that meet along them
          const n = Math.max(2, Math.ceil(len / SIDE_STEP))
          for (let k = 0; k < n; k++) {
            const { p, nrm } = arcSample(e, (k + 0.5) / n)
            const pair = pairAt(p, nrm)
            if (pair === undefined) continue
            const id = `${pair.male.n}:${pair.female.n}`
            if (!curved.has(id)) curved.set(id, { ...pair, run: [along, along + len] })
          }
          along += len
          continue
        }
        if (len < EPS) continue
        const t: Vec2 = [(e.b[0] - e.a[0]) / len, (e.b[1] - e.a[1]) / len]
        const nrm: Vec2 = [t[1], -t[0]]
        const frame: KeyFrame = { o: e.a, t, n: nrm }
        const pt = (u: number, w: number): Vec2 => [
          e.a[0] + u * t[0] + w * nrm[0],
          e.a[1] + u * t[1] + w * nrm[1],
        ]
        // runs of one pair along the segment
        const n = Math.max(1, Math.ceil(len / STEP))
        const h = len / n
        let cur: { male: Cell; female: Cell; u0: number } | undefined
        const close = (u1: number) => {
          if (cur === undefined) return
          const { male, female, u0 } = cur
          cur = undefined
          keyed.add(`${male.n}:${female.n}`)
          placeRun(
            {
              kind,
              c,
              tool,
              height: zt - zb,
              run: [u0, u1],
              male,
              female,
              pt,
              inCell,
              solid,
              key: (u, size) => ({
                ...named,
                u,
                frame,
                male,
                female,
                size,
                clearance: c,
                height: zt - zb,
              }),
              base: { ...named, male, female, run: [u0, u1], tool, height: zt - zb },
            },
            keys,
            issues,
          )
        }
        for (let i = 0; i < n; i++) {
          const pair = pairAt(pt((i + 0.5) * h, 0), nrm)
          if (cur !== undefined && (pair?.male !== cur.male || pair.female !== cur.female))
            close(i * h)
          if (pair !== undefined && cur === undefined) cur = { ...pair, u0: i * h }
        }
        close(len)
        along += len
      }
      for (const [id, p] of curved)
        if (!keyed.has(id)) issues.push({ ...named, ...p, tool, height: zt - zb, reason: 'curved' })
    }
  }
  return { keys, issues }
}

/** A point at fraction `f` of an arc and the right normal of its direction there. */
function arcSample(e: ArcElement, f: number): { p: Vec2; nrm: Vec2 } {
  const a0 = Math.atan2(e.a[1] - e.centre[1], e.a[0] - e.centre[0])
  const r = arcRadius(e)
  const a = a0 + arcSweep(e) * f
  const radial: Vec2 = [Math.cos(a), Math.sin(a)]
  // a counter-clockwise arc's right normal points out from its centre, a clockwise one's in
  const nrm: Vec2 = e.ccw ? radial : [-radial[0], -radial[1]]
  return { p: [e.centre[0] + r * radial[0], e.centre[1] + r * radial[1]], nrm }
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
  if (size.kind === 'finger') {
    // a square finger from the base strip (male), or its socket grown by c at the cheeks and tip
    const qq = q + g
    const d = size.depth + g
    return {
      start: [-qq, -STRIP],
      segments: [
        { kind: 'line', to: [qq, -STRIP] },
        { kind: 'line', to: [qq, d] },
        { kind: 'line', to: [-qq, d] },
      ],
      fillets: [],
    }
  }
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
  const mirrored = mirroredKey(key)
  const P = (p: Vec2): [number, number] => {
    const q = keyPoint(key, p[0], p[1])
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
    ...(local.fillets.length === 0
      ? {}
      : { fillets: local.fillets.map((f) => ({ vertex: f.vertex, radius: micro(f.radius) })) }),
  }
}

/**
 * A finger's T-bones (4d) in the local frame: circles of radius f centred on the cheeks at f from
 * the inside corners, the male's at the finger's base, the female's at the socket's bottom.
 */
export function tBoneCentres(size: KeySize, c: number, side: 'male' | 'female'): Vec2[] {
  const f = size.fillet
  const q = size.neck / 2
  return side === 'male'
    ? [
        [q, f],
        [-q, f],
      ]
    : [
        [q + c, size.depth + c - f],
        [-q - c, size.depth + c - f],
      ]
}

/** A circle as a closed path of four quarter arcs, counter-clockwise (an exact half arc is ill-posed). */
function circlePath(
  centre: Vec2,
  r: number,
  op: 'add' | 'subtract',
  P: (p: Vec2) => [number, number],
  mirrored: boolean,
): PathItem {
  const at = (k: number): Vec2 => [
    centre[0] + r * Math.cos((k * Math.PI) / 2),
    centre[1] + r * Math.sin((k * Math.PI) / 2),
  ]
  return {
    kind: 'path',
    op,
    start: P(at(0)),
    segments: [1, 2, 3, 4].map((k) => ({
      kind: 'arc' as const,
      to: P(at(k % 4)),
      radius: micro(r),
      cw: mirrored,
      large: false,
    })),
    closed: true,
  }
}

/**
 * A key's items on a piece outline's shape (mm, part frame): its knob or socket, and for a
 * finger (4d) the two T-bones (`subtract`) after it.
 */
export function keyItems(key: Key, side: 'male' | 'female'): PathItem[] {
  const item = keyItem(key, side)
  if (key.size.kind !== 'finger') return [item]
  const P = (p: Vec2): [number, number] => {
    const q = keyPoint(key, p[0], p[1])
    return [micro(q[0]), micro(q[1])]
  }
  return [
    item,
    ...tBoneCentres(key.size, key.clearance, side).map((c) =>
      circlePath(c, key.size.fillet, 'subtract', P, mirroredKey(key)),
    ),
  ]
}

/** The knob's outline above the line in the part frame, for a preview (fillets left out). */
export function keyPreviewPoints(key: Key): Vec2[] {
  if (key.size.kind === 'finger') {
    const q = key.size.neck / 2
    const d = key.size.depth
    const corners: Vec2[] = [
      [q, 0],
      [q, d],
      [-q, d],
      [-q, 0],
    ]
    return corners.map((p) => keyPoint(key, p[0], p[1]))
  }
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
  return pts.map((p) => keyPoint(key, p[0], p[1]))
}
