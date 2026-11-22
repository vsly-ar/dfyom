/**
 * Geometry input model and constants for 2.5D part evaluation.
 * Doc: docs/architecture/geometry.md#25d-evaluation-v01
 *
 * Everything here is canonical float64: lengths in mm, angles in degrees
 * (docs/architecture/quantities.md#value). The design layer resolves quantities, expressions
 * and `on` references before evaluation, so geometry never sees `Quantity` objects.
 */
import type { Direction } from './face'

/** Coincidence, collapse and zero-length threshold (mm). */
export const EPSILON = 1e-6
/** How far removals reach past the faces they cut (mm). */
export const OVERSHOOT = 1
/** Smallest volume that counts as a piece or an overlap (mm³). */
export const EPSILON_VOLUME = 1e-3
/** Maximum sagitta of every flattened arc and fillet step in v0.1 (mm). */
export const CHORD_TOLERANCE = 0.01

export type Vec2 = readonly [number, number]
export type Vec3 = readonly [number, number, number]

/**
 * A rigid placement `p ↦ origin + u·p₀ + v·p₁ + n·p₂`: a rotation whose columns `u`, `v`, `n` are
 * axis unit vectors (entries 0 or ±1, `u × v = n`) plus a translation, so placing is exact in
 * float64. A face frame is one (docs/architecture/geometry.md#non-top-faces-v02).
 */
export interface Placement {
  readonly origin: Vec3
  readonly u: Vec3
  readonly v: Vec3
  readonly n: Vec3
}

/** The translation by `by` (no rotation). */
export function translation(by: Vec3): Placement {
  return { origin: by, u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }
}

/** `p` placed by `t` (local → part frame). */
export function applyPlacement(t: Placement, p: Vec3): Vec3 {
  const at = (i: number) => t.origin[i]! + t.u[i]! * p[0] + t.v[i]! * p[1] + t.n[i]! * p[2]
  return [at(0), at(1), at(2)]
}

/** `p` taken back into the local frame of `t` (part → local; the inverse of `applyPlacement`). */
export function unapplyPlacement(t: Placement, p: Vec3): Vec3 {
  const d = [p[0] - t.origin[0], p[1] - t.origin[1], p[2] - t.origin[2]]
  const dot = (a: Vec3) => a[0] * d[0]! + a[1] * d[1]! + a[2] * d[2]!
  return [dot(t.u), dot(t.v), dot(t.n)]
}

/** `t` after a translation by `at` in its local frame (place a mesh built around `at`). */
export function placeAt(t: Placement, at: Vec3): Placement {
  return { ...t, origin: applyPlacement(t, at) }
}

/**
 * Surface id, `<operation id>.<role>`, e.g. `pocket1.floor`, `profile1.tab[0].top`.
 * Derived from the operation and role, never from computed topology.
 */
export type SurfaceId = string

/**
 * A closed, axis-aligned v0.1 contour in its local frame (centered on the origin),
 * counter-clockwise seen from above.
 */
export type Contour =
  | {
      readonly kind: 'rectangle'
      /** Size along X. */
      readonly length: number
      /** Size along Y. */
      readonly width: number
      readonly cornerRadius: number
    }
  | { readonly kind: 'circle'; readonly radius: number }

/** One level of an offset-loft: the contour offset by `offset` (> 0 = inward) at height `z`. */
export interface Level {
  readonly offset: number
  readonly z: number
}

/** A contour placed in the part frame. */
export interface Shape {
  readonly center: Vec2
  readonly contour: Contour
}

export interface StockGeometry {
  readonly length: number
  readonly width: number
  readonly thickness: number
}

export type DrillBottom =
  | { readonly kind: 'through' }
  | { readonly kind: 'flat'; readonly depth: number }
  /** `pointAngle` in degrees; 180 is a flat bottom. */
  | { readonly kind: 'drillPoint'; readonly depth: number; readonly pointAngle: number }

/**
 * Where an operation is in v0.2 (docs/architecture/geometry.md#non-top-faces-v02): every
 * position, `onZ` and the stock sizes are read in the face frame of `direction` (`u` → x, `v` → y,
 * `n` → z, the stock face of the direction at z = 0). Absent = `+z`, the v0.1 part frame.
 */
interface FacePlacement {
  readonly direction?: Direction
}

/** v0.1 operations resolved to float64 mm (docs/modes/design.md#operations-v01). */
export type OperationGeometry = FacePlacement &
  (
    | { readonly kind: 'facing'; readonly id: string; readonly depth: number }
    | {
        readonly kind: 'pocket'
        readonly id: string
        /** z of the `on` surface in the face frame (≤ 0), from the analytic model. */
        readonly onZ: number
        readonly shape: Shape
        readonly depth: number
        readonly floorRadius: number
      }
    | {
        readonly kind: 'drilling'
        readonly id: string
        readonly onZ: number
        readonly center: Vec2
        readonly diameter: number
        readonly bottom: DrillBottom
      }
    | {
        readonly kind: 'profile'
        readonly id: string
        readonly shape: Shape
        readonly side: 'outside' | 'inside'
        readonly slotWidth: number
        readonly tabs: {
          readonly count: number
          readonly width: number
          readonly thickness: number
        }
      }
  )

/**
 * A surface an operation parameter refers to (`on`, or a reference in an expression), so
 * evaluation can warn when the surface no longer exists (`dfm.surfaceMissing`).
 */
export interface SurfaceReference {
  /** Id of the referencing operation. */
  readonly operation: string
  /** Its parameter, e.g. `on`, `depth`. */
  readonly parameter: string
  readonly surface: SurfaceId
}

/** Stock size plus operations, all in canonical float64 mm. */
export interface PartGeometryInput {
  readonly stock: StockGeometry
  readonly operations: readonly OperationGeometry[]
  /** Surfaces referenced by operation parameters; absent = none. */
  readonly references?: readonly SurfaceReference[]
}

/**
 * DFM warning codes (docs/modes/design.md#dfm-checks). Geometry checks run in the evaluation
 * (`checks.ts`); parameter and tool checks are synchronous (`dfm.ts`).
 */
export const DFM_WARNING_CODES = [
  // geometry checks (evaluation): docs/architecture/geometry.md#evaluation-checks
  'dfm.loosePiece',
  'dfm.retainedRemoved',
  'dfm.surfaceMissing',
  // parameter and tool checks: docs/modes/design.md#operations-v01
  'dfm.facingDeep',
  'dfm.pocketNoToolFits',
  'dfm.pocketDeepNarrow',
  'dfm.cornerSharp',
  'dfm.cornerTooSmall',
  'dfm.floorRadiusNoTool',
  'dfm.holeOutsideStock',
  'dfm.holeNoTool',
  'dfm.holeDeep',
  'dfm.slotLeavesStock',
  'dfm.slotOpensStock',
  'dfm.slotNoTool',
  'dfm.tabsNone',
  'dfm.tabsUnused',
  'dfm.tabsThin',
  // face access checks (v0.2): docs/modes/design-v0.2.md#dfm-access-checks
  'dfm.reach',
  'dfm.setups',
] as const
export type DfmWarningCode = (typeof DFM_WARNING_CODES)[number]

/** A suggested value for the warning's parameter (mm; formatted in the project unit system). */
export interface DfmSuggestion {
  readonly relation: 'atLeast' | 'atMost'
  readonly value: number
}

/** One DFM warning: never blocks, derived on every evaluation, never stored. */
export interface DfmWarning {
  readonly code: DfmWarningCode
  /** `warning`: likely a problem; `info`: worth knowing (e.g. needs pecking). */
  readonly severity: 'warning' | 'info'
  /** English text with values in mm; the UI may re-render it from `code` + `params`. */
  readonly message: string
  /** Id of the operation the warning is about. */
  readonly operation: string
  /** Its parameter (`tabs`, `shape.cornerRadius`, …), when one is to blame. */
  readonly parameter?: string
  readonly params: Readonly<Record<string, number | string | boolean | readonly string[]>>
  readonly suggestion?: DfmSuggestion
}
