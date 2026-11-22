/**
 * Tabs that hold (v0.4 TB1, D40): whether a tab's span has stock beyond the slot, and the
 * resolved tab centres of a through profile of a closed loop – the count rule with tabs over free
 * sides moved to the nearest position that holds; entered positions kept and only reported.
 * Geometry evaluation, the toolpath generators, the DFM checks and the viewport's markers all take
 * their centres from `resolveProfileTabs`. Pure and deterministic; no port call.
 * Doc: docs/modes/design-v0.4.md#tabs-relocate-off-free-sides-tb1
 */
import { chainLength, chainPointAt } from './2d/measure'
import { chainBounds, signedArea, type Loop } from './2d/model'
import { EPSILON, isAnalyticOperation, type OperationGeometry, type Vec2 } from './model'
import { profileChain, tabCentres } from './outline'

/**
 * Stock that must remain beyond the slot (and of the part before it) for a tab to hold (mm): none,
 * the threshold of `dfm.slotLeavesStock` / `dfm.slotOpensStock` (stock margin ≥ slot width).
 */
export const TAB_HOLD_WEB = 0
/** Sampling step along the loop: span samples and relocation candidates (mm). */
export const TAB_HOLD_STEP = 0.25

type Profile = Extract<OperationGeometry, { kind: 'profile' }>

/** What decides whether a tab holds: the loop, the slot's cross-section, the stock rectangle. */
export interface TabHoldInput {
  /** The closed loop in the face frame, from its start point. */
  readonly chain: Loop
  readonly side: Profile['side']
  readonly slotWidth: number
  /** Tab width along the loop (mm). */
  readonly width: number
  /** The face rectangle `[0, length] × [0, width]` of the local stock. */
  readonly stock: { readonly length: number; readonly width: number }
}

/** Resolved tab centres and what the resolution did (indices refer to the nominal order). */
export interface ResolvedTabs {
  /** Centres as distances along the loop, in the nominal order (moved ones in [0, length)). */
  readonly centres: readonly number[]
  /** The count rule's (or the entered) centres. */
  readonly nominal: readonly number[]
  /** Indices of the tabs moved off free sides (count rule only). */
  readonly moved: readonly number[]
  /** Indices of the tabs left where they hold nothing. */
  readonly unheld: readonly number[]
  /** Some position on the loop holds a tab. */
  readonly anyHeld: boolean
}

const mod = (x: number, m: number): number => (m > 0 ? ((x % m) + m) % m : 0)

/**
 * Free stock sides (front = lowest v, right, back, left): the slot runs off the stock there (its
 * outer edge reaches past the face rectangle's edge; the loop's exact bounds, as
 * `dfm.slotOpensStock` measures them). Stock beyond the slot near a free side belongs to no strip
 * along a held side (a loose remnant at best).
 */
export function freeSides(input: TabHoldInput): readonly [boolean, boolean, boolean, boolean] {
  const b = chainBounds(input.chain.elements)
  if (b === undefined) return [true, true, true, true]
  const sw = input.slotWidth
  const reach = input.side === 'outside' ? sw : input.side === 'inside' ? 0 : sw / 2
  const { length: L, width: W } = input.stock
  const short = (margin: number) => margin < reach - EPSILON
  return [short(b.min[1]), short(L - b.max[0]), short(W - b.max[1]), short(b.min[0])]
}

/**
 * The hold test of a single loop point at distance `s`: both ends of the slot's cross-section
 * there (extended by the web) lie inside the stock rectangle, and the stock side a ray from the
 * outer end along the loop's outward normal leaves through is not free (so the stock beyond the
 * cut belongs to the strip along a held side, not a loose remnant).
 */
export function holdTest(input: TabHoldInput): (s: number) => boolean {
  const { chain, side, slotWidth: sw, stock } = input
  const { length: L, width: W } = stock
  const free = freeSides(input)
  const allFree = free.every((f) => f)
  // outward normal of the loop: right of the tangent for a counter-clockwise loop
  const sign = signedArea(chain) >= 0 ? 1 : -1
  const [lo, hi] = side === 'outside' ? [0, sw] : side === 'inside' ? [-sw, 0] : [-sw / 2, sw / 2]
  const tol = EPSILON
  const inside = (p: Vec2) => p[0] >= -tol && p[0] <= L + tol && p[1] >= -tol && p[1] <= W + tol
  /** The stock side a ray from `q` along `n` leaves the rectangle through is held (ties: any). */
  const exitHeld = (q: Vec2, n: Vec2) => {
    const t = [
      n[1] < -tol ? q[1] / -n[1] : Infinity,
      n[0] > tol ? (L - q[0]) / n[0] : Infinity,
      n[1] > tol ? (W - q[1]) / n[1] : Infinity,
      n[0] < -tol ? q[0] / -n[0] : Infinity,
    ]
    const m = Math.min(...t)
    return t.some((x, k) => x <= m + tol && !free[k])
  }
  return (s) => {
    if (allFree) return false
    const r = chainPointAt(chain, s, true)
    if (r.isErr()) return false
    const { point: p, tangent: t } = r.unwrap()
    const n: Vec2 = [sign * t[1], -sign * t[0]]
    const at = (d: number): Vec2 => [p[0] + n[0] * d, p[1] + n[1] * d]
    const outer = at(hi + TAB_HOLD_WEB)
    // outwards from the outer end (`inside`: from the loop into the slug, which needs no strip)
    return (
      inside(outer) && inside(at(lo - TAB_HOLD_WEB)) && (side === 'inside' || exitHeld(outer, n))
    )
  }
}

/** Does a tab centred at `c` hold over its whole span (sampled at most a step apart, ends too)? */
function spanHolds(held: (s: number) => boolean, c: number, width: number): boolean {
  const m = Math.max(1, Math.ceil(width / TAB_HOLD_STEP))
  for (let k = 0; k <= m; k++) if (!held(c - width / 2 + (width * k) / m)) return false
  return true
}

/**
 * Resolve tab centres on a closed loop. `fixed`: entered positions, never moved. Otherwise each
 * nominal tab that does not hold moves, in index order, to the nearest candidate (every
 * `TAB_HOLD_STEP` along the loop) that holds and keeps centres at least `width` from the tabs
 * already placed; equal distances go to the one further along. A tab with no such candidate stays.
 */
export function resolveTabs(
  input: TabHoldInput,
  nominal: readonly number[],
  fixed: boolean,
): ResolvedTabs {
  const length = chainLength(input.chain)
  const held = holdTest(input)
  const w = input.width
  const ok = nominal.map((c) => spanHolds(held, c, w))
  const bad = ok.flatMap((h, i) => (h ? [] : [i]))
  const same = { centres: [...nominal], nominal: [...nominal], moved: [] }
  if (bad.length === 0) return { ...same, unheld: [], anyHeld: true }
  if (length <= 0) return { ...same, unheld: bad, anyHeld: false }

  // held state on a grid along the loop; a candidate's window is all held, its ends checked exactly
  const N = Math.max(1, Math.ceil(length / TAB_HOLD_STEP))
  const h = length / N
  const grid = Array.from({ length: N }, (_, j) => held(j * h))
  const anyHeld = grid.some((g) => g)
  if (fixed || !anyHeld) return { ...same, unheld: bad, anyHeld }
  // prefix counts of unheld grid points over two turns (circular windows)
  const pre = new Int32Array(2 * N + 1)
  for (let k = 0; k < 2 * N; k++) pre[k + 1] = pre[k]! + (grid[k % N] ? 0 : 1)
  const K = Math.floor(w / 2 / h + 1e-9)
  const windowHeld = (j: number) => {
    if (2 * K + 1 > N) return false
    const a = mod(j - K, N)
    return pre[a + 2 * K + 1]! - pre[a]! === 0
  }
  const valid = new Map<number, boolean>()
  const candidate = (j: number): boolean => {
    let v = valid.get(j)
    if (v === undefined) {
      const c = j * h
      v = windowHeld(j) && held(c - w / 2) && held(c + w / 2)
      valid.set(j, v)
    }
    return v
  }
  const circ = (a: number, b: number) => {
    const d = Math.abs(mod(a, length) - mod(b, length))
    return Math.min(d, length - d)
  }
  const centres = [...nominal]
  const placed = nominal.filter((_, i) => ok[i])
  const free = (c: number) => placed.every((p) => circ(p, c) >= w - 1e-9)
  const moved: number[] = []
  const unheld: number[] = []
  for (const i of bad) {
    const c = mod(nominal[i]!, length)
    const j0 = Math.round(c / h)
    let best: number | undefined
    for (let d = 0; d <= Math.ceil(N / 2) + 1 && best === undefined; d++) {
      // both neighbours at this grid step; the nearer, then the one further along, wins
      const options = [j0 + d, j0 - d]
        .map((j) => ({ j: mod(j, N), dist: circ(j * h, c), ahead: j >= j0 }))
        .sort((a, b) => a.dist - b.dist || (a.ahead === b.ahead ? 0 : a.ahead ? -1 : 1))
      for (const o of options)
        if (candidate(o.j) && free(o.j * h)) {
          best = o.j * h
          break
        }
    }
    if (best === undefined) unheld.push(i)
    else {
      centres[i] = best
      placed.push(best)
      moved.push(i)
    }
  }
  return { centres, nominal: [...nominal], moved, unheld, anyHeld }
}

/**
 * The count rule's nominal centres of a profile: v0.1 contours (the v0.1/v0.2 builders) from the
 * middle of the front wall (a circle: its front point), others half a spacing after the start.
 */
function nominalCentres(op: Profile, length: number): number[] {
  if (op.tabs.positions !== undefined) return [...op.tabs.positions]
  const c = op.shape.contour
  if (isAnalyticOperation(op) && (c.kind === 'rectangle' || c.kind === 'circle')) {
    const n = Number.isInteger(op.tabs.count) && op.tabs.count > 0 ? op.tabs.count : 0
    const first = c.kind === 'circle' ? 0 : (c.length - 2 * c.cornerRadius) / 2
    return Array.from({ length: n }, (_, i) => first + (i * length) / n)
  }
  return tabCentres(length, op.tabs)
}

/**
 * The resolved tab centres of a profile on its local stock (`stock`: the face rectangle). Open
 * paths and blind grooves build no tabs (empty). Nominal v0.1 centres may exceed the loop length
 * (the v0.1 builders take them so); moved ones lie in [0, length).
 */
export function resolveProfileTabs(
  op: Profile,
  stock: { readonly length: number; readonly width: number },
): ResolvedTabs {
  const { chain, closed } = profileChain(op)
  if (!closed || op.depth !== undefined)
    return { centres: [], nominal: [], moved: [], unheld: [], anyHeld: true }
  const nominal = nominalCentres(op, chainLength(chain))
  const input = { chain, side: op.side, slotWidth: op.slotWidth, width: op.tabs.width, stock }
  return resolveTabs(input, nominal, op.tabs.positions !== undefined)
}

/**
 * Tab stretches `[from, to]` (distances along the loop from its start point, mm) of the resolved
 * centres: what geometry evaluation builds as tab bands.
 */
export function tabStretches(
  op: Profile,
  stock: { readonly length: number; readonly width: number },
): { readonly from: number; readonly to: number }[] {
  const w = op.tabs.width
  return resolveProfileTabs(op, stock).centres.map((c) => ({ from: c - w / 2, to: c + w / 2 }))
}

/**
 * The resolved centres of a v0.1 profile as its offset bands take them (arc length from the
 * contour's start, never below half a tab width: a moved tab near the start is taken a turn on),
 * and whether any moved. `count` 0 (the slot covers the opening) builds none.
 */
export function analyticTabCentres(
  op: Profile,
  stock: { readonly length: number; readonly width: number },
  count: number,
): { readonly centres: number[]; readonly moved: boolean } {
  if (count === 0) return { centres: [], moved: false }
  const r = resolveProfileTabs(op, stock)
  const length = chainLength(profileChain(op).chain)
  const half = op.tabs.width / 2
  const centres = r.centres.map((c, i) => (r.moved.includes(i) && c < half ? c + length : c))
  return { centres, moved: r.moved.length > 0 }
}
