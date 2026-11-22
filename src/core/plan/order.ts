/**
 * Machining order: the default order of plan operations and the order checks.
 * Doc: docs/modes/plan-v0.1.md#plan-operations-and-order
 */
import type { Operation, Part, Shape } from '../design/operation'
import { shapeCentre } from '../design/anchor'
import type { OperationKind } from '../design/part.dto'
import { DIRECTIONS, STOCK_FACE, type Direction } from '../geometry/face'
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

/** True if the point lies inside the shape's bounds (v0.1: axis-aligned rectangles, circles). */
function inside(shape: Shape, x: number, y: number): boolean {
  const [cx, cy] = shapeCentre(shape)
  if (shape.kind === 'circle') return Math.hypot(x - cx, y - cy) < shape.diameter.canonical / 2
  return (
    Math.abs(x - cx) < shape.length.canonical / 2 && Math.abs(y - cy) < shape.width.canonical / 2
  )
}

function centerOf(op: Operation): [number, number] | undefined {
  if (op.kind === 'drilling') return [op.center[0].canonical, op.center[1].canonical]
  if (op.kind === 'pocket' || op.kind === 'profile') return [...shapeCentre(op.shape)]
  return undefined
}

/**
 * Order findings over the machining order of every setup: `plan.order` (error) when an operation
 * precedes one whose surface it starts from; `plan.loosePiece` (warning) when a profile comes
 * before an operation of the same face direction inside its shape (positions are face-frame).
 */
export function orderFindings(planOps: readonly PlanOperationDTO[], part: Part): PlanWarning[] {
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
          const c = centerOf(o)
          if (o.kind === 'facing' || (c !== undefined && inside(profile.shape, c[0], c[1]))) {
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
