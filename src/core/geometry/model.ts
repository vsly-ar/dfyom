/**
 * Geometry input model and constants for 2.5D part evaluation.
 * Doc: docs/architecture/geometry.md#25d-evaluation-v01
 *
 * Everything here is canonical float64: lengths in mm, angles in degrees
 * (docs/architecture/quantities.md#value). The design layer resolves quantities, expressions
 * and `on` references before evaluation, so geometry never sees `Quantity` objects.
 */
import type { Direction } from './face'
import type { Path, Region } from './2d/model'

/** Coincidence, collapse and zero-length threshold (mm). */
export const EPSILON = 1e-6
/** How far removals reach past the faces they cut (mm). */
export const OVERSHOOT = 1
/** Smallest volume that counts as a piece or an overlap (mm³). */
export const EPSILON_VOLUME = 1e-3
/** Maximum sagitta of every flattened arc and fillet step in v0.1 (mm). */
export const CHORD_TOLERANCE = 0.01
/**
 * Largest tile edge of planar faces that later cuts cross (the stock faces, facing floors), mm:
 * each tile has its own face id, so Manifold re-triangulates small polygons
 * (docs/architecture/shapes.md#geometry-for-shape-operations, spike S3).
 */
export const FACE_TILE = 15

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
  /**
   * v0.3: a general shape (named, or a rotated rectangle) placed in the face frame (rotation and
   * mirror applied), relative to `Shape.center` = the centre of its placed bounding box. Loops
   * and pieces are in surface-numbering order (`wall[i]` / `corner[i]` = element i across all
   * loops; each loop from its start point, docs/modes/design-v0.3.md#surfaces). Builders take it
   * from G1 (geometry) and T1/T2 (toolpaths) through `outline.ts`.
   */
  | { readonly kind: 'region'; readonly region: Region }
  /** v0.3: an open path (profile `on` only), placed as `region` is. */
  | { readonly kind: 'path'; readonly path: Path }

/** The analytic v0.1 contours (contour.ts, the offset-loft). */
export type AnalyticContour = Extract<Contour, { kind: 'rectangle' | 'circle' }>

/** True for the v0.1 contours; false for v0.3 general ones (`region`, `path`). */
export const isAnalytic = (c: Contour): c is AnalyticContour =>
  c.kind === 'rectangle' || c.kind === 'circle'

/** A v0.1 shape: an analytic contour placed by its centre. */
export interface AnalyticShape {
  readonly center: Vec2
  readonly contour: AnalyticContour
}

/** A pocket or profile the v0.1/v0.2 builders and generators take. */
export type AnalyticOperation<K extends 'pocket' | 'profile'> = Extract<
  OperationGeometry,
  { kind: K }
> & { readonly shape: AnalyticShape }

/**
 * True if the v0.1/v0.2 builders and generators take this pocket or profile: an analytic contour
 * and (profiles) `outside` / `inside` through. General shapes and `on` grooves wait for G1
 * (solids) and T1/T2 (toolpaths); see docs/architecture/shapes.md#implementation-k3.
 */
export function isAnalyticOperation<O extends Extract<OperationGeometry, { shape: Shape }>>(
  op: O,
): op is O & { readonly shape: AnalyticShape } {
  if (!isAnalytic(op.shape.contour)) return false
  if (op.kind === 'pocket') return true
  return op.side !== 'on' && op.depth === undefined && op.tabs.positions === undefined
}

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
        /** A through pocket's: the material below `onZ` (patterns P4). */
        readonly depth: number
        readonly floorRadius: number
        /** Patterns P4: cleared through the opposite face (no floor); absent = blind. */
        readonly through?: true
        /** DF108: a roughing pocket (no removal of its own, no finishing ring). */
        readonly roughing?: true
        /** DF122: a roughing pocket's owner pocket (`dfm.roughingNoGain` compares their tools). */
        readonly roughingOf?: string
        /**
         * A through pocket's depth below the stock face when an earlier setup already cleared
         * material under its whole region from the opposite face (DF50 for through pockets,
         * `throughDepths`); absent = the stock extent along the normal. The toolpath cuts
         * `throughDepth + onZ` below `on`; the removal solid still runs through.
         */
        readonly throughDepth?: number
      }
    | {
        readonly kind: 'drilling'
        readonly id: string
        readonly onZ: number
        readonly center: Vec2
        readonly diameter: number
        readonly bottom: DrillBottom
        /**
         * A through hole's depth below the stock face when an earlier setup already cleared
         * material under the whole hole from the opposite face (DF61, `throughDepths`); absent =
         * the stock extent along the normal.
         */
        readonly throughDepth?: number
      }
    | {
        readonly kind: 'profile'
        readonly id: string
        readonly shape: Shape
        readonly side: 'outside' | 'inside' | 'on'
        readonly slotWidth: number
        /** A blind groove's (v0.3) or step's (DF53) depth below the stock face; absent = through. */
        readonly depth?: number
        /**
         * A through cut's depth below the stock face when an earlier setup already cleared
         * material under its whole slot from the opposite face (DF50, `throughDepths`); absent =
         * the stock extent along the normal. Tabs stand on this level.
         */
        readonly throughDepth?: number
        readonly tabs: {
          readonly count: number
          readonly width: number
          readonly thickness: number
          /**
           * v0.3: tab centres as distances along the loop from its start point (mm); present =
           * replaces `count`. Absent on v0.1/v0.2 inputs (byte-identical).
           */
          readonly positions?: readonly number[]
        }
        /**
         * DF122 R4: a roughing profile: removes nothing of its own, is no through cut (its skin
         * holds), cuts no tabs; its owner in `roughingOf`.
         */
        readonly roughing?: true
        readonly roughingOf?: string
      }
    | CircleChamferFields
    | LoopChamferFields
    | LineFields
  )

/**
 * A Line's cutter (engraved-patterns.md § Line operation): the tool shape its groove takes, mm
 * and degrees. A V-bit (chamfer mill, tip Ø `tipDiameter`, 0 = pointed), a tapered ball end mill
 * (ball Ø `tipDiameter` under a cone of `taperAngle` per side up to Ø `diameter`,
 * docs/modes/tapered-ball-nose.md#line-operation), a ball or a flat end mill.
 */
export type LineCutter =
  | {
      readonly kind: 'vBit'
      readonly diameter: number
      readonly angle: number
      readonly tipDiameter: number
    }
  | {
      readonly kind: 'taperedBall'
      readonly diameter: number
      readonly tipDiameter: number
      readonly taperAngle: number
    }
  | { readonly kind: 'ball'; readonly diameter: number }
  | { readonly kind: 'flat'; readonly diameter: number }

/**
 * The levels (0..1) of one Line path (engraved-patterns.md E2, § Levels on shapes): an open
 * path's level profile by arc-length fraction `u` (0 = start, 1 = end, ascending, linear between),
 * or one level for every loop of a closed shape.
 */
export type LinePathLevels =
  | { readonly kind: 'path'; readonly u: readonly number[]; readonly level: readonly number[] }
  | { readonly kind: 'loops'; readonly level: number }

/**
 * A Line (engraved-patterns.md E1, E2): every loop and open path of `paths` (placed general
 * shapes in the face frame) is a line cut on its centreline from the `on` face at `onZ`. Its
 * depth is `depth.start` at its start and `depth.end` at its end, linear by arc length; or, with
 * `{ min, max }` (E2), from the paths' `levels` (level 0 → `min`, 1 → `max`, a path without levels
 * is level 1): open lines whose ends meet are chained and a level step is blended over ±`blend`.
 * `cutter` is the tool the groove takes (the operation's tool, else the default 60° V-bit).
 */
interface LineFields {
  readonly kind: 'line'
  readonly id: string
  readonly onZ: number
  readonly paths: readonly Shape[]
  readonly depth:
    | { readonly start: number; readonly end: number }
    | { readonly min: number; readonly max: number }
  /** E2, with `{ min, max }`: one entry per path (null: no levels, level 1). */
  readonly levels?: readonly (LinePathLevels | null)[]
  /** E2, with `{ min, max }`: a level step is blended over ±`blend` mm (default 1). */
  readonly blend?: number
  /**
   * On a split piece only: the piece's cell in the face frame (grown by the groove's half width);
   * the resolved lines are cut there, after chaining and blends, so their depths stay the source's.
   */
  readonly within?: { readonly min: Vec2; readonly max: Vec2 }
  readonly cutter: LineCutter
}

export type LineGeometry = FacePlacement & LineFields

/**
 * v0.4: a cone frustum at the mouth of `edgeOf` (an earlier drilling, circle pocket or inside
 * circle profile on the same face), coaxial with it: `center` is the edge's axis, `onZ` its face
 * (docs/modes/design-v0.4.md#chamfer-operation-v04-circular-edges).
 */
interface CircleChamferFields {
  readonly kind: 'chamfer'
  readonly id: string
  readonly onZ: number
  readonly center: Vec2
  readonly edgeOf: string
  readonly edgeDiameter: number
  /** In the face plane, > `edgeDiameter`. */
  readonly diameter: number
  /** Included angle, degrees. */
  readonly angle: number
  /**
   * Stepped (F7): terraces of at most this height by a flat end mill; absent = a chamfer
   * mill (docs/modes/design-v0.4.md#stepped-countersink-f7-d41). The solid is then the terraces.
   */
  readonly stepdown?: number
  readonly edge?: never
}

/**
 * Edge chamfer (E1, E2): a bevel along every loop of a general edge, the top edge of an earlier
 * pocket of any other shape or `inside` profile (E1), or `outside` profile (E2), on the same face
 * (`edge.shape`). `onZ` is the material's top at the edge: the edge's face, or the deepest earlier
 * facing's floor of that face when the edge starts on a faced stock face (E2). A present `edge`
 * tells it from the circular chamfer, whose input stays byte-identical.
 * Doc: docs/modes/edge-chamfers.md#implementation-e1, docs/modes/edge-chamfers.md#implementation-e2
 */
interface LoopChamferFields {
  readonly kind: 'chamfer'
  readonly id: string
  readonly onZ: number
  readonly edgeOf: string
  readonly edge: LoopChamferEdge
  /** Stepped chamfers stay circular (rule `chamferStepped`). */
  readonly stepdown?: never
  /** The bevel's width at the face (mm, > 0), from the edge into the material. */
  readonly width: number
  /** Included angle, degrees. */
  readonly angle: number
  /**
   * E4a: lift the V-bit into the sharp line-line corners of the chosen loops (the V-carving
   * corner move), so the bevels meet in a mitre; absent = off (E1: the cone stays).
   * Doc: docs/modes/edge-chamfers.md#implementation-e4a
   */
  readonly cornerLift?: true
}

/** The general edge a loop chamfer follows, in the edge operation's face frame. */
export interface LoopChamferEdge {
  /**
   * The edge operation's shape. `inside`: its region is the air side of every chamfered loop.
   * `outside`: its (first) loop's region is the part, the air is around it (E2).
   */
  readonly shape: Shape
  /** Which side of the loops is air: `inside` (a pocket or an inside profile; E1), `outside` (E2). */
  readonly side: 'inside' | 'outside'
  /** The edge operation's depth below `onZ` (a pocket, a step); absent = through. */
  readonly depth?: number
  /**
   * On a split piece only (E2): the piece's cell in the face frame. The bevel stays within it
   * (grown by the tool's reach at the face), so `shape` (then the source's edge, unclipped) is
   * chamfered only where it is the source's real edge, never along the split line.
   */
  readonly within?: { readonly min: Vec2; readonly max: Vec2 }
  /**
   * E4a: the chosen loops, indices into `regionLoops(loopChamferRegion(…))` (per piece its outer
   * loop, then its islands); absent = every loop.
   */
  readonly loops?: readonly number[]
  /**
   * E4b, a bottom chamfer only: the through profile's tabs, each as its centre on the edge (face
   * frame of the chamfer) and its width along the edge. The bevel stops short of every tab (the
   * tool lifts over it, `loopChamferTabGap`), so the tabs that hold the part stay whole.
   * Doc: docs/modes/edge-chamfers.md#implementation-e4b
   */
  readonly tabs?: readonly LoopChamferTab[]
  /**
   * Patterns P3: the edge is a pattern's cells (its owned pocket). The bevels meeting between two
   * cells are the pattern's finding (`patternWeb` at twice the width, exact for the lattice), not
   * the region-wide `chamferMeets`, which is slow on hundreds of cells.
   * Doc: docs/modes/patterns.md#implementation-p3
   */
  readonly pattern?: true
}

/** A tab a bottom chamfer stops short of (E4b): its centre on the edge and width along it. */
export interface LoopChamferTab {
  readonly at: Vec2
  readonly width: number
}

/** Clearance between a bottom chamfer's cone and a tab it stops short of (mm, E4b). */
export const LOOP_CHAMFER_TAB_CLEARANCE = 1

/**
 * How far from a tab's centre (along the edge, as the edge point nearest the tool) a bottom
 * chamfer leaves the edge sharp (E4b): half the tab, the bevel's width (the cone's reach at the
 * face of a pointed bit), the tip radius and the clearance.
 */
export const loopChamferTabGap = (tab: LoopChamferTab, width: number, tipDiameter = 0): number =>
  tab.width / 2 + width + tipDiameter / 2 + LOOP_CHAMFER_TAB_CLEARANCE

export type ChamferGeometry = Extract<OperationGeometry, { kind: 'chamfer' }>
export type CircleChamferGeometry = FacePlacement & CircleChamferFields
export type LoopChamferGeometry = FacePlacement & LoopChamferFields

/** A chamfer along a general edge (edge-chamfers.md E1), not a circular mouth (v0.4). */
export const isLoopChamfer = (op: ChamferGeometry): op is LoopChamferGeometry =>
  op.edge !== undefined

/** Depth of a loop chamfer's bevel below its face: width / tan(α / 2) (mm). */
export const loopChamferDepth = (c: { readonly width: number; readonly angle: number }): number =>
  c.width / Math.tan(((c.angle / 2) * Math.PI) / 180)

/** Chamfer mill angles match within this (degrees), design-v0.4.md § Chamfer operation. */
export const CHAMFER_ANGLE_TOLERANCE = 0.5

/** Slant length of a cone between two diameters at included angle `angle` (degrees). */
export const coneSlant = (inner: number, outer: number, angle: number): number =>
  (outer - inner) / 2 / Math.sin(((angle / 2) * Math.PI) / 180)

/** Depth of a chamfer's cone below its face: (D − d) / 2 / tan(α / 2) (mm). */
export function chamferDepth(
  c: Pick<CircleChamferFields, 'edgeDiameter' | 'diameter' | 'angle'>,
): number {
  return (c.diameter - c.edgeDiameter) / 2 / Math.tan(((c.angle / 2) * Math.PI) / 180)
}

/**
 * The terraces of a stepped chamfer (F7): N = ⌈h / stepdown⌉ of equal height h / N, h the cone
 * depth; terrace k (0-based) has its wall at radius D / 2 − k · height · tan(α / 2), so each top
 * step corner lies on the cone (docs/modes/design-v0.4.md#stepped-countersink-f7-d41).
 * Undefined when the sizes give no cone or the stepdown is not positive.
 */
export function chamferTerraces(
  c: Pick<CircleChamferFields, 'edgeDiameter' | 'diameter' | 'angle'>,
  stepdown: number,
): { readonly count: number; readonly height: number; readonly radii: number[] } | undefined {
  const h = chamferDepth(c)
  if (!(h > 0 && stepdown > 0 && Number.isFinite(h))) return undefined
  const count = Math.max(1, Math.ceil(h / stepdown - 1e-9))
  const height = h / count
  const tan = Math.tan(((c.angle / 2) * Math.PI) / 180)
  const radii = Array.from({ length: count }, (_, k) => c.diameter / 2 - k * height * tan)
  return { count, height, radii }
}

/**
 * A surface an operation parameter refers to (`on`, or a reference in an expression), so
 * evaluation can tell construction surfaces and warn when an operation that does not depend on
 * the surface cuts it away (`dfm.surfaceCutAway`, docs/modes/construction-surfaces.md#check-dfmsurfacecutaway).
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
  /**
   * Per referenced surface, its dependants (`surfaceDependants`, design layer): the operations a
   * later cut of the surface is expected from, so it raises no `dfm.surfaceCutAway`. Only
   * surfaces with dependants are listed; absent = none
   * (docs/modes/construction-surfaces.md#check-dfmsurfacecutaway).
   */
  readonly dependants?: Readonly<Record<SurfaceId, readonly string[]>>
  /**
   * Clone groups (v0.4 Clones): per repeated source operation, its id and its instances' ids
   * (`toGeometryInput`). Evaluation subtracts them in clone layers before the other operations
   * and keeps the part after them (docs/architecture/geometry.md#clone-layers); absent = none.
   * Grouping changes only the work, never the solid.
   */
  readonly cloneGroups?: readonly (readonly string[])[]
}

/**
 * DFM warning codes (docs/modes/design.md#dfm-checks). Geometry checks run in the evaluation
 * (`checks.ts`); parameter and tool checks are synchronous (`dfm.ts`).
 */
export const DFM_WARNING_CODES = [
  // geometry checks (evaluation): docs/architecture/geometry.md#evaluation-checks
  'dfm.loosePiece',
  'dfm.retainedRemoved',
  // a referenced surface a non-dependant cuts away (DF118): docs/modes/construction-surfaces.md
  'dfm.surfaceCutAway',
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
  // material removed by earlier setups (DF50): docs/modes/plan-v0.2.md#material-removed-by-earlier-setups
  'dfm.tabsThick',
  // tabs over half the material (DF90): docs/modes/design.md#profile-with-tabs
  'dfm.tabsTall',
  // face access checks (v0.2): docs/modes/design-v0.2.md#dfm-access-checks
  'dfm.reach',
  'dfm.setups',
  // the operation's own tool (v0.2): docs/modes/design-v0.2.md#dfm-with-the-tool
  'dfm.toolUnfit',
  'dfm.toolNotInLibrary',
  // no tool fits at all (hardening DF52): docs/modes/design-v0.2.md#tool-choice-fixes-df51-df52-df54-df55
  'dfm.noFittingTool',
  // a limit the changed stock no longer allows (hardening DF95): docs/modes/design.md#changing-the-stock-df95
  'dfm.stockLimit',
  // shapes (v0.3): docs/modes/design-v0.3.md#dfm-checks-for-shapes
  'dfm.restMaterial',
  'dfm.shapeOutsideFace',
  'dfm.shapeHeavy',
  // roughing passes (DF122): docs/modes/roughing.md#tool-automatic-or-the-users-choice
  'dfm.roughingNoGain',
  // features (v0.4): docs/modes/design-v0.4.md#checks-and-dfm
  'dfm.holeCustomSize',
  // stepped countersink (F7): docs/modes/design-v0.4.md#stepped-countersink-f7-d41
  'dfm.countersinkStepped',
  // chamfer operation (v0.4): docs/modes/design-v0.4.md#chamfer-operation-v04-circular-edges
  'dfm.chamferTooDeep',
  'dfm.chamferNoTool',
  // edge chamfers (E3): docs/modes/edge-chamfers.md#dfm-findings
  'dfm.chamferMeets',
  'dfm.chamferIncomplete',
  // E4b: docs/modes/edge-chamfers.md#implementation-e4b
  'dfm.chamferTabs',
  // Clones features (v0.4 F5; `operation` = the feature id): docs/modes/features.md#checks-and-dfm
  'dfm.cloneOutsideStock',
  'dfm.cloneDuplicate',
  'dfm.cloneOverlap',
  'dfm.clonesHeavy',
  // tabs off free sides (v0.4 TB1): docs/modes/design-v0.4.md#tabs-relocate-off-free-sides-tb1
  'dfm.tabsRelocated',
  'dfm.tabsNoHold',
  // Line (E1): docs/modes/engraved-patterns.md#dfm
  'dfm.lineTooDeep',
  'dfm.lineShallow',
  // E4: docs/modes/engraved-patterns.md#implementation-e4
  'dfm.lineMerge',
  // engraved pattern (E3, `operation` = the feature id): docs/modes/engraved-patterns.md#dfm
  'dfm.engravingEmpty',
  'dfm.engravingHeavy',
  // patterns P1 (`operation` = the feature id): docs/modes/patterns.md#checks-and-dfm
  'dfm.patternEmpty',
  'dfm.patternHeavy',
  'dfm.patternThinWeb',
  // heatsink presets H1: docs/modes/pattern-presets.md#dfm-heatsinks-in-aluminium
  'dfm.patternTallWeb',
  // split parts 4a (`operation` = the split id, `params.rule` the rule): docs/modes/split-parts.md#dfm-near-a-split
  'design.split',
] as const
export type DfmWarningCode = (typeof DFM_WARNING_CODES)[number]

/** A suggested value for the warning's parameter (mm; formatted in the project unit system). */
export interface DfmSuggestion {
  readonly relation: 'atLeast' | 'atMost'
  readonly value: number
}

/** One DFM warning: never blocks, derived on every evaluation, never stored. */
/**
 * A construction surface (docs/modes/construction-surfaces.md#resolution): referenced, defined
 * by the surface table, and with no triangles in the evaluated part. Its level still holds.
 */
export interface ConstructionSurface {
  readonly surface: SurfaceId
  /** Later operations that cut it away (its slab), in operation order. */
  readonly consumedBy: readonly string[]
  /** The operation parameters that refer to it. */
  readonly referencedBy: readonly { readonly operationId: string; readonly param: string }[]
  /**
   * The face's region at its level in its owner's face frame: `z` (0 at the stock face, negative
   * below it) and boundary loops of `[u, v]` points.
   */
  readonly patch: {
    readonly direction: Direction
    readonly z: number
    readonly loops: readonly (readonly Vec2[])[]
  }
}

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
  /** Values for the message; `at` = `[u, v]` of a marker in the face frame (v0.3 shapes). */
  readonly params: Readonly<
    Record<string, number | string | boolean | readonly string[] | readonly number[]>
  >
  readonly suggestion?: DfmSuggestion
}
