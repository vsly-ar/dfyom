// The Presets menu's thumbnails (design review U9 P5): a few cells of each preset in its lattice,
// as the Cell and Boundary options' mini outlines (`MiniOutline`). Pure: the preset's sources are
// read as millimetres (they are metric, presets.ts), the cell drawn at the preset's proportions
// and rotation, its neighbours at the lattice's pitch (cell extent + gap). Not to scale with the
// part; a picture of the arrangement.
// Doc: docs/conventions/ui.md#pattern-inspector-p1
import type { PatternPreset } from '../../../../core/design/pattern/presets'

type Vec = [number, number]
export type ThumbLoop = { elements: { kind: 'line'; a: Vec; b: Vec }[]; closed: boolean }

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

/** The preset's cell outline, centred on the origin, rotated. */
export function cellPoints(cell: Readonly<Record<string, string>>): Vec[] {
  let pts: Vec[]
  switch (cell['kind']) {
    case 'circle': {
      const r = num(cell['diameter'], 6) / 2
      pts = arc([0, 0], r, 0, 360 - 360 / 24, 24)
      break
    }
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
      pts = arc([0, 0], r, 0, 360 - 360 / n, n)
      break
    }
    default:
      pts = arc([0, 0], 3, 0, 345, 24)
  }
  const a = (num(cell['rotation']) * Math.PI) / 180
  const [c, s] = [Math.cos(a), Math.sin(a)]
  return pts.map(([x, y]) => [x * c - y * s, x * s + y * c])
}

const loop = (pts: readonly Vec[]): ThumbLoop => ({
  closed: true,
  elements: pts.map((a, i) => ({ kind: 'line' as const, a, b: pts[(i + 1) % pts.length]! })),
})

/**
 * A few cells of the preset in its lattice: two rows of three (staggered and hex: the second row
 * shifted half a pitch; hex rows √3/2 of the pitch apart, square and staggered the cell's height
 * plus the gap).
 */
export function presetLoops(preset: PatternPreset): ThumbLoop[] {
  const { cell, lattice, spacing } = preset.args
  const pts = cellPoints(cell)
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const w = Math.max(...xs) - Math.min(...xs)
  const h = Math.max(...ys) - Math.min(...ys)
  const gap = num(spacing.gap)
  const px = w + gap
  const py = lattice === 'hex' ? Math.max((px * Math.sqrt(3)) / 2, h + gap) : h + gap
  const shift = lattice === 'square' ? 0 : px / 2
  const out: ThumbLoop[] = []
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < 3; col++) {
      const ox = col * px + (row % 2 === 1 ? shift : 0)
      const oy = row * py
      out.push(loop(pts.map(([x, y]) => [x + ox, y + oy] as Vec)))
    }
  return out
}
