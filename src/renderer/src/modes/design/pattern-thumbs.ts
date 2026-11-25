// The Presets menu's thumbnails (design review U9 P5): a window onto each preset's lattice, drawn
// like the Cell and Boundary options' mini outlines (`MiniOutline`'s size and strokes). Pure: the
// preset's sources are read as millimetres (they are metric, presets.ts), the cell drawn at the
// preset's proportions and rotation, its neighbours at the lattice's pitch (cell extent + gap);
// the window is about 2.4 pitches wide, so a cell is a readable few pixels and the arrangement
// shows, the cells at its edges cut by the box. P5: a flipped preset (Triangles) turns every other
// cell and nests them about half a cell apart.
// Doc: docs/conventions/ui.md#pattern-inspector-p1
import type { PatternPreset } from '../../../../core/design/pattern/presets'

type Vec = [number, number]

/** The thumbnail's size in px (MiniOutline's). */
export const THUMB = { w: 28, h: 18 } as const

/** "6 mm", "30°", "6" → the number (presets use mm and ° only). */
const num = (source: string | undefined, fallback = 0): number => {
  const n = Number.parseFloat(source ?? '')
  return Number.isFinite(n) ? n : fallback
}

/** Points of an arc from `from` to `to` degrees, `n` points including both ends. */
function arc(c: Vec, r: number, from: number, to: number, n: number): Vec[] {
  return Array.from({ length: n }, (_, i) => {
    const a = ((from + ((to - from) * i) / Math.max(n - 1, 1)) * Math.PI) / 180
    return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)] as Vec
  })
}

/** A rounded rectangle centred on the origin. */
function roundedRect(l: number, w: number, r: number): Vec[] {
  const rr = Math.min(Math.max(r, 0), l / 2, w / 2)
  if (rr <= 0)
    return [
      [-l / 2, -w / 2],
      [l / 2, -w / 2],
      [l / 2, w / 2],
      [-l / 2, w / 2],
    ]
  const x = l / 2 - rr
  const y = w / 2 - rr
  return [
    ...arc([x, -y], rr, -90, 0, 4),
    ...arc([x, y], rr, 0, 90, 4),
    ...arc([-x, y], rr, 90, 180, 4),
    ...arc([-x, -y], rr, 180, 270, 4),
  ]
}

/** The preset's cell outline (mm), centred on the origin, rotated. */
export function cellPoints(cell: Readonly<Record<string, string>>): Vec[] {
  let pts: Vec[]
  switch (cell['kind']) {
    case 'circle':
      pts = arc([0, 0], num(cell['diameter'], 6) / 2, 0, 360 - 360 / 24, 24)
      break
    case 'rectangle':
      pts = roundedRect(num(cell['length'], 10), num(cell['width'], 6), num(cell['cornerRadius']))
      break
    case 'obround': {
      const l = num(cell['length'], 12)
      const w = num(cell['width'], 5)
      pts = roundedRect(Math.max(l, w), w, w / 2)
      break
    }
    case 'polygon': {
      const n = Math.max(3, Math.round(num(cell['sides'], 6)))
      const d = num(cell['diameter'], 8)
      // across flats: the circumradius is the inradius over cos(π/n)
      const r = cell['across'] === 'corners' ? d / 2 : d / 2 / Math.cos(Math.PI / n)
      // a flat side at the bottom, as the core's polygon (y is down here: mirrored, P5)
      const start = 90 + 180 / n
      pts = arc([0, 0], r, start, start + 360 - 360 / n, n)
      break
    }
    default:
      pts = arc([0, 0], 3, 0, 345, 24)
  }
  const a = (num(cell['rotation']) * Math.PI) / 180
  const [c, s] = [Math.cos(a), Math.sin(a)]
  return pts.map(([x, y]) => [x * c - y * s, x * s + y * c])
}

/**
 * The cells of the preset's lattice that meet the thumbnail's window, in px (y down, THUMB box).
 * Rows are the cell's height plus the gap apart (hex: at least √3/2 of the pitch), every other
 * row shifted half a pitch (staggered, hex).
 */
export function presetThumb(preset: PatternPreset): Vec[][] {
  const { cell, lattice, spacing, alternate } = preset.args
  const pts = cellPoints(cell)
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const w = Math.max(...xs) - Math.min(...xs)
  const h = Math.max(...ys) - Math.min(...ys)
  const gap = num(spacing.gap)
  // P5: flipped neighbours nest (about half a cell apart, as triangles), every other cell turned
  const flip = alternate === 'flip'
  const px = flip ? w / 2 + gap : w + gap
  const py = lattice === 'hex' ? Math.max((px * Math.sqrt(3)) / 2, h + gap) : h + gap
  const shift = lattice === 'square' ? 0 : px / 2
  // the window: about 2.4 pitches across (a tall cell: one cell high), the thumbnail's aspect
  const scale = Math.min(THUMB.w / (2.4 * px), THUMB.h / (1.05 * h))
  const [ww, wh] = [THUMB.w / scale, THUMB.h / scale]
  const out: Vec[][] = []
  for (let row = -1; row * py < wh + py; row++)
    for (let col = -1; col * px < ww + px; col++) {
      // the first cell's centre a quarter pitch in from the window's corner
      const ox = px * 0.25 + col * px + (Math.abs(row) % 2 === 1 ? shift : 0)
      const oy = py * 0.3 + row * py
      if (ox + w / 2 < 0 || ox - w / 2 > ww || oy + h / 2 < 0 || oy - h / 2 > wh) continue
      const turn = flip && (((row + col) % 2) + 2) % 2 === 1 ? -1 : 1
      out.push(pts.map(([x, y]) => [(turn * x + ox) * scale, (turn * y + oy) * scale] as Vec))
    }
  return out
}
