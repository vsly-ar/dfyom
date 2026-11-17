/**
 * Geometry input model and constants for 2.5D part evaluation.
 * Doc: docs/architecture/geometry.md#25d-evaluation-v01
 *
 * Everything here is canonical float64: lengths in mm, angles in degrees
 * (docs/architecture/quantities.md#value). The design layer resolves quantities, expressions
 * and `on` references before evaluation, so geometry never sees `Quantity` objects.
 */

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

/** v0.1 operations resolved to float64 mm (docs/modes/design.md#operations-v01). */
export type OperationGeometry =
  | { readonly kind: 'facing'; readonly id: string; readonly depth: number }
  | {
      readonly kind: 'pocket'
      readonly id: string
      /** z of the `on` surface, from the analytic model. */
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
      readonly tabs: { readonly count: number; readonly width: number; readonly thickness: number }
    }

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
