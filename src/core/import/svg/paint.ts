/**
 * SVG paint → engraving level (engraved-patterns.md E2, § SVG encoding): a colour's level is
 * 1 − its Rec. 709 luma (black = 1 = deepest, white = 0), read from the opaque colour (opacity
 * and alpha are ignored); `data-level` gives one level or stops spread evenly from start to end.
 * Pure and headless.
 * Doc: docs/modes/engraved-patterns.md#svg-encoding, docs/modes/engraved-patterns.md#implementation-e2
 */

/** sRGB 0..255 and whether an alpha below 1 was given (it is ignored). */
export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly alpha: boolean
}

/** CSS named colours a drawing is likely to use for depth (greys and the basic colours). */
const NAMED: Readonly<Record<string, readonly [number, number, number]>> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105],
  darkgray: [169, 169, 169],
  darkgrey: [169, 169, 169],
  silver: [192, 192, 192],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  gainsboro: [220, 220, 220],
  whitesmoke: [245, 245, 245],
  red: [255, 0, 0],
  maroon: [128, 0, 0],
  orange: [255, 165, 0],
  yellow: [255, 255, 0],
  olive: [128, 128, 0],
  lime: [0, 255, 0],
  green: [0, 128, 0],
  aqua: [0, 255, 255],
  cyan: [0, 255, 255],
  teal: [0, 128, 128],
  blue: [0, 0, 255],
  navy: [0, 0, 128],
  fuchsia: [255, 0, 255],
  magenta: [255, 0, 255],
  purple: [128, 0, 128],
  brown: [165, 42, 42],
}

const channel = (s: string): number | undefined => {
  const t = s.trim()
  const pct = t.endsWith('%')
  const v = Number(pct ? t.slice(0, -1) : t)
  if (!Number.isFinite(v)) return undefined
  return Math.min(255, Math.max(0, pct ? (v * 255) / 100 : v))
}

/**
 * A CSS colour: a name of `NAMED`, `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` with
 * numbers or percentages (commas or spaces, `/ alpha`). Undefined for anything else (`none`,
 * `url(…)`, `currentColor`, unknown names).
 */
export function parseColour(s: string): Rgb | undefined {
  const t = s.trim().toLowerCase()
  const named = NAMED[t]
  if (named !== undefined) return { r: named[0], g: named[1], b: named[2], alpha: false }
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t)
  if (hex) {
    const h = hex[1]!
    const short = h.length <= 4
    const at = (i: number) =>
      short ? Number.parseInt(h[i]! + h[i]!, 16) : Number.parseInt(h.slice(2 * i, 2 * i + 2), 16)
    const alpha = (short ? h.length === 4 : h.length === 8) && at(3) < 255
    return { r: at(0), g: at(1), b: at(2), alpha }
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(t)
  if (fn) {
    const [rgb, a] = fn[1]!.split('/')
    const parts = rgb!.split(/[\s,]+/).filter((x) => x !== '')
    const alphaPart = a ?? (parts.length === 4 ? parts.pop() : undefined)
    if (parts.length !== 3) return undefined
    const [r, g, b] = parts.map(channel)
    if (r === undefined || g === undefined || b === undefined) return undefined
    const av = alphaPart === undefined ? 1 : Number(alphaPart.trim().replace(/%$/, ''))
    return {
      r,
      g,
      b,
      alpha: Number.isFinite(av) && av < (alphaPart?.trim().endsWith('%') ? 100 : 1),
    }
  }
  return undefined
}

/**
 * Level 0..1 of a colour: 1 − Rec. 709 luma of its sRGB values (black = 1, white = 0), rounded
 * to 1e-12 so white is exactly 0.
 */
export const levelOfRgb = (c: Rgb): number => {
  const l = 1 - (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255
  return Math.min(1, Math.max(0, Math.round(l * 1e12) / 1e12))
}

/** Level of a colour string; undefined when it is not a colour. */
export function levelOfColour(s: string | undefined): number | undefined {
  const c = s === undefined ? undefined : parseColour(s)
  return c === undefined ? undefined : levelOfRgb(c)
}

/**
 * `data-level`: one value or stops (spaces or commas), each 0..1; undefined when malformed or out
 * of range (the colour is used instead, with a warning).
 */
export function parseDataLevel(s: string): number[] | undefined {
  const parts = s
    .trim()
    .split(/[\s,]+/)
    .filter((x) => x !== '')
  if (parts.length === 0) return undefined
  const v = parts.map(Number)
  return v.every((x) => Number.isFinite(x) && x >= 0 && x <= 1) ? v : undefined
}

/** The level of stops spread evenly from start (u = 0) to end (u = 1), linear between. */
export function stopsAt(stops: readonly number[], u: number): number {
  if (stops.length === 1) return stops[0]!
  const x = Math.min(1, Math.max(0, u)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  return stops[i]! + (stops[i + 1]! - stops[i]!) * (x - i)
}
