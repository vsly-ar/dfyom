/**
 * Units and the root viewport of an SVG import: lengths with CSS units, `viewBox` and
 * `preserveAspectRatio` → the affine map from user units to the shape frame in mm (x right, y up,
 * origin at the bottom-left corner of the viewport).
 * Doc: docs/architecture/shapes.md#svg-import, docs/modes/design-v0.3.md#svg-import
 */
import type { Affine } from './transform'

/** What one user unit is when the file gives no absolute size (option `unit`). */
export type SvgUnit = 'mm' | 'in' | 'px96' | 'px72'

/** mm per CSS unit. `px` is 1/96 in (CSS); a bare number is a user unit. */
export const MM_PER: Readonly<Record<string, number>> = {
  mm: 1,
  cm: 10,
  q: 0.25,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
  px: 25.4 / 96,
}

export const MM_PER_USER_UNIT: Readonly<Record<SvgUnit, number>> = {
  mm: 1,
  in: 25.4,
  px96: 25.4 / 96,
  px72: 25.4 / 72,
}

export interface Length {
  readonly value: number
  /** Lower case unit; '' for a bare number. */
  readonly unit: string
}

const LENGTH = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z%]*)\s*$/

export function parseLength(s: string | undefined): Length | undefined {
  if (s === undefined) return undefined
  const m = LENGTH.exec(s)
  if (!m) return undefined
  const value = Number(m[1])
  const unit = m[2]!.toLowerCase()
  if (!Number.isFinite(value)) return undefined
  if (unit !== '' && unit !== '%' && MM_PER[unit] === undefined) return undefined
  return { value, unit }
}

/**
 * A length attribute inside the drawing in user units (`px` and bare numbers are user units;
 * absolute units convert at 96 user units per inch, as CSS does). Undefined for a missing,
 * malformed or relative (`%`, `em`) value.
 */
export function userLength(s: string | undefined): number | undefined {
  const l = parseLength(s)
  if (!l || l.unit === '%') return undefined
  if (l.unit === '' || l.unit === 'px') return l.value
  return (l.value * MM_PER[l.unit]!) / MM_PER['px']!
}

export interface Viewport {
  /** User units → shape frame (mm, y up). */
  readonly matrix: Affine
  /** Viewport size in mm, when the file defines one. */
  readonly size?: { readonly width: number; readonly height: number }
  /** The unit the size was read in ('mm', 'in', …), or the option used for a unitless file. */
  readonly unit: string
  /** True when no absolute unit was found and the `unit` option (default px at 96 dpi) applied. */
  readonly assumed: boolean
  /** mm per user unit along x and y. */
  readonly scale: readonly [number, number]
}

export interface ViewportInput {
  readonly width?: string
  readonly height?: string
  readonly viewBox?: string
  readonly preserveAspectRatio?: string
}

export type ViewportError = 'viewBox' | 'size'

/**
 * The root viewport. Absolute `width`/`height` units give the size; bare numbers and `px` take
 * the `unit` option (the file then "assumes" a unit); the `viewBox` maps user units onto it with
 * `preserveAspectRatio` (default `xMidYMid meet`).
 */
export function rootViewport(
  input: ViewportInput,
  option: SvgUnit,
): { ok: Viewport } | { err: ViewportError } {
  const per = MM_PER_USER_UNIT[option]
  const w = parseLength(input.width)
  const h = parseLength(input.height)
  const toMm = (l: Length | undefined): number | undefined =>
    l === undefined || l.unit === '%'
      ? undefined
      : l.unit === '' || l.unit === 'px'
        ? l.value * per
        : l.value * MM_PER[l.unit]!
  const absolute = (l: Length | undefined): boolean =>
    l !== undefined && l.unit !== '' && l.unit !== 'px' && l.unit !== '%'
  const assumed = !absolute(w) && !absolute(h)
  const unit = assumed ? option : absolute(w) ? w!.unit : h!.unit
  let W = toMm(w)
  let H = toMm(h)
  if ((W !== undefined && !(W > 0)) || (H !== undefined && !(H > 0))) return { err: 'size' }

  let vb: [number, number, number, number] | undefined
  if (input.viewBox !== undefined && input.viewBox.trim() !== '') {
    const nums = input.viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    if (
      nums.length !== 4 ||
      nums.some((x) => !Number.isFinite(x)) ||
      !(nums[2]! > 0 && nums[3]! > 0)
    )
      return { err: 'viewBox' }
    vb = nums as [number, number, number, number]
  }

  // user units → viewport (mm, y down)
  let sx: number
  let sy: number
  let tx = 0
  let ty = 0
  if (vb) {
    const [vx, vy, vw, vh] = vb
    if (W === undefined && H === undefined) {
      W = vw * per
      H = vh * per
    } else if (W === undefined) W = (H! * vw) / vh
    else if (H === undefined) H = (W * vh) / vw
    sx = W / vw
    sy = H! / vh
    const par = (input.preserveAspectRatio ?? '').trim().split(/\s+/)
    const align = par[0] === 'defer' ? (par[1] ?? 'xMidYMid') : par[0] || 'xMidYMid'
    const slice = (par[0] === 'defer' ? par[2] : par[1]) === 'slice'
    if (align !== 'none') {
      const s = slice ? Math.max(sx, sy) : Math.min(sx, sy)
      sx = s
      sy = s
      const fx = align.startsWith('xMid') ? 0.5 : align.startsWith('xMax') ? 1 : 0
      const fy = align.endsWith('YMid') ? 0.5 : align.endsWith('YMax') ? 1 : 0
      tx = (W - vw * s) * fx
      ty = (H! - vh * s) * fy
    }
    tx -= vx * sx
    ty -= vy * sy
  } else {
    // no viewBox: user units are CSS px; a unitless file takes the option
    const s = assumed ? per : MM_PER['px']!
    sx = s
    sy = s
  }
  // flip y: shape frame y up, origin at the viewport's bottom-left (or y = 0 without a height)
  const flipAt = H ?? 0
  const matrix: Affine = [sx, 0, 0, -sy, tx, flipAt - ty]
  const size = W !== undefined && H !== undefined ? { width: W, height: H } : undefined
  return { ok: { matrix, unit, assumed, scale: [sx, sy], ...(size ? { size } : {}) } }
}
