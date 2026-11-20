// Camera math and input mapping: view presets, fit, mouse presets, viewport keys. Pure.
// The part frame is Z up (geometry.md); the camera's up is +Z.
// Doc: docs/conventions/ui.md#selection-and-picking (camera, decision 10)
import type { Box, Vec3 } from './mesh'

export const VIEW_PRESETS = ['top', 'front', 'right', 'iso'] as const
export type ViewPreset = (typeof VIEW_PRESETS)[number]

/** Vertical field of view of the perspective camera (degrees): low, close to a CAD ortho look. */
export const FOV_DEG = 30
/** Space around the fitted part (1 = touching the frame). */
export const FIT_MARGIN = 1.15

/**
 * Unit vector from the target towards the camera. Top looks down with +Y up on screen (a tiny
 * tilt towards −Y keeps the orbit away from the pole, where the azimuth is undefined); Front looks
 * along +Y; Right along −X; Iso from front-right-top.
 */
export function presetDirection(preset: ViewPreset): Vec3 {
  switch (preset) {
    case 'top':
      return normalize([0, -1e-3, 1])
    case 'front':
      return [0, -1, 0]
    case 'right':
      return [1, 0, 0]
    case 'iso':
      return normalize([1, -1, 1])
  }
}

export function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1]
}

export function boxCenter(box: Box): Vec3 {
  return [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ]
}

/** Radius of the box's bounding sphere (at least 1 mm, so an empty box still frames something). */
export function boxRadius(box: Box): number {
  const r =
    Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2
  return Math.max(r, 1)
}

/**
 * Camera distance that shows a sphere of `radius` whole in a perspective view of vertical field
 * of view `fovDeg` and `aspect` (width / height): the narrower of the two angles decides.
 */
export function fitDistance(
  radius: number,
  fovDeg: number = FOV_DEG,
  aspect = 1,
  margin = FIT_MARGIN,
): number {
  const vHalf = (fovDeg * Math.PI) / 360
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(aspect, 1e-3))
  return (radius * margin) / Math.sin(Math.min(vHalf, hHalf))
}

export interface CameraPose {
  readonly position: Vec3
  readonly target: Vec3
}

/** Looks at the box's centre from `direction`, far enough to fit it. */
export function fitPose(
  direction: Vec3,
  box: Box,
  aspect = 1,
  fovDeg: number = FOV_DEG,
): CameraPose {
  const target = boxCenter(box)
  const d = fitDistance(boxRadius(box), fovDeg, aspect)
  const n = normalize(direction)
  return { target, position: [target[0] + n[0] * d, target[1] + n[1] * d, target[2] + n[2] * d] }
}

// --- Mouse presets (ui.md decision 10) ---

export const MOUSE_PRESETS = ['default', 'fusion', 'blender'] as const
export type MousePreset = (typeof MOUSE_PRESETS)[number]
export type CameraAction = 'orbit' | 'pan' | 'none'

export interface ButtonMap {
  readonly left: CameraAction
  readonly middle: CameraAction
  readonly right: CameraAction
}

/**
 * The mapping table of ui.md: what a drag with each button does, given whether Shift is held.
 * The wheel always zooms to the cursor; a left click (no drag) always selects.
 */
export function mouseButtons(preset: MousePreset, shift: boolean): ButtonMap {
  switch (preset) {
    case 'default':
      return { left: 'orbit', middle: 'pan', right: 'pan' }
    case 'fusion':
      return { left: 'none', middle: shift ? 'orbit' : 'pan', right: 'none' }
    case 'blender':
      return { left: 'none', middle: shift ? 'pan' : 'orbit', right: 'none' }
  }
}

/** A press and release closer than this (px) is a click, not a drag. */
export const CLICK_TOLERANCE_PX = 4

export function isClick(
  down: { x: number; y: number } | null,
  up: { x: number; y: number },
): boolean {
  return down !== null && Math.hypot(up.x - down.x, up.y - down.y) <= CLICK_TOLERANCE_PX
}

// --- Keyboard (ui.md: keys 1–4 and F; arrows orbit, Shift+arrows pan, +/− zoom) ---

/** Orbit step per arrow key press (radians). */
export const ORBIT_STEP = Math.PI / 12
/** Pan step per Shift+arrow press, as a fraction of the camera distance. */
export const PAN_STEP = 0.1
/** Each +/− press moves the camera this fraction of its distance towards / away from the target. */
export const ZOOM_STEP = 0.2

export type ViewportKey =
  | { readonly kind: 'preset'; readonly preset: ViewPreset }
  | { readonly kind: 'fit' }
  | { readonly kind: 'orbit'; readonly azimuth: number; readonly polar: number }
  | { readonly kind: 'pan'; readonly x: number; readonly y: number }
  | { readonly kind: 'zoom'; readonly direction: 1 | -1 }
  | { readonly kind: 'escape' }

export interface KeyLike {
  readonly key: string
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
}

/**
 * What a key does in the focused viewport; `undefined` = not ours (Ctrl/Cmd/Alt combinations are
 * app shortcuts and pass through). `arrows` is false while focus is on a child control that uses
 * the arrow keys itself (the view toolbar's roving focus).
 */
export function viewportKey(e: KeyLike, arrows = true): ViewportKey | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined
  const preset = { '1': 'top', '2': 'front', '3': 'right', '4': 'iso' }[e.key] as
    ViewPreset | undefined
  if (preset) return { kind: 'preset', preset }
  switch (e.key) {
    case 'f':
    case 'F':
      return { kind: 'fit' }
    case '+':
    case '=':
      return { kind: 'zoom', direction: 1 }
    case '-':
    case '_':
      return { kind: 'zoom', direction: -1 }
    case 'Escape':
      return { kind: 'escape' }
  }
  if (!arrows) return undefined
  const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[
    e.key
  ] as [number, number] | undefined
  if (!arrow) return undefined
  return e.shiftKey
    ? { kind: 'pan', x: arrow[0], y: arrow[1] }
    : { kind: 'orbit', azimuth: -arrow[0] * ORBIT_STEP, polar: -arrow[1] * ORBIT_STEP }
}
