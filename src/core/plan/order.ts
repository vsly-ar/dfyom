/**
 * Machining order: the default order of plan operations and the order checks.
 * Doc: docs/modes/plan-v0.1.md#plan-operations-and-order
 */
import { isGeneralShape, type Operation, type Part, type Shape } from '../design/operation'
import { shapeCentre } from '../design/anchor'
import type { OperationKind } from '../design/part.dto'
import { placeShape } from '../design/placement'
import { DIRECTIONS, STOCK_FACE, type Direction } from '../geometry/face'
import type { Region2dPort } from '../geometry/2d/port'
import type { Vec2 } from '../geometry/model'
import type { PlanWarning } from './checks'
import type { PlanOperationDTO } from './plan.dto'

/** Default group order: facing, drilling, pockets, profiles (cutouts last). */
const RANK: Record<OperationKind, number> = { facing: 0, drilling: 1, pocket: 2, profile: 3 }

/** The operation id owning a surface id (`facing1.floor` → `facing1`); stock surfaces: none. */
export function ownerOf(surfaceId: string): string | undefined {
  const id = surfaceId.split('.')[0]
  return id === undefined || id === 'stock' ? undefined : id
}

const STOCK_DIRECTION = new Map(DIRECTIONS.map((d) => [STOCK_FACE[d], d]))

/** Approach direction of a surface: the stock face its `on` chain starts from (`+z` if dangling). */
export function surfaceDirection(
  surfaceId: string,
  byId: ReadonlyMap<string, Operation>,
): Direction {
  let id = surfaceId
  for (let i = 0; i <= byId.size; i++) {
    const stock = STOCK_DIRECTION.get(id)
    if (stock !== undefined) return stock
    const owner = byId.get(ownerOf(id) ?? '')
    if (owner === undefined) break
    id = owner.on
  }
  return '+z'
}

/** Approach direction of each plan operation: its first design operation's `on` face. */
export function operationDirections(
  planOps: readonly PlanOperationDTO[],
  part: Part,
): Map<string, Direction> {
  const byId = new Map(part.operations.map((o) => [o.id, o]))
  return new Map(
    planOps.map((p) => {
      const op = byId.get(p.designOperationIds[0]!)
      return [p.id, op === undefined ? '+z' : surfaceDirection(op.on, byId)]
    }),
  )
}

/** Design operations whose surface an operation starts from (`on`). */
function onDependencies(op: Operation): string[] {
  if (op.kind !== 'pocket' && op.kind !== 'drilling') return []
  const owner = ownerOf(op.on)
  return owner === undefined ? [] : [owner]
}

interface Info {
  readonly op: PlanOperationDTO
  readonly rank: number
  readonly designIndex: number
  /** Plan operations that must come first. */
  readonly deps: ReadonlySet<string>
}

function infos(planOps: readonly PlanOperationDTO[], part: Part): Info[] {
  const index = new Map(part.operations.map((o, i) => [o.id, i]))
  const owner = new Map<string, string>()
  for (const p of planOps) for (const d of p.designOperationIds) owner.set(d, p.id)
  return planOps.map((p) => {
    const ops = p.designOperationIds.flatMap((d) => {
      const o = part.operations[index.get(d) ?? -1]
      return o === undefined ? [] : [o]
    })
    const deps = new Set<string>()
    for (const o of ops)
      for (const d of onDependencies(o)) {
        const q = owner.get(d)
        if (q !== undefined && q !== p.id) deps.add(q)
      }
    return {
      op: p,
      rank: RANK[ops[0]?.kind ?? 'profile'],
      designIndex: Math.min(...p.designOperationIds.map((d) => index.get(d) ?? Infinity)),
      deps,
    }
  })
}

/**
 * Default machining order: by group, then design order, with operations of one tool kept
 * adjacent within a group; an operation never precedes one whose surface it starts from.
 */
export function defaultOrder(planOps: readonly PlanOperationDTO[], part: Part): PlanOperationDTO[] {
  const all = infos(planOps, part).sort((a, b) => a.rank - b.rank || a.designIndex - b.designIndex)
  // tool order within a group: first appearance in design order
  const toolOrder = new Map<string, number>()
  all.forEach((x, i) => {
    const key = `${x.rank}:${x.op.tool ?? `none-${x.op.id}`}`
    if (!toolOrder.has(key)) toolOrder.set(key, i)
  })
  const sortKey = (x: Info) => [
    x.rank,
    toolOrder.get(`${x.rank}:${x.op.tool ?? `none-${x.op.id}`}`) ?? 0,
    x.designIndex,
  ]
  const less = (a: Info, b: Info) => {
    const ka = sortKey(a)
    const kb = sortKey(b)
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]!
    return false
  }
  const done = new Set<string>()
  const out: PlanOperationDTO[] = []
  let rest = all
  while (rest.length > 0) {
    const ready = rest.filter((x) => [...x.deps].every((d) => done.has(d)))
    // a dependency cycle cannot happen (references point to earlier design operations)
    const pool = ready.length > 0 ? ready : rest
    const next = pool.reduce((best, x) => (less(x, best) ? x : best))
    out.push(next.op)
    done.add(next.op.id)
    rest = rest.filter((x) => x !== next)
  }
  return out
}

/**
 * The list with every `on` dependency satisfied, otherwise in its current order: a stable
 * topological order by list position (the dependency rule of `defaultOrder`), so a rebuild keeps
 * the user's order where it can and re-checks kept operations too.
 */
export function repairOrder(planOps: readonly PlanOperationDTO[], part: Part): PlanOperationDTO[] {
  const done = new Set<string>()
  const out: PlanOperationDTO[] = []
  let rest = infos(planOps, part)
  while (rest.length > 0) {
    const next = rest.find((x) => [...x.deps].every((d) => done.has(d))) ?? rest[0]!
    out.push(next.op)
    done.add(next.op.id)
    rest = rest.filter((x) => x !== next)
  }
  return out
}

/** Axis-aligned bounds of an operation's shape in its face frame (`[u, v]`, mm). */
interface Box {
  readonly min: Vec2
  readonly max: Vec2
}

/**
 * The bounds of a shape in its face frame: v0.1 rectangles and circles analytically; general
 * shapes (named, rotated) by their placed bounding box (v0.3 T3, with the 2D port; without it, or
 * when the shape does not place, none: the shape is skipped).
 */
function shapeBox(shape: Shape, part: Part, port: Region2dPort | undefined): Box | undefined {
  if (isGeneralShape(shape)) {
    if (port === undefined) return undefined
    const placed = placeShape(port, shape, part.shapes)
    if (placed.isErr()) return undefined
    const { centre, size } = placed.unwrap()
    return {
      min: [centre[0] - size[0] / 2, centre[1] - size[1] / 2],
      max: [centre[0] + size[0] / 2, centre[1] + size[1] / 2],
    }
  }
  const [cx, cy] = shapeCentre(shape)
  const [hu, hv] =
    shape.kind === 'circle'
      ? [shape.diameter.canonical / 2, shape.diameter.canonical / 2]
      : shape.kind === 'rectangle'
        ? [shape.length.canonical / 2, shape.width.canonical / 2]
        : [0, 0]
  return { min: [cx - hu, cy - hv], max: [cx + hu, cy + hv] }
}

/**
 * True if the point lies inside the shape: a circle by its radius, a rectangle (and since T3 a
 * general shape) by its bounding box; open bounds.
 */
function inside(shape: Shape, part: Part, port: Region2dPort | undefined, p: Vec2): boolean {
  if (shape.kind === 'circle') {
    const [cx, cy] = shapeCentre(shape)
    return Math.hypot(p[0] - cx, p[1] - cy) < shape.diameter.canonical / 2
  }
  const b = shapeBox(shape, part, port)
  return b !== undefined && p[0] > b.min[0] && p[0] < b.max[0] && p[1] > b.min[1] && p[1] < b.max[1]
}

/** Where an operation lies: a hole's centre, a shape's bounding-box centre. */
function centerOf(op: Operation, part: Part, port: Region2dPort | undefined): Vec2 | undefined {
  if (op.kind === 'drilling') return [op.center[0].canonical, op.center[1].canonical]
  if (op.kind !== 'pocket' && op.kind !== 'profile') return undefined
  const b = shapeBox(op.shape, part, port)
  return b === undefined ? undefined : [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
}

/**
 * Order findings over the machining order of every setup: `plan.order` (error) when an operation
 * precedes one whose surface it starts from; `plan.loosePiece` (warning) when a profile comes
 * before an operation of the same face direction inside its shape (positions are face-frame;
 * general shapes by their placed bounding box, with the 2D port only).
 */
export function orderFindings(
  planOps: readonly PlanOperationDTO[],
  part: Part,
  port?: Region2dPort,
): PlanWarning[] {
  const out: PlanWarning[] = []
  const direction = operationDirections(planOps, part)
  const position = new Map(planOps.map((p, i) => [p.id, i]))
  const byId = new Map(part.operations.map((o) => [o.id, o]))
  const list = infos(planOps, part)
  list.forEach((x, i) => {
    for (const d of x.deps)
      if ((position.get(d) ?? -1) > i)
        out.push({
          code: 'plan.order',
          severity: 'error',
          message: `${x.op.id} starts from a surface of ${d}, which comes later`,
          planOperationId: x.op.id,
          rule: 'onBefore',
          params: { dependsOn: d },
        })
  })
  planOps.forEach((p, i) => {
    const profiles = p.designOperationIds
      .map((d) => byId.get(d))
      .filter((o): o is Extract<Operation, { kind: 'profile' }> => o?.kind === 'profile')
    for (const profile of profiles)
      for (const later of planOps.slice(i + 1)) {
        if (direction.get(later.id) !== direction.get(p.id)) continue
        for (const d of later.designOperationIds) {
          const o = byId.get(d)
          if (o === undefined || o.kind === 'profile') continue
          const c = centerOf(o, part, port)
          if (o.kind === 'facing' || (c !== undefined && inside(profile.shape, part, port, c))) {
            out.push({
              code: 'plan.loosePiece',
              severity: 'warning',
              message: `${profile.id} is cut before ${o.id} inside it: the piece may be loose`,
              planOperationId: later.id,
              rule: 'profileFirst',
              params: { profile: profile.id, operation: o.id },
            })
            break
          }
        }
      }
  })
  return out
}
