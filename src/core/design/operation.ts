/**
 * Operations and parts with `Quantity` values (the DTOs in part.dto.ts, loaded), plus their
 * fields: field kinds, defaults and parameter paths.
 * Doc: docs/modes/design.md#operations-v01, docs/modes/design.md#implementation-task-25
 */
import { collect, None, Ok, Some, type AppResult, type Option } from '../../shared/result'
import { quantityFromDTO } from '../library/item'
import type { ParseContext } from '../quantity/parse'
import type { Quantity } from '../quantity/quantity'
import type { QuantityDTO } from '../quantity/quantity.dto'
import { Tolerance } from '../quantity/tolerance'
import type { UnitSystem } from '../project/document'
import type {
  DrillBottomKind,
  GeneralToleranceDTO,
  OperationDTO,
  OperationKind,
  PartDTO,
  ShapeDTO,
} from './part.dto'

export type Point = readonly [Quantity, Quantity]

export type Shape =
  | {
      readonly kind: 'rectangle'
      readonly center: Point
      readonly length: Quantity
      readonly width: Quantity
      readonly cornerRadius: Quantity
    }
  | { readonly kind: 'circle'; readonly center: Point; readonly diameter: Quantity }

export interface GeneralTolerance {
  readonly length: Option<Quantity>
  readonly angle: Option<Quantity>
}

interface Common {
  readonly id: string
  readonly name: string
  readonly generalTolerance: GeneralTolerance
}

export interface Facing extends Common {
  readonly kind: 'facing'
  readonly depth: Quantity
}
export interface Pocket extends Common {
  readonly kind: 'pocket'
  readonly on: string
  readonly shape: Shape
  readonly depth: Quantity
  readonly floorRadius: Quantity
}
export interface Drilling extends Common {
  readonly kind: 'drilling'
  readonly on: string
  readonly center: Point
  readonly diameter: Quantity
  readonly bottom: DrillBottomKind
  readonly depth: Option<Quantity>
  readonly pointAngle: Option<Quantity>
}
export interface Profile extends Common {
  readonly kind: 'profile'
  readonly shape: Shape
  readonly side: 'outside' | 'inside'
  readonly slotWidth: Quantity
  readonly tabs: {
    readonly count: Quantity
    readonly width: Quantity
    readonly thickness: Quantity
  }
}
export type Operation = Facing | Pocket | Drilling | Profile

export interface Part {
  readonly id: string
  readonly name: string
  /** Stock snapshot id. */
  readonly stock: string
  readonly generalTolerance: GeneralTolerance
  readonly operations: readonly Operation[]
}

/** Id prefix of an operation kind: `facing1`, `pocket1`, `drill1`, `profile1`. */
export const ID_PREFIX: Record<OperationKind, string> = {
  facing: 'facing',
  pocket: 'pocket',
  drilling: 'drill',
  profile: 'profile',
}

/** Display name of an operation kind (default `name`, command titles). */
export const KIND_LABEL: Record<OperationKind, string> = {
  facing: 'Facing',
  pocket: 'Pocket',
  drilling: 'Drilling',
  profile: 'Profile',
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
    } else add('shape.diameter', s.diameter)
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
      add('tabs.count', op.tabs.count)
      add('tabs.width', op.tabs.width)
      add('tabs.thickness', op.tabs.thickness)
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
      : ({ ...s, [rest]: value } as Shape)
    return { ...op, shape }
  }
  if (op.kind === 'drilling' && head === 'center')
    return { ...op, center: point(op.center, sub ?? '0') }
  if (op.kind === 'profile' && head === 'tabs' && sub !== undefined)
    return { ...op, tabs: { ...op.tabs, [sub]: value } }
  if (op.kind === 'drilling' && (head === 'depth' || head === 'pointAngle'))
    return { ...op, [head]: Some(value) }
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

function shapeFromDTO(s: ShapeDTO): AppResult<Shape> {
  const center = pointFromDTO(s.center, 'shape', 'center')
  if (s.kind === 'circle')
    return collect<unknown>([center, q(s.diameter, 'shape', 'diameter')]).map(() => ({
      kind: 'circle',
      center: center.unwrap(),
      diameter: q(s.diameter).unwrap(),
    }))
  const fields = [
    q(s.length, 'shape', 'length'),
    q(s.width, 'shape', 'width'),
    q(s.cornerRadius, 'shape', 'cornerRadius'),
  ]
  return collect<unknown>([center, ...fields]).map(() => {
    const [length, width, cornerRadius] = fields.map((f) => f.unwrap())
    return {
      kind: 'rectangle',
      center: center.unwrap(),
      length: length!,
      width: width!,
      cornerRadius: cornerRadius!,
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

/** Builds the operation from a shape-checked DTO; quantity issues carry parameter paths. */
export function operationFromDTO(dto: OperationDTO): AppResult<Operation> {
  const tol = generalToleranceFromDTO(dto.generalTolerance)
  if (tol.isErr()) return tol
  const base = { id: dto.id, name: dto.name, generalTolerance: tol.unwrap() }
  switch (dto.kind) {
    case 'facing':
      return q(dto.depth, 'depth').map((depth) => ({ ...base, kind: 'facing', depth }))
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
      return collect<unknown>([shape, slotWidth, count, width, thickness]).map(() => ({
        ...base,
        kind: 'profile',
        shape: shape.unwrap(),
        side: dto.side,
        slotWidth: slotWidth.unwrap(),
        tabs: { count: count.unwrap(), width: width.unwrap(), thickness: thickness.unwrap() },
      }))
    }
  }
}

function shapeToDTO(s: Shape): ShapeDTO {
  const center = [s.center[0].toDTO(), s.center[1].toDTO()]
  return (
    s.kind === 'circle'
      ? { kind: 'circle', center, diameter: s.diameter.toDTO() }
      : {
          kind: 'rectangle',
          center,
          length: s.length.toDTO(),
          width: s.width.toDTO(),
          cornerRadius: s.cornerRadius.toDTO(),
        }
  ) as ShapeDTO
}

/** Quantity kinds are guaranteed by the parameter's field, so the kind-specific DTO type holds. */
export function operationToDTO(op: Operation): OperationDTO {
  const tol = generalToleranceToDTO(op.generalTolerance)
  const base = { id: op.id, name: op.name, ...(tol === undefined ? {} : { generalTolerance: tol }) }
  switch (op.kind) {
    case 'facing':
      return { kind: 'facing', ...base, depth: op.depth.toDTO() } as OperationDTO
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
        shape: shapeToDTO(op.shape),
        side: op.side,
        slotWidth: op.slotWidth.toDTO(),
        tabs: {
          count: op.tabs.count.toDTO(),
          width: op.tabs.width.toDTO(),
          thickness: op.tabs.thickness.toDTO(),
        },
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
  return collect<unknown>([tol, ops]).map(() => ({
    id: dto.id,
    name: dto.name,
    stock: dto.stock,
    generalTolerance: tol.unwrap(),
    operations: ops.unwrap(),
  }))
}
