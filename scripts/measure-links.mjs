// Measures how much of a DFYOM gCode program goes to rapid links at the clearance height, and
// what lower links over the in-process stock would save (hardening DF64, docs/modes/safe-links.md
// § Problem). A throwaway measurement, not part of the app: it reads the exported text, not the
// plan, so tool shapes are flat discs and the stock starts flat at Z0.
//
// Run: node scripts/measure-links.mjs <file.nc> [--rate 3000,3000,1000] [--accel 150,150,100]
//        [--margin 2] [--xy 1] [--clamp 12] [--stock 250x100]
// Rates in mm/min, accelerations in mm/s² (default: the user's 3020 machine). Prints one JSON
// object. --margin: vertical margin (mm), --xy: radial margin (mm), --clamp: clamp height (mm).

import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const file = args[0]
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? dflt : args[i + 1]
}
const rate = opt('rate', '3000,3000,1000')
  .split(',')
  .map((v) => Number(v) / 60)
const accel = opt('accel', '150,150,100').split(',').map(Number)
const margin = Number(opt('margin', '2'))
const clampH = Number(opt('clamp', '12'))
const RES = 0.5
const xyMargin = Number(opt('xy', '1'))

const text = readFileSync(file, 'utf8').split(/\r?\n/)
const tools = new Map()
let stock
for (const l of text) {
  const t = /^\(Tool (\d+): .*, dia ([\d.]+) (mm|in)/.exec(l)
  if (t) tools.set(Number(t[1]), Number(t[2]) * (t[3] === 'in' ? 25.4 : 1))
  const s = /^\(Stock X ([\d.]+) Y ([\d.]+) Z ([\d.]+) (mm|in)/.exec(l)
  if (s) stock = [Number(s[1]), Number(s[2])]
}
if (opt('stock')) stock = opt('stock').split('x').map(Number)
const inch = text.some((l) => /^G90 G94 G17 G20/.test(l))
const k = inch ? 25.4 : 1

// ── Parse into moves ────────────────────────────────────────────────────────────────────────
const moves = [] // { kind: 'rapid'|'feed', from, to, f, tool, toolChange? }
let pos = [undefined, undefined, undefined]
let motion = 0
let feed = 0
let tool = 1
let clearanceZ
let pendingChange = false
for (const raw of text) {
  const marker = /^\(DFYOM TOOL CHANGE (\d+)/.exec(raw)
  if (marker) {
    tool = Number(marker[1])
    pendingChange = true
    continue
  }
  const line = raw
    .replace(/\(.*?\)/g, '')
    .replace(/;.*/, '')
    .trim()
  if (line === '') continue
  if (/^M0\b/.test(line)) pendingChange = true
  const words = {}
  for (const m of line.matchAll(/([A-Z])(-?[\d.]+)/g)) {
    if (m[1] === 'G') {
      const g = Number(m[2])
      if (g <= 3) motion = g
    } else words[m[1]] = Number(m[2])
  }
  if (words.F !== undefined) feed = words.F * k
  if (words.X === undefined && words.Y === undefined && words.Z === undefined) continue
  const to = [
    words.X !== undefined ? words.X * k : pos[0],
    words.Y !== undefined ? words.Y * k : pos[1],
    words.Z !== undefined ? words.Z * k : pos[2],
  ]
  if (clearanceZ === undefined && motion === 0 && words.Z !== undefined) clearanceZ = to[2]
  if (pos.some((v) => v === undefined) || to.some((v) => v === undefined)) {
    pos = to
    continue
  }
  if (motion === 0)
    moves.push({ kind: 'rapid', from: pos, to, tool, toolChange: pendingChange || undefined })
  else if (motion === 1) moves.push({ kind: 'feed', from: pos, to, f: feed, tool })
  else {
    // arc as chords
    const cx = pos[0] + (words.I ?? 0) * k
    const cy = pos[1] + (words.J ?? 0) * k
    const r = Math.hypot(pos[0] - cx, pos[1] - cy)
    let a0 = Math.atan2(pos[1] - cy, pos[0] - cx)
    let a1 = Math.atan2(to[1] - cy, to[0] - cx)
    let sweep = a1 - a0
    if (motion === 2 && sweep >= -1e-12) sweep -= 2 * Math.PI
    if (motion === 3 && sweep <= 1e-12) sweep += 2 * Math.PI
    const n = Math.max(1, Math.ceil((Math.abs(sweep) * r) / 0.5))
    let prev = pos
    for (let i = 1; i <= n; i++) {
      const t = i / n
      const p =
        i === n
          ? to
          : [
              cx + r * Math.cos(a0 + sweep * t),
              cy + r * Math.sin(a0 + sweep * t),
              pos[2] + (to[2] - pos[2]) * t,
            ]
      moves.push({ kind: 'feed', from: prev, to: p, f: feed, tool })
      prev = p
    }
  }
  pendingChange = false
  pos = to
}

// ── Timing (GRBL-like: per-axis rate and acceleration, rest to rest per rapid chain) ──────────
const rapidTime = (a, b) => {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const L = Math.hypot(...d)
  if (L < 1e-9) return 0
  let v = Infinity
  let acc = Infinity
  for (let i = 0; i < 3; i++) {
    const u = Math.abs(d[i]) / L
    if (u > 1e-12) {
      v = Math.min(v, rate[i] / u)
      acc = Math.min(acc, accel[i] / u)
    }
  }
  return L >= (v * v) / acc ? L / v + v / acc : 2 * Math.sqrt(L / acc)
}
/** Time of a polyline of rapids, collinear legs merged (GRBL blends them at full speed). */
const chainTime = (pts) => {
  const merged = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]
    const a = merged[merged.length - 1]
    if (Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]) < 1e-9) continue
    if (merged.length >= 2) {
      const o = merged[merged.length - 2]
      const u = [a[0] - o[0], a[1] - o[1], a[2] - o[2]]
      const w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
      const cross = Math.hypot(
        u[1] * w[2] - u[2] * w[1],
        u[2] * w[0] - u[0] * w[2],
        u[0] * w[1] - u[1] * w[0],
      )
      const dot = u[0] * w[0] + u[1] * w[1] + u[2] * w[2]
      if (cross < 1e-9 * Math.hypot(...u) * Math.hypot(...w) && dot > 0) {
        merged[merged.length - 1] = p
        continue
      }
    }
    merged.push(p)
  }
  let t = 0
  for (let i = 1; i < merged.length; i++) t += rapidTime(merged[i - 1], merged[i])
  return t
}
const zTravel = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.abs(p[2] - pts[i][2]), 0)

// ── Grids: in-process stock heights and the cleared footprint ───────────────────────────────
let minX = Infinity
let minY = Infinity
let maxX = -Infinity
let maxY = -Infinity
for (const m of moves)
  for (const p of [m.from, m.to]) {
    minX = Math.min(minX, p[0])
    minY = Math.min(minY, p[1])
    maxX = Math.max(maxX, p[0])
    maxY = Math.max(maxY, p[1])
  }
const pad = 20
const ox = Math.min(minX, 0) - pad
const oy = Math.min(minY, 0) - pad
const nx = Math.ceil((Math.max(maxX, stock?.[0] ?? 0) + pad - ox) / RES)
const ny = Math.ceil((Math.max(maxY, stock?.[1] ?? 0) + pad - oy) / RES)
const height = new Float64Array(nx * ny).fill(-1e9)
const cleared = new Uint8Array(nx * ny)
const inStock = new Uint8Array(nx * ny)
// cut footprint bbox stands in for the stock when the header has no stock line (older goldens)
const sx = stock ?? [maxX, maxY]
for (let j = 0; j < ny; j++)
  for (let i = 0; i < nx; i++) {
    const x = ox + (i + 0.5) * RES
    const y = oy + (j + 0.5) * RES
    if (x >= 0 && x <= sx[0] && y >= 0 && y <= sx[1]) {
      height[j * nx + i] = 0
      inStock[j * nx + i] = 1
    }
  }
const discCache = new Map()
const disc = (r) => {
  const key = r.toFixed(3)
  if (!discCache.has(key)) {
    const n = Math.ceil(r / RES)
    const out = []
    for (let dj = -n; dj <= n; dj++)
      for (let di = -n; di <= n; di++)
        if (Math.hypot(di, dj) * RES <= r + RES * 0.5) out.push([di, dj])
    discCache.set(key, out)
  }
  return discCache.get(key)
}
const sweep = (a, b, r, fn) => {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1])
  const n = Math.max(1, Math.ceil(L / (RES / 2)))
  const d = disc(r)
  for (let s = 0; s <= n; s++) {
    const t = s / n
    const ci = Math.floor((a[0] + (b[0] - a[0]) * t - ox) / RES)
    const cj = Math.floor((a[1] + (b[1] - a[1]) * t - oy) / RES)
    const z = a[2] + (b[2] - a[2]) * t
    for (const [di, dj] of d) {
      const i = ci + di
      const j = cj + dj
      if (i >= 0 && j >= 0 && i < nx && j < ny) fn(j * nx + i, z)
    }
  }
}
const radius = (m) => (tools.get(m.tool) ?? 6) / 2
for (const m of moves)
  if (m.kind === 'feed' && Math.min(m.from[2], m.to[2]) < 0)
    sweep(m.from, m.to, radius(m), (c) => (cleared[c] = 1))

// ── Walk: excursions (maximal runs of rapids) ───────────────────────────────────────────────
const variants = ['clearance', 'ideal', 'clearedOnly', 'clamp', 'stockTop']
const totals = {
  feedSeconds: 0,
  rapidSeconds: 0,
  links: 0,
  toolChanges: 0,
  withinOp: { count: 0, seconds: 0, zTravel: 0, lowSeconds: 0, lowZTravel: 0 },
}
for (const v of variants) totals[v] = { seconds: 0, zTravel: 0, atRetract: 0 }

let i = 0
while (i < moves.length) {
  const m = moves[i]
  if (m.kind === 'feed') {
    const L = Math.hypot(m.to[0] - m.from[0], m.to[1] - m.from[1], m.to[2] - m.from[2])
    totals.feedSeconds += L / (m.f / 60)
    if (Math.min(m.from[2], m.to[2]) < 0)
      sweep(m.from, m.to, radius(m), (c, z) => {
        if (z < height[c]) height[c] = z
      })
    i++
    continue
  }
  const run = []
  while (i < moves.length && moves[i].kind === 'rapid') run.push(moves[i++])
  const pts = [run[0].from, ...run.map((r) => r.to)]
  const t0 = chainTime(pts)
  totals.rapidSeconds += t0
  const top = Math.max(...pts.map((p) => p[2]))
  const change = run.some((r) => r.toolChange)
  if (change) {
    totals.toolChanges++
    continue
  }
  const S = pts[0]
  const E = pts[pts.length - 1]
  const xy = Math.hypot(E[0] - S[0], E[1] - S[1])
  if (Math.abs(top - clearanceZ) > 1e-6) {
    if (xy > 1e-6) {
      // within an operation: a rapid on the retract plane, then (pockets, profiles) a plunge at
      // the feed down to the previous level; the height field allows a link just above the cut
      let j = i
      while (
        j < moves.length &&
        moves[j].kind === 'feed' &&
        Math.hypot(moves[j].to[0] - E[0], moves[j].to[1] - E[1]) < 1e-6 &&
        moves[j].to[2] < moves[j].from[2]
      )
        j++
      const bottom = j > i ? moves[j - 1].to[2] : E[2]
      const f = j > i ? moves[i].f / 60 : Infinity
      const plunge = (z) => (z - bottom) / f
      totals.withinOp.count++
      totals.withinOp.seconds += t0 + plunge(E[2])
      totals.withinOp.zTravel += zTravel(pts) + (E[2] - bottom)
      const low = Math.min(top, Math.max(corridorMax(S, E, run[0]) + margin, bottom, S[2]))
      const alt = [S, [S[0], S[1], low], [E[0], E[1], low]]
      totals.withinOp.lowSeconds += chainTime(alt) + plunge(low)
      totals.withinOp.lowZTravel += zTravel(alt) + (low - bottom)
    }
    continue
  }
  if (i >= moves.length) continue // the footer retract
  totals.links++
  totals.clearance.seconds += t0
  totals.clearance.zTravel += zTravel(pts)
  const level = { ideal: -1e9, clearedOnly: -1e9, clamp: -1e9, stockTop: -1e9 }
  corridor(S, E, radius(run[0]), (c) => {
    const h = height[c]
    level.ideal = Math.max(level.ideal, h)
    level.clearedOnly = Math.max(level.clearedOnly, cleared[c] ? h : clearanceZ - margin)
    level.clamp = Math.max(level.clamp, cleared[c] ? h : Math.max(h, clampH))
    level.stockTop = Math.max(level.stockTop, inStock[c] || cleared[c] ? h : clearanceZ - margin)
  })
  for (const v of Object.keys(level)) {
    let z = Math.max(level[v] + margin, E[2])
    if (z >= clearanceZ) z = clearanceZ
    const alt = [S, [S[0], S[1], z], [E[0], E[1], z], E]
    totals[v].seconds += chainTime(alt)
    totals[v].zTravel += zTravel(alt)
    if (Math.abs(z - E[2]) < 1e-6) totals[v].atRetract++
  }
}

function corridorMax(S, E, m) {
  let h = -1e9
  corridor(S, E, radius(m), (c) => {
    h = Math.max(h, height[c])
  })
  return h
}

/**
 * The cells under the tool disc grown by the radial margin along S → E, without the cells under
 * the tool at either end: the tool stands at S (its column is clear above it) and the generator
 * descends at E through air, so the radial margin applies only on the way.
 */
function corridor(S, E, r, fn) {
  const R = r + xyMargin
  sweep([S[0], S[1], 0], [E[0], E[1], 0], R, (c) => {
    const x = ox + ((c % nx) + 0.5) * RES
    const y = oy + (Math.floor(c / nx) + 0.5) * RES
    // R + RES: the disc stamp's own rasterisation slop
    const ends = R + RES * 1.5
    if (Math.hypot(x - S[0], y - S[1]) <= ends || Math.hypot(x - E[0], y - E[1]) <= ends) return
    fn(c)
  })
}

const round = (o) =>
  JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)))
console.log(
  JSON.stringify(
    round({
      file: file.split('/').pop(),
      clearanceZ,
      stock,
      programMinutesApprox: (totals.feedSeconds + totals.rapidSeconds) / 60,
      ...totals,
    }),
  ),
)
