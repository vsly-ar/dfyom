// The Presets menu's thumbnails (design review U9 P5): a window onto each preset's lattice, drawn
// like the Cell and Boundary options' mini outlines (`MiniOutline`'s size and strokes). Pure: the
// preset's sources are read as millimetres (they are metric, presets.ts), the cell drawn at the
// preset's proportions and rotation, its neighbours at the lattice's pitch (cell extent + gap);
// the window is about 2.4 pitches wide, so a cell is a readable few pixels and the arrangement
// shows, the cells at its edges cut by the box. P5: a flipped preset (Triangles) turns every other
// cell and nests them about half a cell apart. DF107: drawn at any size (the Presets dialog's
// previews), and a polar preset as rings of cells about the window's centre.
// Doc: docs/conventions/ui.md#pattern-inspector-p1, docs/modes/patterns.md#presets-dialog-and-more-presets-df107
import type { PatternPreset } from '../../../../core/design/pattern/presets'

type Vec = [number, number]

/** The thumbnail's size in px (MiniOutline's). */
export const THUMB = { w: 28, h: 18 } as const
/** The Presets dialog's preview size in px (DF107). */
export const PREVIEW = { w: 132, h: 84 } as const

type Box = { readonly w: number; readonly h: number }

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
 * The cells of the preset's lattice that meet the thumbnail's window, in px (y down, `box`:
 * THUMB by default). Rows are the cell's height plus the gap apart (hex: at least √3/2 of the
 * pitch), every other row shifted half a pitch (staggered, hex). Polar: rings about the centre.
 */
export function presetThumb(preset: PatternPreset, box: Box = THUMB): Vec[][] {
  const { cell, lattice, spacing, alternate } = preset.args
  const pts = cellPoints(cell)
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const w = Math.max(...xs) - Math.min(...xs)
  const h = Math.max(...ys) - Math.min(...ys)
  const gap = num(spacing.gap)
  if (lattice === 'polar') return polarThumb(pts, Math.max(w, h) + gap, box)
  // P5: flipped neighbours nest (about half a cell apart, as triangles), every other cell turned
  const flip = alternate === 'flip'
  const px = flip ? w / 2 + gap : w + gap
  const py = lattice === 'hex' ? Math.max((px * Math.sqrt(3)) / 2, h + gap) : h + gap
  const shift = lattice === 'square' ? 0 : px / 2
  // the window: about 2.4 pitches across (a tall cell: one cell high), the thumbnail's aspect
  // (a wider box shows more pitches: its width over THUMB's, as many again)
  const across = 2.4 * Math.max(1, box.w / THUMB.w / 2)
  const scale = Math.min(box.w / (across * px), box.h / (1.05 * h))
  const [ww, wh] = [box.w / scale, box.h / scale]
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

/**
 * A polar lattice: one cell at the centre, then rings `pitch` apart, each with as many cells as
 * fit at the pitch along it (the layout's rule, P2), scaled so 1.4 rings fill half the height
 * (a wider box: as many more as the row lattices show).
 */
function polarThumb(pts: readonly Vec[], pitch: number, box: Box): Vec[][] {
  const rings = 1.4 * Math.max(1, box.w / THUMB.w / 2)
  const scale = box.h / (2 * rings * pitch)
  const [cx, cy] = [box.w / 2, box.h / 2]
  const reach = Math.hypot(box.w, box.h) / 2 / scale + pitch
  const out: Vec[][] = []
  for (let ring = 0; ring * pitch < reach; ring++) {
    const r = ring * pitch
    const n = ring === 0 ? 1 : Math.max(1, Math.floor((2 * Math.PI * r) / pitch))
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n
      const [ox, oy] = [cx + r * Math.cos(a) * scale, cy + r * Math.sin(a) * scale]
      const cell = pts.map(([x, y]) => [ox + x * scale, oy + y * scale] as Vec)
      if (cell.some(([x, y]) => x >= 0 && x <= box.w && y >= 0 && y <= box.h)) out.push(cell)
    }
  }
  return out
}
