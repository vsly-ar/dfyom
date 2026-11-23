// View cube math (B25): the 26 regions of a chamfered cube (6 faces, 12 edges, 8 corners), the
// view each region looks from (face views in the face-frame orientation), the setup view, which
// view the camera shows, and the region polygons the canvas draws and hit-tests. Pure.
// Doc: docs/conventions/ui-view-cube.md, docs/modes/design-v0.2.md#face-frame
import type { Placement } from '../../../core/geometry/model'
import { normalize, type ViewPreset } from './camera'
import { mix, parseAlpha, parseColour, FALLBACK, type Rgb } from './colours'
import type { Vec3 } from './mesh'

/** A region by the signs of its outward direction along X, Y, Z (each −1, 0 or 1, not all 0). */
export type CubeRegion = readonly [number, number, number]
export type RegionKind = 'face' | 'edge' | 'corner'

const SIGNS = [-1, 0, 1] as const

/** All 26 regions: faces first (Top, Bottom, Front, Right, Back, Left), then edges, then corners. */
export const CUBE_REGIONS: readonly CubeRegion[] = (() => {
  const all: CubeRegion[] = []
  for (const z of SIGNS)
    for (const y of SIGNS) for (const x of SIGNS) if (x || y || z) all.push([x, y, z])
  const faces: CubeRegion[] = [
    [0, 0, 1],
    [0, 0, -1],
    [0, -1, 0],
    [1, 0, 0],
    [0, 1, 0],
    [-1, 0, 0],
  ]
  const count = (r: CubeRegion): number => r.filter((s) => s !== 0).length
  return [...faces, ...all.filter((r) => count(r) === 2), ...all.filter((r) => count(r) === 3)]
})()

export function regionKind(r: CubeRegion): RegionKind {
  const n = r.filter((s) => s !== 0).length
  return n === 1 ? 'face' : n === 2 ? 'edge' : 'corner'
}

/** Stable key ("1,-1,1"), for React keys and comparisons. */
export const regionKey = (r: CubeRegion): string => r.join(',')

export const sameRegion = (a: CubeRegion | null | undefined, b: CubeRegion | null | undefined) =>
  !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]

/** The named views (keys 1–4, Shift+1–3, the Views menu) and their regions. */
export const PRESET_REGION: Readonly<Record<ViewPreset, CubeRegion>> = {
  top: [0, 0, 1],
  front: [0, -1, 0],
  right: [1, 0, 0],
  iso: [1, -1, 1],
  bottom: [0, 0, -1],
  back: [0, 1, 0],
  left: [-1, 0, 0],
}

/** The named view of a region, if it has one (faces and the front-right-top corner). */
export function regionPreset(r: CubeRegion): ViewPreset | undefined {
  return (Object.keys(PRESET_REGION) as ViewPreset[]).find((p) => sameRegion(PRESET_REGION[p], r))
}

const Z: Vec3 = [0, 0, 1]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const clean = (v: Vec3): Vec3 => [v[0] || 0, v[1] || 0, v[2] || 0]

/**
 * The face frame's `v` of a face direction (design-v0.2.md § Face frame): what is up on screen in
 * that face's view. Sides: +Z; top: +Y; bottom: −Y (the part rolled over the X axis).
 */
export function faceUp(normal: Vec3): Vec3 {
  if (normal[2] > 0.5) return [0, 1, 0]
  if (normal[2] < -0.5) return [0, -1, 0]
  return Z
}

/** The face frame's `u` (right on screen): `v × n`. */
export function faceRight(normal: Vec3): Vec3 {
  return clean(cross(faceUp(normal), normal))
}

/**
 * Screen up of a camera looking from `direction` (target → camera) whose up vector is
 * `cameraUp`: `cameraUp` without its part along the view axis. Undefined along the axis.
 */
export function screenUp(direction: Vec3, cameraUp: Vec3 = Z): Vec3 | undefined {
  const d = normalize(direction)
  const k = dot(cameraUp, d)
  const v: Vec3 = [cameraUp[0] - k * d[0], cameraUp[1] - k * d[1], cameraUp[2] - k * d[2]]
  return Math.hypot(...v) < 1e-9 ? undefined : normalize(v)
}

/**
 * A view: look from `direction` (unit, target → camera) with `up` up on screen. `cameraUp` is the
 * camera's up vector for it: +Z (the viewport's orbit axis) except for a side setup turned about
 * the spindle, whose screen up is horizontal.
 */
export interface CubeView {
  readonly direction: Vec3
  readonly up: Vec3
  readonly cameraUp: Vec3
}

/** The view of a region (ui-view-cube.md C2, C3). */
export function regionView(r: CubeRegion): CubeView {
  const direction = normalize([r[0], r[1], r[2]])
  const up = regionKind(r) === 'face' ? faceUp(direction) : (screenUp(direction) ?? Z)
  return { direction, up, cameraUp: Z }
}

/**
 * The setup view (C7): down the spindle axis onto the setup's up face (`frame.n`), WCS X right and
 * Y up (`frame.u`, `frame.v`), as the operator sees the machine table.
 */
export function setupView(frame: Placement): CubeView {
  const n = normalize(frame.n)
  const v = normalize(frame.v)
  const vertical = Math.abs(n[2]) > 0.5
  return { direction: n, up: v, cameraUp: vertical || v[2] > 0.5 ? Z : v }
}

/** Tilt away from the pole of the orbit axis, where the azimuth is undefined. */
export const POLE_TILT = 1e-3

/**
 * Where the camera goes (unit, target → camera) for a view: its direction, except along the
 * camera's up axis (top and bottom), where it tilts by `POLE_TILT` so the screen up comes out as
 * the view's `up` (the tilt is away from `up` above, towards it below).
 */
export function cameraDirection(view: CubeView): Vec3 {
  const d = view.direction
  const k = dot(d, view.cameraUp)
  if (Math.abs(k) < 1 - 1e-9) return d
  const s = Math.sign(k) * POLE_TILT
  return normalize([d[0] - s * view.up[0], d[1] - s * view.up[1], d[2] - s * view.up[2]])
}

/** The camera direction of a named view (keys, menu, the first framing from Iso). */
export function presetDirection(preset: ViewPreset): Vec3 {
  return cameraDirection(regionView(PRESET_REGION[preset]))
}

// --- Which view the camera shows ---

/** Direction tolerance: the camera looks "exactly" along a view within this angle. */
export const VIEW_ANGLE_TOLERANCE = (0.5 * Math.PI) / 180
/** Screen-up tolerance (roll), looser: only a turned view must count as another view. */
export const ROLL_TOLERANCE = (1 * Math.PI) / 180

/** The camera's orientation: `back` = target → camera (unit), `up` = screen up (unit). */
export interface CameraAxes {
  readonly back: Vec3
  readonly up: Vec3
}

export function looksAlong(camera: CameraAxes, direction: Vec3): boolean {
  return dot(normalize(camera.back), direction) >= Math.cos(VIEW_ANGLE_TOLERANCE)
}

/** True when the camera shows `view`: same direction and the same screen up. */
export function showsView(camera: CameraAxes, view: CubeView): boolean {
  return (
    looksAlong(camera, view.direction) &&
    dot(normalize(camera.up), view.up) >= Math.cos(ROLL_TOLERANCE)
  )
}

/** The region the camera looks exactly along (roll ignored), for the amber outline. */
export function regionAlong(camera: CameraAxes): CubeRegion | undefined {
  return CUBE_REGIONS.find((r) => looksAlong(camera, regionView(r).direction))
}

/** What the camera shows, for the text summary ("View: Front"). */
export type ShownView =
  | { readonly kind: 'region'; readonly region: CubeRegion }
  | { readonly kind: 'setup' }
  | { readonly kind: 'custom' }

/**
 * The view the camera shows: a region's view (direction and roll as a click on it gives), else
 * the setup view (when there is a setup), else custom. A setup view equal to a region's view
 * (an unrotated top setup) is named by the region.
 */
export function shownView(camera: CameraAxes, setup: CubeView | null = null): ShownView {
  const region = CUBE_REGIONS.find((r) => showsView(camera, regionView(r)))
  if (region) return { kind: 'region', region }
  if (setup && showsView(camera, setup)) return { kind: 'setup' }
  return { kind: 'custom' }
}

export function sameShownView(a: ShownView, b: ShownView): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== 'region' || sameRegion(a.region, (b as typeof a).region)
}

// --- Names (ui-view-cube.md § Look: tooltips, the summary; the words are in messages/viewport) ---

export type RegionWord = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'

/** The words naming a region: vertical, then front/back, then left/right ("top front right"). */
export function regionWords(r: CubeRegion): RegionWord[] {
  const vertical = r[2] > 0 ? 'top' : r[2] < 0 ? 'bottom' : undefined
  const depth = r[1] < 0 ? 'front' : r[1] > 0 ? 'back' : undefined
  const lateral = r[0] < 0 ? 'left' : r[0] > 0 ? 'right' : undefined
  return [vertical, depth, lateral].filter((w): w is RegionWord => w !== undefined)
}

/** The keyboard shortcut of a region's view (faces and the Iso corner), as shown in tooltips. */
export const PRESET_SHORTCUT: Readonly<Record<ViewPreset, string>> = {
  top: '1',
  front: '2',
  right: '3',
  iso: '4',
  bottom: 'Shift+1',
  back: 'Shift+2',
  left: 'Shift+3',
}

export function regionShortcut(r: CubeRegion): string | undefined {
  const p = regionPreset(r)
  return p ? PRESET_SHORTCUT[p] : undefined
}

/** The face region of a direction vector (the setup's up face), if it is axis-aligned. */
export function faceRegionOf(direction: Vec3): CubeRegion | undefined {
  const r = direction.map((c) => (Math.abs(c) > 0.5 ? Math.sign(c) : 0)) as unknown as CubeRegion
  return regionKind(r) === 'face' && r.some((s) => s !== 0) ? r : undefined
}

// --- Geometry (drawn and hit-tested by the canvas) ---

/** Chamfer: 18 % of the edge (ui-view-cube.md § Look), in half-edge units: 0.36. */
export const CHAMFER = 0.36

/**
 * The polygon of a region on a cube of half-edge 1 with chamfer depth `chamfer`, counter-clockwise
 * seen from outside: a face is a square, an edge a strip, a corner a triangle. A face's vertices
 * start at its lower-left corner in the face frame (`u` right, `v` up).
 */
export function regionPolygon(r: CubeRegion, chamfer = CHAMFER): Vec3[] {
  const e = 1 - chamfer
  const kind = regionKind(r)
  let points: Vec3[]
  if (kind === 'face') {
    const n: Vec3 = [r[0], r[1], r[2]]
    const u = faceRight(n)
    const v = faceUp(n)
    const at = (a: number, b: number): Vec3 =>
      clean([n[0] + a * u[0] + b * v[0], n[1] + a * u[1] + b * v[1], n[2] + a * u[2] + b * v[2]])
    points = [at(-e, -e), at(e, -e), at(e, e), at(-e, e)]
  } else if (kind === 'edge') {
    const [i, j] = [0, 1, 2].filter((k) => r[k] !== 0) as [number, number]
    const k = 3 - i - j
    const point = (onI: boolean, t: number): Vec3 => {
      const p = [0, 0, 0]
      p[i] = onI ? r[i]! : r[i]! * e
      p[j] = onI ? r[j]! * e : r[j]!
      p[k] = t
      return p as unknown as Vec3
    }
    points = [point(true, -e), point(true, e), point(false, e), point(false, -e)]
  } else {
    points = [0, 1, 2].map((full) => r.map((s, k) => (k === full ? s : s * e)) as unknown as Vec3)
  }
  const [a, b, c] = points as [Vec3, Vec3, Vec3]
  const normal = cross(
    [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
  )
  return dot(normal, [r[0], r[1], r[2]]) < 0 ? points.reverse() : points
}

// --- Colours (ui-view-cube.md § Look: every colour a token) ---

/** The tokens the cube reads besides the viewport palette (the axis colours come from there). */
export const CUBE_TOKENS = {
  face: '--bg-raised',
  hover: '--bg-hover',
  edge: '--border-control',
  accent: '--accent',
  text: '--text',
  muted: '--text-muted',
} as const

export interface CubeColours {
  readonly face: Rgb
  /** `--bg-hover` channels and alpha: composited over the hovered region. */
  readonly hover: Rgb
  readonly hoverAlpha: number
  readonly edge: Rgb
  readonly accent: Rgb
  readonly text: Rgb
  readonly muted: Rgb
}

export function cubeColours(values: Readonly<Record<string, string>>): CubeColours {
  const get = (k: keyof typeof CUBE_TOKENS): Rgb =>
    parseColour(values[CUBE_TOKENS[k]] ?? '') ?? FALLBACK
  return {
    face: get('face'),
    hover: get('hover'),
    hoverAlpha: parseAlpha(values[CUBE_TOKENS.hover] ?? ''),
    edge: get('edge'),
    accent: get('accent'),
    text: get('text'),
    muted: get('muted'),
  }
}

/** Light from the front-right-top (part frame): the flat shading step per orientation. */
const LIGHT = normalize([0.35, -0.6, 1])
/** Darkest step (a face turned fully away from the light), as a mix towards black. */
export const SHADE_MAX = 0.2

/**
 * A region's colour: `--bg-raised` with a slight lightness step per orientation (top lightest,
 * bottom darkest), so the cube reads as 3D; `hover` (0..1, animated) composites `--bg-hover`.
 */
export function regionColour(r: CubeRegion, colours: CubeColours, hover = 0): Rgb {
  const lit = (dot(normalize([r[0], r[1], r[2]]), LIGHT) + 1) / 2
  const shaded = mix(colours.face, [0, 0, 0], SHADE_MAX * (1 - lit))
  return mix(shaded, colours.hover, colours.hoverAlpha * Math.min(1, Math.max(0, hover)))
}

// --- Layout (the cube's square in the viewport's top right) ---

/** The cube's square: 5.5 rem (88 px at 100 %), its pointer area. */
export const CUBE_BOX_PX = 88
/** Its distance from the viewport's top and right edges (`--space-2`). */
export const CUBE_MARGIN_PX = 8
/**
 * The vertical Fit / Views toolbar right of the cube (DF19): its width (a 28 px button, 2 px
 * padding and a 1 px border each side) plus the `--space-1` gap before the cube's square.
 */
export const CUBE_TOOLBAR_PX = 38
/** Opacity of the cube while the pointer is outside its square (DF19). */
export const CUBE_IDLE_OPACITY = 0.5
/** Half the cube's edge in px: the chamfered silhouette (radius ≈ 1.35 × this) stays inside the box. */
export const CUBE_HALF_EDGE_PX = 28

/**
 * True when a pointer at `(x, y)` (client px) is inside the cube's square of a viewport whose
 * client rect is `rect`, with `insetRight` px of its right edge covered (the inspector overlay);
 * the square sits left of the cube's toolbar (`CUBE_TOOLBAR_PX`, DF19).
 */
export function inCubeBox(
  x: number,
  y: number,
  rect: { readonly top: number; readonly right: number },
  insetRight = 0,
): boolean {
  const right = rect.right - CUBE_MARGIN_PX - CUBE_TOOLBAR_PX - insetRight
  const top = rect.top + CUBE_MARGIN_PX
  return x <= right && x >= right - CUBE_BOX_PX && y >= top && y <= top + CUBE_BOX_PX
}
