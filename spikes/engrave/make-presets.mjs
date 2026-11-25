/* global console */
// Spike E0: writes the engraved-pattern preset SVGs (docs/modes/engraved-patterns.md#presets).
// Run: `node spikes/engrave/make-presets.mjs`. The SVG files are the shipped artefact; this script
// only reproduces them. Created for DFYOM, GPL-3.0-or-later.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'src/core/design/engraving/presets'
const f = (x) => {
  const s = (Math.round(x * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '')
  return s === '-0' ? '0' : s
}
const P = (p) => `${f(p[0])} ${f(p[1])}`
/** Stroke colour for a depth level 0..1 (1 = black = deepest). */
const grey = (level) => {
  const v = Math.round(255 * (1 - level))
  const h = v.toString(16).padStart(2, '0')
  return `#${h}${h}${h}`
}
/** Catmull-Rom through points → cubic Bézier path data. `closed` wraps. */
function smooth(pts, closed = false) {
  const n = pts.length
  const at = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))])
  let d = `M ${P(pts[0])}`
  const segs = closed ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += ` C ${P(c1)}, ${P(c2)}, ${P(p2)}`
  }
  return closed ? `${d} Z` : d
}
const path = (d, level, extra = '') =>
  `  <path d="${d}" stroke="${grey(level)}"${extra ? ` ${extra}` : ''}/>`
const circle = (c, r, level) =>
  `  <circle cx="${f(c[0])}" cy="${f(c[1])}" r="${f(r)}" stroke="${grey(level)}"/>`
function svg(name, desc, w, h, body, viewBox = `0 0 ${w} ${h}`) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- DFYOM engraved-pattern preset "${name}": ${desc}
     Depth: stroke darkness (black = deepest, light grey = shallow); data-level (0..1, one value
     or stops start → end) overrides the colour. Units: mm. Created for DFYOM, GPL-3.0-or-later. -->
<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="${viewBox}"
     fill="none" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round">
${body.join('\n')}
</svg>
`
}

const presets = {}

// ---- typical (tiles and single motifs) ----

/** Waves: one sine period per 20 × 10 cell; rows tile into continuous waves. */
{
  const pts = []
  for (let k = -2; k <= 18; k++)
    pts.push([(k * 20) / 16, 5 + 2.5 * Math.sin((k / 16) * 2 * Math.PI)])
  // keep the visible part 0..20 by trimming the phantom ends after smoothing
  const d = smooth(pts).split(' C ')
  const head = `M ${P(pts[2])}`
  const body = d
    .slice(3, 19)
    .map((c) => ` C ${c}`)
    .join('')
  presets['waves'] = svg('Waves', 'sine waves, tile 20 × 10 on a square lattice, gap 0', 20, 10, [
    path(head + body, 1),
  ])
}

/** Chevrons: two nested zigzags, the inner one shallower. */
presets['chevrons'] = svg(
  'Chevrons',
  'nested zigzags, tile 20 × 10, square lattice, gap 0',
  20,
  10,
  [path('M 0 2 L 5 7 L 10 2 L 15 7 L 20 2', 1), path('M 0 5 L 5 10 L 10 5 L 15 10 L 20 5', 0.5)],
)

/** Crosshatch: both diagonals of a 10 × 10 cell tile into a diamond grid. */
presets['crosshatch'] = svg(
  'Crosshatch',
  'diagonals, tile 10 × 10, square lattice, gap 0',
  10,
  10,
  [path('M 0 0 L 10 10', 0.8), path('M 10 0 L 0 10', 0.8)],
)

/** Scales: one arc per 12 × 6 cell on a staggered lattice. */
presets['scales'] = svg('Scales', 'fish scales, tile 12 × 6, staggered lattice, gap 0', 12, 6, [
  path('M 0 0 A 6 6 0 0 0 12 0', 1),
])

/** Seigaiha: three concentric half rings per 20 × 10 cell, staggered. */
presets['seigaiha'] = svg(
  'Seigaiha',
  'concentric waves, tile 20 × 10, staggered lattice, gap 0',
  20,
  10,
  [
    path('M 0 10 A 10 10 0 0 1 20 10', 1),
    path('M 3 10 A 7 7 0 0 1 17 10', 0.6),
    path('M 6 10 A 4 4 0 0 1 14 10', 0.35),
  ],
)

/** Basket weave: 2 × 2 blocks of three strokes, alternating direction and level. */
{
  const b = []
  for (let qy = 0; qy < 2; qy++)
    for (let qx = 0; qx < 2; qx++) {
      const x0 = qx * 8
      const y0 = qy * 8
      const horiz = (qx + qy) % 2 === 0
      for (let k = 0; k < 3; k++) {
        const o = 2 + k * 2
        b.push(
          horiz
            ? path(`M ${x0 + 1} ${y0 + o} L ${x0 + 7} ${y0 + o}`, 1)
            : path(`M ${x0 + o} ${y0 + 1} L ${x0 + o} ${y0 + 7}`, 0.55),
        )
      }
    }
  presets['basket-weave'] = svg(
    'Basket weave',
    'over/under blocks, tile 16 × 16, square lattice, gap 0',
    16,
    16,
    b,
  )
}

/** Greek key: a meander band, tile 20 × 12 along a row. */
presets['greek-key'] = svg(
  'Greek key',
  'meander border, tile 20 × 12, one row (square lattice), gap 0',
  20,
  12,
  [path('M 0 10 L 16 10 L 16 2 L 4 2 L 4 7 L 12 7 L 12 5 L 8 5', 1), path('M 16 10 L 20 10', 1)],
)

/** Vine: a single motif, a curved stem (deep), leaves (medium) and tapering veins. */
{
  const stem = [
    [2, 18],
    [12, 12],
    [24, 16],
    [36, 10],
    [48, 14],
    [58, 8],
  ]
  const b = [path(smooth(stem), 1, 'data-level="0.5 1 1 0.6"')]
  const leaf = (base, ang, len, w, level) => {
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    const tip = [base[0] + c * len, base[1] + s * len]
    // almond: two arcs through base and tip
    const half = len / 2
    const r = (half * half + w * w) / (2 * w)
    b.push(
      path(
        `M ${P(base)} A ${f(r)} ${f(r)} 0 0 1 ${P(tip)} A ${f(r)} ${f(r)} 0 0 1 ${P(base)} Z`,
        level,
      ),
    )
    b.push(
      path(
        `M ${P(base)} L ${P([base[0] + c * len * 0.85, base[1] + s * len * 0.85])}`,
        level,
        'data-level="0.6 0"',
      ),
    )
  }
  leaf([12, 12], -1.1, 9, 2.4, 0.6)
  leaf([18, 13.4], 1.3, 8, 2.2, 0.6)
  leaf([30, 13.2], -1.2, 8, 2.2, 0.6)
  leaf([36, 10], 1.25, 9, 2.4, 0.6)
  leaf([48, 14], -1.15, 7, 2, 0.6)
  leaf([52, 11.5], 1.2, 6, 1.8, 0.6)
  presets['vine'] = svg('Vine', 'a single motif: stem, leaves, tapering veins, 60 × 26', 60, 26, b)
}

/** Wood grain: flowing lines that fade in and out (data-level stops), tile 40 × 20. */
{
  const b = []
  for (let k = 0; k < 5; k++) {
    const y = 2 + k * 4
    // periodic over the 40 mm tile, so rows join seamlessly; phantom points keep the slope
    const pts = []
    for (let i = -1; i <= 9; i++) {
      const u = (i * 5) / 40
      pts.push([
        i * 5,
        y + 1.2 * Math.sin(2 * Math.PI * u + k * 1.7) + 0.5 * Math.sin(4 * Math.PI * u + k),
      ])
    }
    const segs = smooth(pts).split(' C ')
    const d =
      `M ${P(pts[1])}` +
      segs
        .slice(2, 10)
        .map((c) => ` C ${c}`)
        .join('')
    b.push(path(d, 1, `data-level="${k % 2 ? '0.1 0.8 0.8 0.1' : '0.2 1 0.6 0.2'}"`))
  }
  presets['wood-grain'] = svg(
    'Wood grain',
    'flowing lines with fade in/out, tile 40 × 20, square lattice',
    40,
    20,
    b,
  )
}

// ---- circular (round parts: coaster, lid, box top), Ø 80, centre at 0 0 ----

const round = (name, desc, body) => svg(name, desc, 80, 80, body, '-40 -40 80 80')

/** Rosette: twelve circles on a ring (overlapping petals) inside a border ring. */
{
  const b = [circle([0, 0], 36, 1)]
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * 2 * Math.PI
    b.push(circle([15 * Math.cos(a), 15 * Math.sin(a)], 15, 0.7))
  }
  b.push(circle([0, 0], 3, 1))
  presets['rosette'] = round(
    'Rosette',
    'twelve overlapping circles in a border ring, Ø 80, single at the centre',
    b,
  )
}

/** Sunburst: 36 rays fading outwards, long and short alternately, a centre disc ring. */
{
  const b = [circle([0, 0], 5, 1), circle([0, 0], 37, 0.8)]
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * 2 * Math.PI
    const r1 = k % 2 ? 26 : 34
    const c = Math.cos(a)
    const s = Math.sin(a)
    b.push(path(`M ${P([7 * c, 7 * s])} L ${P([r1 * c, r1 * s])}`, 1, 'data-level="1 0.1"'))
  }
  presets['sunburst'] = round('Sunburst', 'tapering rays (deep at the centre), Ø 80', b)
}

/** Ripples: concentric wavy rings, shallower outwards. */
{
  const b = []
  const rings = [8, 14, 20, 26, 32]
  rings.forEach((r, i) => {
    const pts = []
    const n = 48
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 2 * Math.PI
      const rr = r + 0.9 * Math.sin(12 * a + i * 0.8)
      pts.push([rr * Math.cos(a), rr * Math.sin(a)])
    }
    b.push(path(smooth(pts, true), 1 - i * 0.17))
  })
  b.push(circle([0, 0], 37, 1))
  presets['ripples'] = round('Ripples', 'concentric wavy rings, shallower outwards, Ø 80', b)
}

/** Mandala: 8 inner petals, 16 outer petals, two rings at three levels. */
{
  const b = [circle([0, 0], 4, 1), circle([0, 0], 18, 0.6), circle([0, 0], 37, 1)]
  const petal = (a, r0, r1, w, level) => {
    const p0 = [r0 * Math.cos(a), r0 * Math.sin(a)]
    const p1 = [r1 * Math.cos(a), r1 * Math.sin(a)]
    const half = (r1 - r0) / 2
    const r = (half * half + w * w) / (2 * w)
    b.push(
      path(`M ${P(p0)} A ${f(r)} ${f(r)} 0 0 1 ${P(p1)} A ${f(r)} ${f(r)} 0 0 1 ${P(p0)} Z`, level),
    )
  }
  for (let k = 0; k < 8; k++) petal((k / 8) * 2 * Math.PI, 5, 17, 3.2, 1)
  for (let k = 0; k < 16; k++) petal(((k + 0.5) / 16) * 2 * Math.PI, 19, 35, 2.6, 0.35)
  presets['mandala'] = round('Mandala', 'two rings of petals, three depth levels, Ø 80', b)
}

mkdirSync(OUT, { recursive: true })
for (const [name, text] of Object.entries(presets)) writeFileSync(join(OUT, `${name}.svg`), text)
console.log(Object.keys(presets).join(' '))
