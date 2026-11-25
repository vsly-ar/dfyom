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
import type {
  AnchorDTO,
  DrillBottomKind,
  GeneralToleranceDTO,
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
}
export interface Pocket extends Common {
  readonly kind: 'pocket'
  readonly shape: Shape
  readonly depth: Quantity
  readonly floorRadius: Quantity
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
export type Operation = Facing | Pocket | Drilling | Profile | Chamfer

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
}

/** Display name of an operation kind (default `name`, command titles). */
export const KIND_LABEL: Record<OperationKind, string> = {
  facing: 'Facing',
  pocket: 'Pocket',
  drilling: 'Drilling',
  profile: 'Profile',
  chamfer: 'Chamfer',
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
  // stepped countersink terrace height (design-v0.4.md#stepped-countersink-f7-d41)
  csStepdown: { mm: '1 mm', inch: '1/32"' },
  // chamfer operation (design-v0.4.md#chamfer-operation-v04-circular-edges): width (D45)
  chamferAngle: { mm: '90°', inch: '90°' },
  chamferWidth: { mm: '0.5 mm', inch: '1/64"' },
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
  return { ...op, [head]: value } as Operation
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
    case 'facing':
      return q(dto.depth, 'depth').map((depth) => ({
        ...base,
        kind: 'facing',
        on: dto.on ?? DEFAULT_STOCK_FACE,
        depth,
      }))
    case 'pocket': {
      const shape = shapeFromDTO(dto.shape)
      const depth = q(dto.depth, 'depth')
      const floorRadius = q(dto.floorRadius, 'floorRadius')
      return collect<unknown>([shape, depth, floorRadius]).map(() => ({
        ...base,
        kind: 'pocket',
        on: dto.on,
        shape: shape.unwrap(),
        depth: depth.unwrap(),
        floorRadius: floorRadius.unwrap(),
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
      return collect<unknown>([shape, slotWidth, depth, count, width, thickness, positions]).map(
        () => ({
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
        }),
      )
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
  }
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
      } as OperationDTO
    case 'pocket':
      return {
        kind: 'pocket',
        ...base,
        on: op.on,
        shape: shapeToDTO(op.shape),
        depth: op.depth.toDTO(),
        floorRadius: op.floorRadius.toDTO(),
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
    if ((op.kind !== 'pocket' && op.kind !== 'profile') || op.shape.kind !== 'named') return
    const id = op.shape.shapeId
    if (out.has(id)) return
    const k = dto.shapes?.findIndex((s) => s.id === id) ?? -1
    if (k < 0) {
      results.push(
        fail('input.malformed', `${op.id} places shape ${id}, which the part does not have`, {
          issues: [
            {
              path: ['operations', i, 'shape', 'shapeId'],
              rule: 'unknownShape',
              message: 'no such shape in the part',
            },
          ],
          data: { operationId: op.id, shapeId: id },
        }),
      )
      return
    }
    const s = namedShapeFromDTO(dto.shapes![k]!).mapErr((e) => e.prefixIssues('shapes', k))
    results.push(s)
    if (s.isOk()) out.set(id, s.unwrap())
  })
  return collect(results).map(() => out)
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
    if ((op.kind !== 'pocket' && op.kind !== 'profile') || op.shape.kind !== 'named') continue
    const id = op.shape.shapeId
    if (out.has(id)) continue
    const k = dto.shapes?.findIndex((s) => s.id === id) ?? -1
    if (k < 0)
      return fail('input.malformed', `${op.id} places shape ${id}, which the part does not have`, {
        issues: [
          {
            path: ['operations', op.id, 'shape', 'shapeId'],
            rule: 'unknownShape',
            message: 'no such shape in the part',
          },
        ],
        data: { operationId: op.id, shapeId: id },
      })
    const s = namedShapeFromDTO(dto.shapes![k]!).mapErr((e) => e.prefixIssues('shapes', k))
    if (s.isErr()) return s
    out.set(id, s.unwrap())
  }
  return Ok(out)
}
