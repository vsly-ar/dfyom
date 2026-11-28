/**
 * Operations and parts with `Quantity` values (the DTOs in part.dto.ts, loaded), plus their
 * fields: field kinds, defaults and parameter paths.
 * Doc: docs/modes/design.md#operations-v01, docs/modes/design.md#implementation-task-25,
 * docs/modes/design-v0.2.md#face-targets-generalised-on
 */
import { collect, fail, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import { quantityFromDTO } from '../library/item'
import type { ParseContext } from '../quantity/parse'
import type { Quantity } from '../quantity/quantity'
import type { Rational } from '../quantity/rational'
import type { QuantityDTO } from '../quantity/quantity.dto'
import { Tolerance } from '../quantity/tolerance'
import type { UnitSystem } from '../project/document'
import { BAND_EDGE_VALUES } from './part.dto'
import type {
  AnchorDTO,
  DrillBottomKind,
  FacingDTO,
  GeneralToleranceDTO,
  LinePathItemDTO,
  PointDTO,
  OperationDTO,
  OperationKind,
  PartDTO,
  OperationShapeDTO,
  ProfileSide,
} from './part.dto'
import { shapeFromDTO as namedShapeFromDTO, type NamedShape } from './shape'
import { designToolFromDTO, designToolToDTO, type DesignTool } from './tool'
import { deepEqual } from '../library/snapshot'
import { baseOf, isFrozenRecord } from './frozen-memo'
import { oppositeDirection, STOCK_FACE, stockFaceDirection } from '../geometry/face'

export type Point = readonly [Quantity, Quantity]

/** Placement anchor: a point of the shape's bounding rectangle in the face frame (anchor.ts). */
export type Anchor = Readonly<AnchorDTO>

/** The default anchor, and the one of every v0.1 record. */
export const CENTRE_ANCHOR: Anchor = Object.freeze({ u: 'centre', v: 'centre' })

/**
 * `center` is the anchor point (`[u, v]` of `anchor`) of the placed bounding box, not
 * necessarily the geometric centre. A rectangle with a rotation and every `named` shape are
 * general shapes, placed through the 2D layer (placement.ts, design-v0.3.md#placing-a-shape-on-a-face).
 */
export type Shape =
  | {
      readonly kind: 'rectangle'
      readonly center: Point
      readonly anchor: Anchor
      readonly length: Quantity
      readonly width: Quantity
      readonly cornerRadius: Quantity
      /**
       * DF120 Round: `cornerRadius` is half the narrowest side, kept so by the commands (absent =
       * off; docs/modes/hole-slots-and-round-corners.md#model).
       */
      readonly round?: true
      /** Counter-clockwise about the anchor point; None = 0 (v0.1). */
      readonly rotation: Option<Quantity>
    }
  | {
      readonly kind: 'circle'
      readonly center: Point
      readonly anchor: Anchor
      readonly diameter: Quantity
    }
  | {
      readonly kind: 'named'
      readonly center: Point
      readonly anchor: Anchor
      /** A shape of the part (`Part.shapes`); a dangling id is `input.malformed` on load. */
      readonly shapeId: string
      readonly rotation: Option<Quantity>
      /** Flips the shape frame's x before rotating. */
      readonly mirror: boolean
      /**
       * Uniform scale about the anchor point, before rotation and mirror; absent = 1 (a Line
       * path's E2, a pocket's or profile's D2: docs/modes/design-llm-first.md#placement-scale).
       */
      readonly scale?: number
    }

/** The rotation of a shape in degrees (0 for circles and absent rotations). */
export const shapeRotation = (s: Shape): number =>
  s.kind === 'circle' ? 0 : s.rotation.mapOr(0, (q) => q.canonical)

/**
 * A general shape goes through the 2D layer (placement.ts): every named shape and a rotated
 * rectangle. Rectangles at rotation 0 and circles keep the v0.1 analytic path (byte-identical
 * geometry inputs, design-v0.3.md#what-a-shape-is).
 */
export const isGeneralShape = (s: Shape): boolean =>
  s.kind === 'named' || (s.kind === 'rectangle' && shapeRotation(s) !== 0)

export interface GeneralTolerance {
  readonly length: Option<Quantity>
  readonly angle: Option<Quantity>
}

interface Common {
  readonly id: string
  readonly name: string
  readonly generalTolerance: GeneralTolerance
  /**
   * Face target: the surface id it starts from (a stock face for a facing or profile). Its
   * direction comes from the surface table; positions are `[u, v]` in its face frame.
   */
  readonly on: string
  /** Tool field (design-v0.2.md § Operation tool); None = auto, nothing chosen yet. */
  readonly tool: Option<DesignTool>
  /** Set by any user choice of the tool; false = auto. */
  readonly toolLocked: boolean
  /**
   * The feature that owns it (v0.4, features.md A1–A5): its geometry is edited only through the
   * feature; None = a plain operation.
   */
  readonly owner: Option<FeatureOwner>
}

/** An owned operation's feature and role; its id is `<featureId>_<role>` (feature.ts). */
export interface FeatureOwner {
  readonly featureId: string
  readonly role: string
}

/** `on` of a facing or profile whose record has none (v0.1). */
export const DEFAULT_STOCK_FACE = 'stock.top'

export interface Facing extends Common {
  readonly kind: 'facing'
  readonly depth: Quantity
  /**
   * DF145: the part of the face it faces; absent = the whole face (records stay unchanged).
   * Doc: docs/modes/design.md#facing-region-hardening-df145
   */
  readonly region?: FacingRegion | undefined
}

/** The stock edges of a face a band runs along (face frame: front = lowest v, left = lowest u). */
export const BAND_EDGES = BAND_EDGE_VALUES
export type BandEdge = (typeof BAND_EDGES)[number]

/**
 * A facing's region (DF145): a band `width` deep from one stock edge across the whole face, or a
 * shape placed as a pocket's (clipped to the face).
 */
export type FacingRegion =
  | { readonly kind: 'band'; readonly edge: BandEdge; readonly width: Quantity }
  | { readonly kind: 'shape'; readonly shape: Shape }
export interface Pocket extends Common {
  readonly kind: 'pocket'
  readonly shape: Shape
  readonly depth: Quantity
  readonly floorRadius: Quantity
  /**
   * A through pocket (patterns P4, a pattern's `through`; since DF116 any pocket's, design.md#pocket): it clears its region down
   * through the opposite stock face (the plan adds `breakthrough`), so no slug is left; `depth`
   * is the material below `on` when the feature expanded (readers that matter read it fresh,
   * `throughPocketDepth`), and its floor is no face target. Absent = blind.
   * Doc: docs/modes/patterns.md#implementation-p4
   */
  readonly through?: boolean | undefined
  /**
   * A pattern's roughing pocket (DF108, set only by a pattern's `roughing`): its tool clears the
   * cells it fits, leaving the finishing allowance, with no finishing ring; the pattern's pocket
   * then cuts only the rest. It removes nothing of its own in the geometry (a subset of the
   * pattern's pocket), its floor is no face target and material bands ignore it. Absent = a pocket.
   * Doc: docs/modes/patterns.md#roughing-df108
   */
  readonly roughing?: boolean | undefined
  /**
   * DF122: a plain pocket's roughing setting: on, it owns the roughing pocket `<id>_roughing`
   * (kept in sync by the design commands, roughing.ts) with these margins; absent = off.
   * Doc: docs/modes/roughing.md#model
   */
  readonly roughingPass?: RoughingMargins | undefined
  /** DF122: a roughing pocket's owner (a plain pocket); a pattern's derives it from its role. */
  readonly roughingOf?: string | undefined
  /** DF122: a roughing pocket's stock to leave (its owner's margins); absent fields = defaults. */
  readonly leave?: RoughingMargins | undefined
}

/**
 * DF122: a roughing pass's stock to leave: `wall` radial (absent = the owner's finishing
 * allowance), `floor` axial (absent = 0). Doc: docs/modes/roughing.md#stock-to-leave-wall-and-floor
 */
export interface RoughingMargins {
  readonly wall?: Quantity | undefined
  readonly floor?: Quantity | undefined
}

/** The roughing pocket a plain pocket owns: `pocket1_roughing` (DF122). */
export const roughingOperationId = (ownerId: string): string => `${ownerId}_roughing`

/**
 * The id of the roughing pocket that roughs pocket `op` (DF122: a plain pocket with
 * `roughingPass`; DF108: a pattern's pocket, whose roughing is its feature's `roughing` role),
 * or undefined (no roughing, or not a pocket). The operation itself may not exist (a pattern
 * without roughing).
 */
export function roughingIdOf(op: Operation): string | undefined {
  // DF122 R4: an inside/outside profile's own roughing profile
  if (op.kind === 'profile')
    return op.roughing === true || op.roughingPass === undefined
      ? undefined
      : roughingOperationId(op.id)
  if (op.kind !== 'pocket' || op.roughing === true) return undefined
  // R5: a Clones instance keeps its source's `roughingPass`
  if (op.roughingPass !== undefined) return roughingOperationId(op.id)
  if (op.owner.isNone()) return undefined
  const { featureId, role } = op.owner.unwrap()
  if (role === 'pocket') return `${featureId}_roughing`
  // R5: a Clones instance (role `<n>_<id>`) of a pattern's pocket `<pattern>_pocket` is roughed
  // by the instance of `<pattern>_roughing` (at both Clones levels)
  return /^\d+_.+_pocket$/.test(role) ? op.id.replace(/_pocket$/, '_roughing') : undefined
}

/** The owner id of a roughing pocket (DF122 `roughingOf`, else a pattern's `<feature>_pocket`). */
export function roughingOwnerId(op: Operation): string | undefined {
  if (op.kind === 'profile') return op.roughing === true ? op.roughingOf : undefined
  if (op.kind !== 'pocket' || op.roughing !== true) return undefined
  if (op.roughingOf !== undefined) return op.roughingOf
  if (op.owner.isNone()) return undefined
  const { featureId, role } = op.owner.unwrap()
  return role === 'roughing' ? `${featureId}_pocket` : undefined
}

export interface Drilling extends Common {
  readonly kind: 'drilling'
  readonly center: Point
  readonly diameter: Quantity
  readonly bottom: DrillBottomKind
  readonly depth: Option<Quantity>
  readonly pointAngle: Option<Quantity>
}
export interface Profile extends Common {
  readonly kind: 'profile'
  readonly shape: Shape
  readonly side: ProfileSide
  readonly slotWidth: Quantity
  /** A blind groove's (`on`) or step's (`outside`/`inside`, DF53) depth below `on`; None = through. */
  readonly depth: Option<Quantity>
  readonly tabs: {
    readonly count: Quantity
    readonly width: Quantity
    readonly thickness: Quantity
    /** Distances along the loop from its start point; Some replaces `count` (v0.3). */
    readonly positions: Option<readonly Quantity[]>
  }
  /**
   * DF122 R4: an `inside`/`outside` profile's roughing setting (as a pocket's): on, it owns the
   * roughing profile `<id>_roughing` (roughing.ts). Doc: docs/modes/roughing.md#implementation-r4
   */
  readonly roughingPass?: RoughingMargins | undefined
  /** DF122 R4: a roughing profile (removes nothing of its own; no finishing pass, no tabs). */
  readonly roughing?: true | undefined
  /** DF122 R4: a roughing profile's owner. */
  readonly roughingOf?: string | undefined
  /** DF122 R4: a roughing profile's stock to leave (its owner's margins). */
  readonly leave?: RoughingMargins | undefined
}
/**
 * v0.4: a conical bevel at the mouth of an earlier circular drilling, pocket or inside profile. `on` is always
 * the edge operation's `on` (recalculation keeps it so, surfaces.ts).
 * Doc: docs/modes/design-v0.4.md#chamfer-operation-v04-circular-edges
 */
export interface Chamfer extends Common {
  readonly kind: 'chamfer'
  /** Id of the earlier drilling, circle pocket or inside circle profile whose mouth it bevels. */
  readonly edgeOf: string
  /**
   * The chamfer's size (D45): its horizontal leg at the face, from the edge to the chamfer's
   * outer rim (> 0); "1.5 × 45°" is width 1.5 at 90°. Stored rather than the diameter, so the
   * chamfer keeps its width when the edge's diameter changes; diameter = edge Ø + 2 × width
   * (`chamferDiameter`), depth = width / tan(angle / 2).
   */
  readonly width: Quantity
  /** Included angle. */
  readonly angle: Quantity
  /**
   * Some = stepped (F7, the stepped countersink): terraces of at most this height cut by a flat
   * end mill; None = a chamfer mill. Doc: docs/modes/design-v0.4.md#stepped-countersink-f7-d41
   */
  readonly stepdown: Option<Quantity>
  /**
   * On a split piece only (edge-chamfers.md E2): the source's edge shape and the piece's cell, in
   * the piece's face frame; the bevel follows that shape within the cell. Written by the split.
   */
  readonly sourceEdge: Option<ChamferSourceEdge>
  /**
   * E4a: the chosen loops of a general edge, indices into its loops (per piece the outer loop,
   * then its islands); None = every loop. Doc: docs/modes/edge-chamfers.md#implementation-e4a
   */
  readonly loops: Option<readonly number[]>
  /** E4a: lift the V-bit into the sharp inside corners of a general edge (a mitre). */
  readonly cornerLift: boolean
}
export interface ChamferSourceEdge {
  readonly shape: Shape
  readonly within: { readonly min: Point; readonly max: Point }
}
/** A named shape placed on a face, as a Line's path (the `named` kind of `Shape`). */
export type NamedPlacement = Extract<Shape, { kind: 'named' }>

/**
 * DF147 SL2 (engraved-patterns.md § Simple Line): one inline element in the `on` face's frame, the
 * Line's only path: a straight segment, or an arc from `start` through `through` to `end`.
 */
export type InlineLinePath =
  | { readonly kind: 'segment'; readonly start: Point; readonly end: Point }
  | { readonly kind: 'arc'; readonly start: Point; readonly through: Point; readonly end: Point }

/**
 * A Line's path: a named placement, E2 `scale`d about its anchor point (absent = 1), or (DF147
 * SL2) an inline Straight / Arc.
 */
export type LinePath = NamedPlacement | InlineLinePath

/** True for an inline Straight / Arc path (DF147 SL2). */
export const isInlinePath = (p: LinePath): p is InlineLinePath => p.kind !== 'named'

/** An inline path's points with their parameter keys, in order (`start`, `through`, `end`). */
export function inlinePoints(p: InlineLinePath): [key: 'start' | 'through' | 'end', at: Point][] {
  return p.kind === 'segment'
    ? [
        ['start', p.start],
        ['end', p.end],
      ]
    : [
        ['start', p.start],
        ['through', p.through],
        ['end', p.end],
      ]
}

/** An inline path with every point mapped (a Clones copy, a split piece's frame). */
export function mapInlinePoints(p: InlineLinePath, f: (q: Point) => Point): InlineLinePath {
  return p.kind === 'segment'
    ? { kind: 'segment', start: f(p.start), end: f(p.end) }
    : { kind: 'arc', start: f(p.start), through: f(p.through), end: f(p.end) }
}

/**
 * A Line's depth below `on` (engraved-patterns.md E1, E2): constant, linear from `start` to `end`
 * along each line by arc length, or from the paths' levels (E2: level 0 → `min`, 1 → `max`).
 */
export type LineDepth =
  | { readonly kind: 'constant'; readonly depth: Quantity }
  | { readonly kind: 'ramp'; readonly start: Quantity; readonly end: Quantity }
  | { readonly kind: 'levels'; readonly min: Quantity; readonly max: Quantity }

/**
 * A Line (engraved-patterns.md EP-A, E1, E2): a groove cut on the centreline of every loop and
 * open path of its placed named shapes, at a depth that may change along the line. No slot width,
 * tabs or cut side; the tool (V-bit by default, ball or flat end mill) gives the groove's width.
 * `blend` (E2, None = 1 mm): a level step is blended over ±`blend` along the line.
 * Doc: docs/modes/engraved-patterns.md#line-operation
 */
export interface Line extends Common {
  readonly kind: 'line'
  readonly paths: readonly LinePath[]
  readonly depth: LineDepth
  readonly blend: Option<Quantity>
  /**
   * On a split piece only (engraved-patterns.md § Split pieces): the piece's cell in its face
   * frame, grown by the groove's half width; the resolved lines are cut there. Written by the
   * split, None everywhere else.
   */
  readonly within: Option<{ readonly min: Point; readonly max: Point }>
}

/**
 * A Line's depths for its geometry, canonical mm: at the start and end of each line (equal for a
 * constant depth), or the levels' `{ min, max }` (E2).
 */
export const lineDepths = (
  d: LineDepth,
): { start: number; end: number } | { min: number; max: number } =>
  d.kind === 'constant'
    ? { start: d.depth.canonical, end: d.depth.canonical }
    : d.kind === 'ramp'
      ? { start: d.start.canonical, end: d.end.canonical }
      : { min: d.min.canonical, max: d.max.canonical }

/** A Line's deepest depth as entered (mm): with levels, `max` (levels never pass it). */
export const lineDeepest = (d: LineDepth): number => {
  const v = lineDepths(d)
  return 'min' in v ? v.max : Math.max(v.start, v.end)
}

export type Operation = Facing | Pocket | Drilling | Profile | Chamfer | Line

/**
 * The diameter of the circular edge a chamfer can bevel (design-v0.4.md rule `chamferEdge`): the
 * mouth of a drilling, a circle pocket or an `inside` profile of a circle (a through opening, X2);
 * undefined for any other operation.
 */
export function circularEdgeDiameter(op: Operation | undefined): Quantity | undefined {
  if (op?.kind === 'drilling') return op.diameter
  if (
    (op?.kind === 'pocket' || (op?.kind === 'profile' && op.side === 'inside')) &&
    op.shape.kind === 'circle'
  )
    return op.shape.diameter
  return undefined
}

/**
 * The edge a chamfer can bevel (design-v0.4.md rule `chamferEdge`, widened by edge-chamfers.md
 * E1/E2): `circle` for the circular mouths of v0.4 (exact cone, `circularEdgeDiameter`), `loop` for
 * the top edge of a pocket of any other shape, or an `inside` or `outside` profile of any other
 * shape (every loop, islands included); undefined for any other operation (facings, `on`
 * profiles, chamfers).
 */
export function chamferEdgeKind(op: Operation | undefined): 'circle' | 'loop' | undefined {
  if (circularEdgeDiameter(op) !== undefined) return 'circle'
  if (op?.kind === 'pocket' || (op?.kind === 'profile' && op.side !== 'on')) return 'loop'
  return undefined
}

/**
 * The stock face a bottom chamfer (edge-chamfers.md E4b) sits on: the face opposite a **through**
 * `outside` / `inside` profile's own (non-circular: a `loop` edge) stock face; undefined for any
 * other edge (circles, blind pockets, blind profiles, drillings keep the top edge only). Patterns
 * P5: a **through pocket** (a pattern's through cells) on a stock face has one too.
 */
export function bottomEdgeFace(edge: Operation | undefined): string | undefined {
  const through =
    edge?.kind === 'pocket'
      ? edge.through === true
      : edge?.kind === 'profile' && edge.depth.isNone() && chamferEdgeKind(edge) === 'loop'
  if (edge === undefined || !through) return undefined
  const d = stockFaceDirection(edge.on)
  return d === undefined ? undefined : STOCK_FACE[oppositeDirection(d)]
}

/** A chamfer of the bottom edge of its through profile, from the opposite face (E4b). */
export const isBottomChamfer = (op: Chamfer, edge: Operation | undefined): boolean =>
  edge !== undefined && op.on !== edge.on && op.on === bottomEdgeFace(edge)

/** A chamfer along a general edge (edge-chamfers.md E1): its `edgeOf` among `ops` is a `loop` edge. */
export const isLoopChamferOp = (op: Chamfer, ops: readonly Operation[]): boolean =>
  chamferEdgeKind(ops.find((o) => o.id === op.edgeOf)) === 'loop'

/**
 * A chamfer's diameter in the face plane, mm exact: the edge's Ø + 2 × `width` (D45,
 * design-v0.4.md § Chamfer operation); undefined when the edge is not a circular edge.
 */
export function chamferDiameter(c: Chamfer, edge: Operation | undefined): Rational | undefined {
  const edgeD = circularEdgeDiameter(edge)
  return edgeD?.exact.add(c.width.exact.add(c.width.exact))
}

export interface Part {
  readonly id: string
  readonly name: string
  /** Stock snapshot id. */
  readonly stock: string
  readonly generalTolerance: GeneralTolerance
  readonly operations: readonly Operation[]
  /**
   * The named shapes the operations place, by id (loaded lazily: only shapes an operation
   * references, shapes.md#implementation-k2); absent = none referenced.
   */
  readonly shapes?: ReadonlyMap<string, NamedShape>
}

/** Id prefix of an operation kind: `facing1`, `pocket1`, `drill1`, `profile1`. */
export const ID_PREFIX: Record<OperationKind, string> = {
  facing: 'facing',
  pocket: 'pocket',
  drilling: 'drill',
  profile: 'profile',
  chamfer: 'chamfer',
  line: 'line',
}

/** Display name of an operation kind (default `name`, command titles). */
export const KIND_LABEL: Record<OperationKind, string> = {
  facing: 'Facing',
  pocket: 'Pocket',
  drilling: 'Drilling',
  profile: 'Profile',
  chamfer: 'Chamfer',
  line: 'Line',
}

// ── fields ────────────────────────────────────────────────────────────────────────────────

export type FieldKind = 'length' | 'angle' | 'scalar'

/** Parse context of a field in a project with this unit system (bare numbers). */
export function fieldContext(kind: FieldKind, units: UnitSystem): ParseContext {
  if (kind === 'angle') return { kind, defaultUnit: 'deg' }
  if (kind === 'scalar') return { kind, defaultUnit: '1' }
  return { kind, defaultUnit: units === 'mm' ? 'mm' : 'in' }
}

/** design.md defaults: metric / inch source as entered. */
export const DEFAULTS = {
  facingDepth: { mm: '0.5 mm', inch: '1/64"' },
  cornerRadius: { mm: '3 mm', inch: '1/8"' },
  floorRadius: { mm: '0', inch: '0' },
  slotWidth: { mm: '6 mm', inch: '1/4"' },
  tabWidth: { mm: '6 mm', inch: '1/4"' },
  tabThickness: { mm: '2 mm', inch: '1/16"' },
  tabCount: { mm: '4', inch: '4' },
  pointAngle: { mm: '118°', inch: '118°' },
  // hole feature (design-v0.4.md#parameters)
  holeDiameter: { mm: '6 mm', inch: '1/4"' },
  headSink: { mm: '0.2 mm', inch: '0.008"' },
  // recessed countersink (hole-slots-and-round-corners.md#recessed-countersink-type): the recess
  // is csDiameter + the ledge wide and this deep by default
  recessLedge: { mm: '1 mm', inch: '0.04"' },
  recessDepth: { mm: '2 mm', inch: '0.08"' },
  // stepped countersink terrace height (design-v0.4.md#stepped-countersink-f7-d41)
  csStepdown: { mm: '1 mm', inch: '1/32"' },
  // chamfer operation (design-v0.4.md#chamfer-operation-v04-circular-edges): width (D45)
  chamferAngle: { mm: '90°', inch: '90°' },
  chamferWidth: { mm: '0.5 mm', inch: '1/64"' },
  // patterns P1 (docs/modes/patterns.md#model)
  patternCell: { mm: '8 mm', inch: '5/16"' },
  patternGap: { mm: '2 mm', inch: '1/16"' },
  patternMargin: { mm: '5 mm', inch: '3/16"' },
  patternDepth: { mm: '1 mm', inch: '1/32"' },
  // Line (docs/modes/engraved-patterns.md#line-operation)
  lineDepth: { mm: '0.5 mm', inch: '0.02"' },
  // levels (E2): `{ min, max }` and the blend of a level step
  lineLevelMin: { mm: '0.2 mm', inch: '0.008"' },
  lineLevelMax: { mm: '1 mm', inch: '0.04"' },
  lineBlend: { mm: '1 mm', inch: '0.04"' },
  // engraved pattern (docs/modes/engraved-patterns.md#engraved-pattern-feature)
  engravingMargin: { mm: '3 mm', inch: '1/8"' },
} as const satisfies Record<string, Record<UnitSystem, string>>

/**
 * Every quantity parameter of an operation with its path (as in the command args), e.g.
 * `depth`, `shape.center.0`, `tabs.width`.
 */
export function quantityParams(op: Operation): { path: string; value: Quantity }[] {
  const out: { path: string; value: Quantity }[] = []
  const add = (path: string, value: Quantity) => out.push({ path, value })
  const addOpt = (path: string, o: Option<Quantity>) => {
    if (o.isSome()) add(path, o.unwrap())
  }
  const shape = (s: Shape) => {
    add('shape.center.0', s.center[0])
    add('shape.center.1', s.center[1])
    if (s.kind === 'rectangle') {
      add('shape.length', s.length)
      add('shape.width', s.width)
      add('shape.cornerRadius', s.cornerRadius)
    } else if (s.kind === 'circle') add('shape.diameter', s.diameter)
    if (s.kind !== 'circle') addOpt('shape.rotation', s.rotation)
  }
  switch (op.kind) {
    case 'facing':
      add('depth', op.depth)
      // DF145: a region's shape keeps the pocket's paths (a facing has no other shape)
      if (op.region?.kind === 'band') add('region.band.width', op.region.width)
      else if (op.region?.kind === 'shape') shape(op.region.shape)
      break
    case 'pocket':
      shape(op.shape)
      add('depth', op.depth)
      add('floorRadius', op.floorRadius)
      break
    case 'drilling':
      add('center.0', op.center[0])
      add('center.1', op.center[1])
      add('diameter', op.diameter)
      addOpt('depth', op.depth)
      addOpt('pointAngle', op.pointAngle)
      break
    case 'profile':
      shape(op.shape)
      add('slotWidth', op.slotWidth)
      addOpt('depth', op.depth)
      add('tabs.count', op.tabs.count)
      add('tabs.width', op.tabs.width)
      add('tabs.thickness', op.tabs.thickness)
      if (op.tabs.positions.isSome())
        op.tabs.positions.unwrap().forEach((p, i) => add(`tabs.positions.${i}`, p))
      break
    case 'chamfer':
      add('width', op.width)
      add('angle', op.angle)
      addOpt('stepdown', op.stepdown)
      break
    case 'line':
      op.paths.forEach((p, i) => {
        if (isInlinePath(p)) {
          for (const [k, at] of inlinePoints(p)) {
            add(`paths.${i}.${p.kind}.${k}.0`, at[0])
            add(`paths.${i}.${p.kind}.${k}.1`, at[1])
          }
          return
        }
        add(`paths.${i}.center.0`, p.center[0])
        add(`paths.${i}.center.1`, p.center[1])
        addOpt(`paths.${i}.rotation`, p.rotation)
      })
      if (op.depth.kind === 'constant') add('depth', op.depth.depth)
      else if (op.depth.kind === 'ramp') {
        add('depth.start', op.depth.start)
        add('depth.end', op.depth.end)
      } else {
        add('depth.min', op.depth.min)
        add('depth.max', op.depth.max)
      }
      addOpt('blend', op.blend)
      break
  }
  return out
}

/** The operation with the quantity at `path` replaced (paths from `quantityParams`). */
export function withParam(op: Operation, path: string, value: Quantity): Operation {
  const [head, sub] = path.split('.') as [string, string | undefined]
  const point = (p: Point, i: string): Point => (i === '0' ? [value, p[1]] : [p[0], value])
  if (head === 'shape' && 'shape' in op) {
    const rest = path.slice('shape.'.length)
    const s = op.shape
    const shape: Shape = rest.startsWith('center.')
      ? { ...s, center: point(s.center, rest.slice('center.'.length)) }
      : rest === 'rotation'
        ? ({ ...s, rotation: Some(value) } as Shape)
        : ({ ...s, [rest]: value } as Shape)
    return { ...op, shape }
  }
  if (op.kind === 'drilling' && head === 'center')
    return { ...op, center: point(op.center, sub ?? '0') }
  if (op.kind === 'profile' && head === 'tabs' && sub === 'positions') {
    const i = Number(path.split('.')[2])
    const list = [...op.tabs.positions.unwrapOr([])]
    list[i] = value
    return { ...op, tabs: { ...op.tabs, positions: Some(list) } }
  }
  if (op.kind === 'profile' && head === 'tabs' && sub !== undefined)
    return { ...op, tabs: { ...op.tabs, [sub]: value } }
  if ((op.kind === 'drilling' || op.kind === 'profile') && head === 'depth')
    return { ...op, depth: Some(value) }
  if (op.kind === 'drilling' && head === 'pointAngle') return { ...op, pointAngle: Some(value) }
  if (op.kind === 'chamfer' && head === 'stepdown') return { ...op, stepdown: Some(value) }
  if (op.kind === 'line') return lineWithParam(op, path, value)
  return { ...op, [head]: value } as Operation
}

/** A Line with the quantity at `path` replaced (`depth`, `depth.start`, `paths.<i>.center.0`, …). */
function lineWithParam(op: Line, path: string, value: Quantity): Line {
  const parts = path.split('.')
  if (parts[0] === 'blend') return { ...op, blend: Some(value) }
  if (parts[0] === 'depth') {
    if (parts[1] === undefined) return { ...op, depth: { kind: 'constant', depth: value } }
    if (parts[1] === 'min' || parts[1] === 'max') {
      const d =
        op.depth.kind === 'levels'
          ? op.depth
          : op.depth.kind === 'ramp'
            ? { min: op.depth.start, max: op.depth.end }
            : { min: op.depth.depth, max: op.depth.depth }
      return {
        ...op,
        depth: { kind: 'levels', min: d.min, max: d.max, [parts[1]]: value } as LineDepth,
      }
    }
    const d =
      op.depth.kind === 'ramp'
        ? op.depth
        : op.depth.kind === 'levels'
          ? { start: op.depth.min, end: op.depth.max }
          : { start: op.depth.depth, end: op.depth.depth }
    return {
      ...op,
      depth: { kind: 'ramp', start: d.start, end: d.end, [parts[1]]: value } as LineDepth,
    }
  }
  if (parts[0] !== 'paths') return op
  const i = Number(parts[1])
  const paths = op.paths.map((p, k): LinePath => {
    if (k !== i) return p
    if (isInlinePath(p)) {
      const key = parts[3] as 'start' | 'through' | 'end'
      const at = (q: Point): Point => (parts[4] === '0' ? [value, q[1]] : [q[0], value])
      if (p.kind === 'segment')
        return key === 'start' ? { ...p, start: at(p.start) } : { ...p, end: at(p.end) }
      return { ...p, [key]: at(p[key]) }
    }
    if (parts[2] === 'rotation') return { ...p, rotation: Some(value) }
    return { ...p, center: parts[3] === '0' ? [value, p.center[1]] : [p.center[0], value] }
  })
  return { ...op, paths }
}

/**
 * Effective tolerance of a parameter (docs/architecture/quantities.md#tolerance): its explicit
 * tolerance, else the nearest general tolerance of its kind: operation → part (features and the
 * project scope come later). None = no tolerance set anywhere.
 */
export function effectiveTolerance(q: Quantity, op: Operation, part: Part): Option<Tolerance> {
  if (q.tolerance.isSome()) return q.tolerance
  if (q.kind !== 'length' && q.kind !== 'angle') return None
  const kind = q.kind
  const general = [op.generalTolerance[kind], part.generalTolerance[kind]].find((t) => t.isSome())
  if (general === undefined) return None
  const d = general.unwrap().exact
  return Tolerance.create({ notation: 'symmetric', upper: d, lower: d.neg() }).ok()
}

// ── DTO ↔ model ───────────────────────────────────────────────────────────────────────────

const q = (dto: QuantityDTO, ...path: (string | number)[]) => quantityFromDTO(dto, ...path)
const optQ = (
  dto: QuantityDTO | undefined,
  ...path: (string | number)[]
): AppResult<Option<Quantity>> =>
  dto === undefined ? Ok(None) : q(dto, ...path).map((v): Option<Quantity> => Some(v))

/** DF122: a roughing pass's margins (absent fields stay absent). */
export function marginsFromDTO(
  dto: { wall?: QuantityDTO | undefined; floor?: QuantityDTO | undefined },
  ...path: string[]
): AppResult<RoughingMargins> {
  return collect([optQ(dto.wall, ...path, 'wall'), optQ(dto.floor, ...path, 'floor')]).map(
    ([wall, floor]) => ({
      ...(wall!.isSome() ? { wall: wall!.unwrap() } : {}),
      ...(floor!.isSome() ? { floor: floor!.unwrap() } : {}),
    }),
  )
}

export function marginsToDTO(m: RoughingMargins): {
  wall?: QuantityDTO
  floor?: QuantityDTO
} {
  return {
    ...(m.wall === undefined ? {} : { wall: m.wall.toDTO() }),
    ...(m.floor === undefined ? {} : { floor: m.floor.toDTO() }),
  }
}

function pointFromDTO(p: readonly [QuantityDTO, QuantityDTO], ...path: string[]) {
  return collect([q(p[0], ...path, 0), q(p[1], ...path, 1)]).map(([x, y]): Point => [
    x as Quantity,
    y as Quantity,
  ])
}

function shapeFromDTO(s: OperationShapeDTO): AppResult<Shape> {
  const center = pointFromDTO(s.center, 'shape', 'center')
  const anchor: Anchor = s.anchor === undefined ? CENTRE_ANCHOR : { u: s.anchor.u, v: s.anchor.v }
  const rotation: AppResult<Option<Quantity>> =
    s.kind === 'circle' ? Ok(None) : optQ(s.rotation, 'shape', 'rotation')
  if (s.kind === 'named')
    return collect<unknown>([center, rotation]).map(() => ({
      kind: 'named',
      center: center.unwrap(),
      anchor,
      shapeId: s.shapeId,
      rotation: rotation.unwrap(),
      mirror: s.mirror === true,
      ...(s.scale === undefined ? {} : { scale: s.scale }),
    }))
  if (s.kind === 'circle')
    return collect<unknown>([center, q(s.diameter, 'shape', 'diameter')]).map(() => ({
      kind: 'circle',
      center: center.unwrap(),
      anchor,
      diameter: q(s.diameter).unwrap(),
    }))
  const fields = [
    q(s.length, 'shape', 'length'),
    q(s.width, 'shape', 'width'),
    q(s.cornerRadius, 'shape', 'cornerRadius'),
  ]
  return collect<unknown>([center, rotation, ...fields]).map(() => {
    const [length, width, cornerRadius] = fields.map((f) => f.unwrap())
    return {
      kind: 'rectangle',
      center: center.unwrap(),
      anchor,
      length: length!,
      width: width!,
      cornerRadius: cornerRadius!,
      ...(s.round === true ? { round: true as const } : {}),
      rotation: rotation.unwrap(),
    }
  })
}

export function generalToleranceFromDTO(
  t: GeneralToleranceDTO | undefined,
): AppResult<GeneralTolerance> {
  const length = optQ(t?.length, 'generalTolerance', 'length')
  const angle = optQ(t?.angle, 'generalTolerance', 'angle')
  return collect<unknown>([length, angle]).map(() => ({
    length: length.unwrap(),
    angle: angle.unwrap(),
  }))
}

export function generalToleranceToDTO(t: GeneralTolerance): GeneralToleranceDTO | undefined {
  if (t.length.isNone() && t.angle.isNone()) return undefined
  return {
    ...(t.length.isSome() ? { length: t.length.unwrap().toDTO() } : {}),
    ...(t.angle.isSome() ? { angle: t.angle.unwrap().toDTO() } : {}),
  } as GeneralToleranceDTO
}

const parsedRecords = new WeakMap<object, AppResult<Operation>>()
const recordOfOperation = new WeakMap<Operation, OperationDTO>()

/**
 * Builds the operation from a shape-checked DTO; quantity issues carry parameter paths. Cached
 * per frozen record (frozen-memo.ts, hardening P5): an unchanged operation of a committed document
 * is parsed once, and loads to the same model object every time.
 */
export function operationFromDTO(dto: OperationDTO): AppResult<Operation> {
  const base = baseOf(dto)
  if (!isFrozenRecord(base)) return parseOperation(base)
  const hit = parsedRecords.get(base)
  if (hit !== undefined) return hit
  const r = parseOperation(base)
  parsedRecords.set(base, r)
  // a record that writes back as itself: writing the model back can keep the record
  if (r.isOk() && deepEqual(operationToDTO(r.unwrap()), base))
    recordOfOperation.set(r.unwrap(), base)
  return r
}

/**
 * The frozen record `op` was loaded from, if `operationToDTO(op)` equals it (`writeOperationList`
 * then keeps the record instead of converting and comparing).
 */
export const recordOf = (op: Operation): OperationDTO | undefined => recordOfOperation.get(op)

function parseOperation(dto: OperationDTO): AppResult<Operation> {
  const tol = generalToleranceFromDTO(dto.generalTolerance)
  if (tol.isErr()) return tol
  const tool =
    dto.tool === undefined
      ? Ok<Option<DesignTool>>(None)
      : designToolFromDTO(dto.tool)
          .map((t): Option<DesignTool> => Some(t))
          .mapErr((e) => e.prefixIssues('tool'))
  if (tool.isErr()) return tool
  if ((dto.featureId === undefined) !== (dto.featureRole === undefined))
    return fail('input.malformed', `${dto.id}: featureId and featureRole go together`, {
      issues: [
        {
          path: [dto.featureId === undefined ? 'featureId' : 'featureRole'],
          rule: 'featureOwner',
          message: 'an owned operation has both featureId and featureRole',
        },
      ],
    })
  const base = {
    id: dto.id,
    name: dto.name,
    generalTolerance: tol.unwrap(),
    tool: tool.unwrap(),
    toolLocked: dto.toolLocked === true,
    owner:
      dto.featureId === undefined || dto.featureRole === undefined
        ? None
        : Some<FeatureOwner>({ featureId: dto.featureId, role: dto.featureRole }),
  }
  switch (dto.kind) {
    case 'facing': {
      const region = facingRegionFromDTO(dto.region)
      return collect<unknown>([q(dto.depth, 'depth'), region]).map(() => ({
        ...base,
        kind: 'facing',
        on: dto.on ?? DEFAULT_STOCK_FACE,
        depth: q(dto.depth).unwrap(),
        ...(region.unwrap() === undefined ? {} : { region: region.unwrap() }),
      }))
    }
    case 'pocket': {
      const shape = shapeFromDTO(dto.shape)
      const depth = q(dto.depth, 'depth')
      const floorRadius = q(dto.floorRadius, 'floorRadius')
      const pass = dto.roughingPass && marginsFromDTO(dto.roughingPass, 'roughingPass')
      const leave = dto.leave && marginsFromDTO(dto.leave, 'leave')
      return collect<unknown>([
        shape,
        depth,
        floorRadius,
        ...(pass === undefined ? [] : [pass]),
        ...(leave === undefined ? [] : [leave]),
      ]).map(() => ({
        ...base,
        kind: 'pocket',
        on: dto.on,
        shape: shape.unwrap(),
        depth: depth.unwrap(),
        floorRadius: floorRadius.unwrap(),
        ...(dto.through === true ? { through: true } : {}),
        ...(dto.roughing === true ? { roughing: true } : {}),
        ...(dto.roughingOf === undefined ? {} : { roughingOf: dto.roughingOf }),
        ...(pass === undefined ? {} : { roughingPass: pass.unwrap() }),
        ...(leave === undefined ? {} : { leave: leave.unwrap() }),
      }))
    }
    case 'drilling': {
      const center = pointFromDTO(dto.center, 'center')
      const diameter = q(dto.diameter, 'diameter')
      const depth = optQ(dto.depth, 'depth')
      const pointAngle = optQ(dto.pointAngle, 'pointAngle')
      return collect<unknown>([center, diameter, depth, pointAngle]).map(() => ({
        ...base,
        kind: 'drilling',
        on: dto.on,
        center: center.unwrap(),
        diameter: diameter.unwrap(),
        bottom: dto.bottom,
        depth: depth.unwrap(),
        pointAngle: pointAngle.unwrap(),
      }))
    }
    case 'profile': {
      const shape = shapeFromDTO(dto.shape)
      const slotWidth = q(dto.slotWidth, 'slotWidth')
      const count = q(dto.tabs.count, 'tabs', 'count')
      const width = q(dto.tabs.width, 'tabs', 'width')
      const thickness = q(dto.tabs.thickness, 'tabs', 'thickness')
      const depth = optQ(dto.depth, 'depth')
      const given = dto.tabs.positions
      const positions =
        given === undefined
          ? Ok<Option<readonly Quantity[]>>(None)
          : collect(given.map((p, i) => q(p, 'tabs', 'positions', i))).map(
              (l): Option<readonly Quantity[]> => Some(l),
            )
      const pass = dto.roughingPass && marginsFromDTO(dto.roughingPass, 'roughingPass')
      const leave = dto.leave && marginsFromDTO(dto.leave, 'leave')
      return collect<unknown>([
        shape,
        slotWidth,
        depth,
        count,
        width,
        thickness,
        positions,
        ...(pass === undefined ? [] : [pass]),
        ...(leave === undefined ? [] : [leave]),
      ]).map(() => ({
        ...base,
        kind: 'profile',
        on: dto.on ?? DEFAULT_STOCK_FACE,
        shape: shape.unwrap(),
        side: dto.side,
        slotWidth: slotWidth.unwrap(),
        depth: depth.unwrap(),
        tabs: {
          count: count.unwrap(),
          width: width.unwrap(),
          thickness: thickness.unwrap(),
          positions: positions.unwrap(),
        },
        ...(pass === undefined ? {} : { roughingPass: pass.unwrap() }),
        ...(dto.roughing === true ? { roughing: true as const } : {}),
        ...(dto.roughingOf === undefined ? {} : { roughingOf: dto.roughingOf }),
        ...(leave === undefined ? {} : { leave: leave.unwrap() }),
      }))
    }
    case 'chamfer': {
      const width = q(dto.width, 'width')
      const angle = q(dto.angle, 'angle')
      const stepdown = dto.stepdown === undefined ? Ok(undefined) : q(dto.stepdown, 'stepdown')
      const se = dto.sourceEdge
      const sourceEdge: AppResult<Option<ChamferSourceEdge>> =
        se === undefined
          ? Ok(None)
          : collect<unknown>([
              shapeFromDTO(se.shape),
              pointFromDTO(se.within.min, 'sourceEdge', 'within', 'min'),
              pointFromDTO(se.within.max, 'sourceEdge', 'within', 'max'),
            ]).map(([shape, min, max]) =>
              Some({ shape: shape as Shape, within: { min: min as Point, max: max as Point } }),
            )
      return collect<unknown>([width, angle, stepdown, sourceEdge]).map(([w, a, s, e]) => ({
        ...base,
        kind: 'chamfer',
        on: dto.on,
        edgeOf: dto.edgeOf,
        width: w as Quantity,
        angle: a as Quantity,
        stepdown: s === undefined ? None : Some(s as Quantity),
        sourceEdge: e as Option<ChamferSourceEdge>,
        loops: dto.loops === undefined ? None : Some([...dto.loops]),
        cornerLift: dto.cornerLift === true,
      }))
    }
    case 'line': {
      const paths = collect(
        dto.paths.map((p, i): AppResult<LinePath> => {
          const at = (x: readonly [QuantityDTO, QuantityDTO], kind: string, key: string) =>
            pointFromDTO(x, 'paths', String(i), kind, key)
          if ('segment' in p)
            return collect([
              at(p.segment.start, 'segment', 'start'),
              at(p.segment.end, 'segment', 'end'),
            ]).map(([start, end]): LinePath => ({ kind: 'segment', start: start!, end: end! }))
          if ('arc' in p)
            return collect([
              at(p.arc.start, 'arc', 'start'),
              at(p.arc.through, 'arc', 'through'),
              at(p.arc.end, 'arc', 'end'),
            ]).map(([start, through, end]): LinePath => ({
              kind: 'arc',
              start: start!,
              through: through!,
              end: end!,
            }))
          return shapeFromDTO(p)
            .map((s): LinePath => s as NamedPlacement)
            .mapErr((e) => e.prefixIssues('paths', i))
        }),
      )
      const d = dto.depth
      const depth: AppResult<LineDepth> =
        'start' in d
          ? collect([q(d.start, 'depth', 'start'), q(d.end, 'depth', 'end')]).map(
              ([start, end]): LineDepth => ({ kind: 'ramp', start: start!, end: end! }),
            )
          : 'min' in d
            ? collect([q(d.min, 'depth', 'min'), q(d.max, 'depth', 'max')]).map(
                ([min, max]): LineDepth => ({ kind: 'levels', min: min!, max: max! }),
              )
            : q(d, 'depth').map((v): LineDepth => ({ kind: 'constant', depth: v }))
      const blend = optQ(dto.blend, 'blend')
      const w = dto.within
      const within: AppResult<Option<{ min: Point; max: Point }>> =
        w === undefined
          ? Ok(None)
          : collect([
              pointFromDTO(w.min, 'within', 'min'),
              pointFromDTO(w.max, 'within', 'max'),
            ]).map(([min, max]) => Some({ min: min!, max: max! }))
      return collect<unknown>([paths, depth, blend, within]).map(() => ({
        ...base,
        kind: 'line',
        on: dto.on,
        paths: paths.unwrap(),
        depth: depth.unwrap(),
        blend: blend.unwrap(),
        within: within.unwrap(),
      }))
    }
  }
}

/** A Line path's record: a named placement as a shape's, an inline element as `{ segment }` / `{ arc }`. */
function linePathToDTO(p: LinePath): LinePathItemDTO {
  if (!isInlinePath(p)) return shapeToDTO(p) as LinePathItemDTO
  const pt = (q: Point) => [q[0].toDTO(), q[1].toDTO()] as PointDTO
  return p.kind === 'segment'
    ? { segment: { start: pt(p.start), end: pt(p.end) } }
    : { arc: { start: pt(p.start), through: pt(p.through), end: pt(p.end) } }
}

/** DF145: a facing's stored region (`band` or `shape`), absent = the whole face. */
function facingRegionFromDTO(r: FacingDTO['region']): AppResult<FacingRegion | undefined> {
  if (r === undefined) return Ok(undefined)
  if ('band' in r)
    return q(r.band.width, 'region', 'band', 'width').map((width) => ({
      kind: 'band',
      edge: r.band.edge,
      width,
    }))
  return shapeFromDTO(r.shape).map((shape) => ({ kind: 'shape', shape }))
}

function facingRegionToDTO(r: FacingRegion): NonNullable<FacingDTO['region']> {
  return r.kind === 'band'
    ? ({ band: { edge: r.edge, width: r.width.toDTO() } } as NonNullable<FacingDTO['region']>)
    : { shape: shapeToDTO(r.shape) }
}

function shapeToDTO(s: Shape): OperationShapeDTO {
  const center = [s.center[0].toDTO(), s.center[1].toDTO()]
  // left out at the centre, so v0.1 records stay byte-identical
  const anchor =
    s.anchor.u === 'centre' && s.anchor.v === 'centre'
      ? {}
      : { anchor: { u: s.anchor.u, v: s.anchor.v } }
  // left out when absent, so v0.1 records stay byte-identical
  const rotation =
    s.kind !== 'circle' && s.rotation.isSome() ? { rotation: s.rotation.unwrap().toDTO() } : {}
  if (s.kind === 'named')
    return {
      kind: 'named',
      shapeId: s.shapeId,
      center,
      ...anchor,
      ...rotation,
      ...(s.mirror ? { mirror: true } : {}),
      // left out when absent, so records without a scale stay byte-identical
      ...(s.scale === undefined ? {} : { scale: s.scale }),
    } as OperationShapeDTO
  return (
    s.kind === 'circle'
      ? { kind: 'circle', center, ...anchor, diameter: s.diameter.toDTO() }
      : {
          kind: 'rectangle',
          center,
          ...anchor,
          length: s.length.toDTO(),
          width: s.width.toDTO(),
          cornerRadius: s.cornerRadius.toDTO(),
          // DF120: left out when off, so records without Round stay byte-identical
          ...(s.round === true ? { round: true } : {}),
          ...rotation,
        }
  ) as OperationShapeDTO
}

/** A facing's or profile's `on`, left out when it is the default (records stay as in v0.1). */
const stockFaceOn = (op: Operation) => (op.on === DEFAULT_STOCK_FACE ? {} : { on: op.on })

/** Quantity kinds are guaranteed by the parameter's field, so the kind-specific DTO type holds. */
export function operationToDTO(op: Operation): OperationDTO {
  const tol = generalToleranceToDTO(op.generalTolerance)
  const base = {
    id: op.id,
    name: op.name,
    ...(tol === undefined ? {} : { generalTolerance: tol }),
    // left out while auto with nothing chosen, so v0.1 records stay byte-identical
    ...(op.tool.isSome() ? { tool: designToolToDTO(op.tool.unwrap()) } : {}),
    ...(op.toolLocked ? { toolLocked: true as const } : {}),
    // left out on plain operations, so earlier records stay byte-identical
    ...(op.owner.isSome()
      ? { featureId: op.owner.unwrap().featureId, featureRole: op.owner.unwrap().role }
      : {}),
  }
  switch (op.kind) {
    case 'facing':
      return {
        kind: 'facing',
        ...base,
        ...stockFaceOn(op),
        depth: op.depth.toDTO(),
        // DF145: left out for the whole face, so earlier records stay byte-identical
        ...(op.region === undefined ? {} : { region: facingRegionToDTO(op.region) }),
      } as OperationDTO
    case 'pocket':
      return {
        kind: 'pocket',
        ...base,
        on: op.on,
        shape: shapeToDTO(op.shape),
        depth: op.depth.toDTO(),
        floorRadius: op.floorRadius.toDTO(),
        ...(op.through === true ? { through: true } : {}),
        ...(op.roughing === true ? { roughing: true } : {}),
        ...(op.roughingPass === undefined ? {} : { roughingPass: marginsToDTO(op.roughingPass) }),
        ...(op.roughingOf === undefined ? {} : { roughingOf: op.roughingOf }),
        ...(op.leave === undefined ? {} : { leave: marginsToDTO(op.leave) }),
      } as OperationDTO
    case 'drilling':
      return {
        kind: 'drilling',
        ...base,
        on: op.on,
        center: [op.center[0].toDTO(), op.center[1].toDTO()],
        diameter: op.diameter.toDTO(),
        bottom: op.bottom,
        ...(op.depth.isSome() ? { depth: op.depth.unwrap().toDTO() } : {}),
        ...(op.pointAngle.isSome() ? { pointAngle: op.pointAngle.unwrap().toDTO() } : {}),
      } as OperationDTO
    case 'profile':
      return {
        kind: 'profile',
        ...base,
        ...stockFaceOn(op),
        shape: shapeToDTO(op.shape),
        side: op.side,
        slotWidth: op.slotWidth.toDTO(),
        ...(op.depth.isSome() ? { depth: op.depth.unwrap().toDTO() } : {}),
        tabs: {
          count: op.tabs.count.toDTO(),
          width: op.tabs.width.toDTO(),
          thickness: op.tabs.thickness.toDTO(),
          ...(op.tabs.positions.isSome()
            ? { positions: op.tabs.positions.unwrap().map((p) => p.toDTO()) }
            : {}),
        },
        ...(op.roughingPass === undefined ? {} : { roughingPass: marginsToDTO(op.roughingPass) }),
        ...(op.roughing === true ? { roughing: true } : {}),
        ...(op.roughingOf === undefined ? {} : { roughingOf: op.roughingOf }),
        ...(op.leave === undefined ? {} : { leave: marginsToDTO(op.leave) }),
      } as OperationDTO
    case 'chamfer':
      return {
        kind: 'chamfer',
        ...base,
        on: op.on,
        edgeOf: op.edgeOf,
        width: op.width.toDTO(),
        angle: op.angle.toDTO(),
        ...(op.stepdown.isSome() ? { stepdown: op.stepdown.unwrap().toDTO() } : {}),
        ...(op.sourceEdge.isSome()
          ? {
              sourceEdge: {
                shape: shapeToDTO(op.sourceEdge.unwrap().shape),
                within: {
                  min: op.sourceEdge.unwrap().within.min.map((x) => x.toDTO()),
                  max: op.sourceEdge.unwrap().within.max.map((x) => x.toDTO()),
                },
              },
            }
          : {}),
        ...(op.loops.isSome() ? { loops: [...op.loops.unwrap()] } : {}),
        ...(op.cornerLift ? { cornerLift: true } : {}),
      } as OperationDTO
    case 'line':
      return {
        kind: 'line',
        ...base,
        on: op.on,
        paths: op.paths.map((p) => linePathToDTO(p)),
        depth:
          op.depth.kind === 'constant'
            ? op.depth.depth.toDTO()
            : op.depth.kind === 'ramp'
              ? { start: op.depth.start.toDTO(), end: op.depth.end.toDTO() }
              : { min: op.depth.min.toDTO(), max: op.depth.max.toDTO() },
        ...(op.blend.isSome() ? { blend: op.blend.unwrap().toDTO() } : {}),
        ...(op.within.isSome()
          ? {
              within: {
                min: op.within.unwrap().min.map((x) => x.toDTO()),
                max: op.within.unwrap().max.map((x) => x.toDTO()),
              },
            }
          : {}),
      } as OperationDTO
  }
}

export function partFromDTO(dto: PartDTO): AppResult<Part> {
  const tol = generalToleranceFromDTO(dto.generalTolerance)
  const ops = collect(
    dto.operations.map((o, i) =>
      operationFromDTO(o).mapErr((e) => e.prefixIssues('operations', i)),
    ),
  )
  const shapes = referencedShapes(dto)
  return collect<unknown>([tol, ops, shapes]).map(() => ({
    id: dto.id,
    name: dto.name,
    stock: dto.stock,
    generalTolerance: tol.unwrap(),
    operations: ops.unwrap(),
    ...(shapes.unwrap().size === 0 ? {} : { shapes: shapes.unwrap() }),
  }))
}

/**
 * The named shapes the part's operations reference, loaded (design-v0.3.md#persistence): a
 * `named` shape whose `shapeId` does not exist makes the part `input.malformed` (corruption,
 * never repaired). Shapes nothing references are not loaded (shapes.md#implementation-k2).
 */
function referencedShapes(dto: PartDTO): AppResult<ReadonlyMap<string, NamedShape>> {
  const out = new Map<string, NamedShape>()
  const results: AppResult<unknown>[] = []
  dto.operations.forEach((op, i) => {
    for (const { id, path } of placedShapeIds(op)) {
      if (out.has(id)) continue
      const k = dto.shapes?.findIndex((s) => s.id === id) ?? -1
      if (k < 0) {
        results.push(
          fail('input.malformed', `${op.id} places shape ${id}, which the part does not have`, {
            issues: [
              {
                path: ['operations', i, ...path],
                rule: 'unknownShape',
                message: 'no such shape in the part',
              },
            ],
            data: { operationId: op.id, shapeId: id },
          }),
        )
        continue
      }
      const s = namedShapeFromDTO(dto.shapes![k]!).mapErr((e) => e.prefixIssues('shapes', k))
      results.push(s)
      if (s.isOk()) out.set(id, s.unwrap())
    }
  })
  results.push(patternCells(out, dto))
  return collect(results).map(() => out)
}

/**
 * The named shapes the loaded shapes refer to, added to `out`: an offset item's source, an owned
 * pattern's cell (patterns P1), boundary and lower pattern, an engraving's motif and boundary; a
 * shape that does not exist is `input.malformed` (`unknownShape`). Re-anchoring an operation on
 * a named shape uses it too (commands.ts, X2).
 */
export function patternCells(
  out: Map<string, NamedShape>,
  dto: Pick<PartDTO, 'shapes'>,
): AppResult<void> {
  // a worklist: a stacked pattern's lower pattern (P4) brings its own cell and boundary
  const queue = [...out.values()]
  for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
    const p = s.pattern
    const e = s.engraving
    // the cell, (patterns P2) the boundary shape and (P4) the pattern below; an engraving's
    // motif shapes and boundary (engraved-patterns.md E3)
    const refs: [string, string][] = []
    // a named shape's offset sources (design-llm-first.md § Offset item), at items.<n>.shapeId
    s.items.forEach((item, n) => {
      if (item.kind === 'offset') refs.push([`items.${n}`, item.shapeId])
    })
    if (p !== undefined) {
      if ('shapeId' in p.cell) refs.push(['cell', p.cell.shapeId])
      if (p.area !== undefined) refs.push(['area', p.area.shapeId])
      if (p.floor !== undefined) refs.push(['floor', p.floor])
    }
    if (e !== undefined) {
      if ('shapeIds' in e.motif) for (const id of e.motif.shapeIds) refs.push(['motif', id])
      if (e.area !== undefined) refs.push(['area', e.area.shapeId])
    }
    for (const [field, id] of refs) {
      if (out.has(id)) continue
      const k = dto.shapes?.findIndex((x) => x.id === id) ?? -1
      if (k < 0)
        return fail(
          'input.malformed',
          `${s.id} takes shape ${id} as its ${field === 'area' ? 'boundary' : field.startsWith('items.') ? 'offset source' : field}, which the part does not have`,
          {
            issues: [
              {
                path: field.startsWith('items.')
                  ? ['shapes', s.id, 'items', Number(field.slice('items.'.length)), 'shapeId']
                  : ['shapes', s.id, p !== undefined ? 'pattern' : 'engraving', field, 'shapeId'],
                rule: 'unknownShape',
                message: 'no such shape in the part',
              },
            ],
            data: { shapeId: id },
          },
        )
      const c = namedShapeFromDTO(dto.shapes![k]!).mapErr((e) => e.prefixIssues('shapes', k))
      if (c.isErr()) return c
      out.set(id, c.unwrap())
      queue.push(c.unwrap())
    }
  }
  return Ok(undefined)
}

/**
 * The named shapes `ops` place, loaded from the part's `shapes` (commands: the operations after
 * an edit may place a shape the stored part did not). A `shapeId` the part does not have is
 * `input.malformed` (`unknownShape`, at `operations.<id>.shape.shapeId`).
 */
export function shapesOf(
  ops: readonly Operation[],
  dto: Pick<PartDTO, 'shapes'>,
): AppResult<ReadonlyMap<string, NamedShape>> {
  const out = new Map<string, NamedShape>()
  for (const op of ops) {
    for (const { id, path } of placedShapeIds(op)) {
      if (out.has(id)) continue
      const k = dto.shapes?.findIndex((s) => s.id === id) ?? -1
      if (k < 0)
        return fail(
          'input.malformed',
          `${op.id} places shape ${id}, which the part does not have`,
          {
            issues: [
              {
                path: ['operations', op.id, ...path],
                rule: 'unknownShape',
                message: 'no such shape in the part',
              },
            ],
            data: { operationId: op.id, shapeId: id },
          },
        )
      const s = namedShapeFromDTO(dto.shapes![k]!).mapErr((e) => e.prefixIssues('shapes', k))
      if (s.isErr()) return s
      out.set(id, s.unwrap())
    }
  }
  return patternCells(out, dto).map(() => out)
}

/**
 * The named shapes an operation (model or record) places, with the path of each `shapeId`: a
 * pocket's or profile's `named` shape, every path of a Line (engraved-patterns.md E1).
 */
export function placedShapeIds(
  op: OperationDTO | Operation,
): { id: string; path: (string | number)[] }[] {
  if (op.kind === 'line')
    return op.paths.flatMap((p, i) =>
      'shapeId' in p ? [{ id: p.shapeId, path: ['paths', i, 'shapeId'] }] : [],
    )
  if ((op.kind === 'pocket' || op.kind === 'profile') && op.shape.kind === 'named')
    return [{ id: op.shape.shapeId, path: ['shape', 'shapeId'] }]
  // DF145: a facing's shape region
  const region = op.kind === 'facing' ? op.region : undefined
  if (region !== undefined && 'shape' in region && region.shape.kind === 'named')
    return [{ id: region.shape.shapeId, path: ['region', 'shape', 'shapeId'] }]
  return []
}
