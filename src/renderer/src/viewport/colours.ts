// Viewport colours: parse the `--vp-*` token values and colour surfaces by selection, hover, pick
// mode and evaluation status. Pure. Doc: docs/conventions/ui.md#colour, #selection-and-picking,
// #evaluation-status-pending-outdated-failed
import type { SurfaceId } from '../../../core/geometry/model'
import { surfaceOwner, triangleCount, type ViewportMesh } from './mesh'

/** sRGB, each channel 0..1. */
export type Rgb = readonly [number, number, number]

/** The tokens the viewport reads (ui.md#colour, viewport row). */
export const PALETTE_TOKENS = {
  background: '--bg-viewport',
  part: '--vp-part',
  stock: '--vp-stock',
  edge: '--vp-edge',
  selected: '--vp-selected',
  hover: '--vp-hover',
  outdated: '--vp-outdated',
  grid: '--vp-grid',
  gridMajor: '--vp-grid-major',
  axisX: '--vp-axis-x',
  axisY: '--vp-axis-y',
  axisZ: '--vp-axis-z',
  /** The error marker at a failing operation (task 3.6). */
  danger: '--danger',
  /** Tint of operations edited in the plan (snapshot scene, task E3b). */
  info: '--info',
  // run scene (task 3.12): toolpath playback and the tool marker
  feed: '--vp-feed',
  rapid: '--vp-rapid',
  tool: '--vp-tool',
  /** Plunges in the toolpath preview (task 3.7); falls back to `--vp-feed` if the token is missing. */
  plunge: '--vp-plunge',
} as const

/** Tokens that may be missing: they take another palette entry instead of `FALLBACK`. */
const OPTIONAL: Partial<Record<keyof typeof PALETTE_TOKENS, keyof typeof PALETTE_TOKENS>> = {
  plunge: 'feed',
}

export type PaletteKey = keyof typeof PALETTE_TOKENS
export type Palette = Readonly<Record<PaletteKey, Rgb>>

/** Used for a token that is missing or unparsable (visible on purpose: a token bug, not a theme). */
export const FALLBACK: Rgb = [1, 0, 1]

/**
 * Parses the colour forms `tokens.css` uses: `#rgb`, `#rrggbb` (`#rgba` / `#rrggbbaa`, alpha
 * ignored) and `rgb()` / `rgba()` with comma or space syntax. `undefined` for anything else.
 */
export function parseColour(value: string): Rgb | undefined {
  const s = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as unknown as Rgb
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(s)?.[1]
  if (fn === undefined) return undefined
  const parts = fn
    .split(/[\s,/]+/)
    .filter(Boolean)
    .slice(0, 3)
  if (parts.length < 3) return undefined
  const channels = parts.map((c) => (c.endsWith('%') ? (parseFloat(c) / 100) * 255 : parseFloat(c)))
  if (channels.some((c) => !Number.isFinite(c))) return undefined
  return channels.map((c) => Math.min(1, Math.max(0, c / 255))) as unknown as Rgb
}

/**
 * The alpha of a colour token value (`rgb(r g b / a)`, `rgba(r, g, b, a)`, `#rrggbbaa`, `#rgba`);
 * 1 when it has none or cannot be read. `parseColour` gives the channels.
 */
export function parseAlpha(value: string): number {
  const s = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/.exec(s)?.[1]
  if (hex) return parseInt(hex.length === 4 ? hex[3]!.repeat(2) : hex.slice(6), 16) / 255
  const fn = /^rgba?\(([^)]*)\)$/.exec(s)?.[1]
  if (fn === undefined) return 1
  const parts = fn.split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 4) return 1
  const a = parts[3]!.endsWith('%') ? parseFloat(parts[3]!) / 100 : parseFloat(parts[3]!)
  return Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 1
}

/** Token values (as `getComputedStyle` returns them) → palette; missing ones become `FALLBACK`. */
export function paletteFrom(values: Readonly<Record<string, string>>): Palette {
  const out = {} as Record<PaletteKey, Rgb>
  for (const key of Object.keys(PALETTE_TOKENS) as PaletteKey[]) {
    out[key] = parseColour(values[PALETTE_TOKENS[key]] ?? '') ?? FALLBACK
  }
  for (const [key, instead] of Object.entries(OPTIONAL) as [PaletteKey, PaletteKey][])
    if (parseColour(values[PALETTE_TOKENS[key]] ?? '') === undefined) out[key] = out[instead]
  return out
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** sRGB → linear (three.js vertex colours and lighting work in linear). */
export function toLinear(c: Rgb): Rgb {
  const f = (x: number): number => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
  return [f(c[0]), f(c[1]), f(c[2])]
}

/**
 * How much of `--vp-selected` tints a surface. Selection is a light tint plus an amber outline
 * (the accent is never a large fill, ui.md decision 18); pick mode tints eligible surfaces lightly
 * and the hovered eligible one strongly, and dims the rest towards the background.
 */
export const MIX = {
  selected: 0.25,
  pickEligible: 0.12,
  pickHover: 0.4,
  pickDimmed: 0.6,
  /** Start of the selection pulse (`--motion-emphasis`), easing back to `selected`. */
  pulse: 0.6,
  /** Operations edited in the plan (`--info`, a light tint: never the accent or a warning). */
  tinted: 0.3,
  /** Outdated toolpaths (stale or waiting for Apply) towards the background (task P3). */
  outdated: 0.55,
} as const

export interface SurfaceState {
  /** Operation (or `stock`) whose surfaces are selected. */
  readonly selectedOperation?: string | null | undefined
  /** Surface under the pointer. */
  readonly hovered?: SurfaceId | null | undefined
  /** Pick mode: the eligible surfaces; `null`/absent outside pick mode. */
  readonly pickEligible?: ReadonlySet<SurfaceId> | null | undefined
  /** `pending` after the indicator delay, or `failed`: the last mesh is tinted outdated. */
  readonly outdated?: boolean | undefined
  /** Selection pulse, 1 at a new selection easing to 0 (ui.md decision 24); 0 = none. */
  readonly pulse?: number | undefined
  /** Operations tinted `--info`: edited in the plan (plan scene, task E3b). */
  readonly tinted?: ReadonlySet<string> | null | undefined
}

/**
 * One surface's colour (sRGB). Outside pick mode, hover previews what a click selects: every
 * surface of the hovered surface's operation. In pick mode, hover is per surface and only on
 * eligible ones.
 */
export function surfaceColour(surface: SurfaceId, state: SurfaceState, palette: Palette): Rgb {
  const base = state.outdated ? palette.outdated : palette.part
  const owner = surfaceOwner(surface)
  if (state.pickEligible) {
    if (!state.pickEligible.has(surface)) return mix(base, palette.background, MIX.pickDimmed)
    if (state.hovered === surface) return mix(base, palette.selected, MIX.pickHover)
    return mix(base, palette.selected, MIX.pickEligible)
  }
  if (state.selectedOperation != null && owner === state.selectedOperation) {
    const p = Math.min(1, Math.max(0, state.pulse ?? 0))
    return mix(base, palette.selected, MIX.selected + p * (MIX.pulse - MIX.selected))
  }
  if (state.hovered != null && surfaceOwner(state.hovered) === owner) return palette.hover
  if (state.tinted?.has(owner)) return mix(base, palette.info, MIX.tinted)
  return base
}

/** Linear vertex colours for the non-indexed render geometry (9 floats per triangle). */
export function vertexColours(
  mesh: ViewportMesh,
  state: SurfaceState,
  palette: Palette,
  out: Float32Array = new Float32Array(triangleCount(mesh) * 9),
): Float32Array {
  const perSurface = mesh.surfaces.map((s) => toLinear(surfaceColour(s, state, palette)))
  const n = triangleCount(mesh)
  for (let t = 0; t < n; t++) {
    const c = perSurface[mesh.triangleSurface[t]!] ?? toLinear(FALLBACK)
    for (let k = 0; k < 3; k++) out.set(c, 9 * t + 3 * k)
  }
  return out
}

/** Whether a surface is drawn with the selection outline. */
export function isOutlined(surface: SurfaceId, state: SurfaceState): boolean {
  if (state.pickEligible) return state.hovered === surface && state.pickEligible.has(surface)
  return state.selectedOperation != null && surfaceOwner(surface) === state.selectedOperation
}
