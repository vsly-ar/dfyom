/**
 * Machining order: the default order of plan operations and the order checks.
 * Doc: docs/modes/plan-v0.1.md#plan-operations-and-order, docs/modes/plan-v0.4.md#machining-order-v2
 */
import { isGeneralShape, type Operation, type Part, type Shape } from '../design/operation'
import { shapeCentre } from '../design/anchor'
import { ownedOperationId } from '../design/feature'
import type { OperationKind } from '../design/part.dto'
import { placeShape } from '../design/placement'
import { DIRECTIONS, STOCK_FACE, type Direction } from '../geometry/face'
import type { Region2dPort } from '../geometry/2d/port'
import type { Vec2 } from '../geometry/model'
import type { PlanWarning } from './checks'
import type { PlanOperationDTO } from './plan.dto'

/** Kind group order within a tool run: facing, drilling, pockets, chamfers, profiles. */
const RANK: Record<OperationKind, number> = {
  facing: 0,
  drilling: 1,
  pocket: 2,
  chamfer: 3,
  profile: 4,
}

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

/** Design operations whose surface an operation starts from (`on`); a chamfer's is its edge's. */
export function onDependencies(op: Operation): string[] {
  if (op.kind !== 'pocket' && op.kind !== 'drilling' && op.kind !== 'chamfer') return []
  const owner = ownerOf(op.on)
  return owner === undefined ? [] : [owner]
}

/** The design operation whose edge a chamfer bevels (plan-v0.4.md § Chamfer toolpath, T1). */
export function edgeDependencies(op: Operation): string[] {
  return op.kind === 'chamfer' ? [op.edgeOf] : []
}

/** A pattern's roughing pocket, which its pocket follows (DF108, rest machining). */
export function restDependencies(op: Operation): string[] {
  if (op.kind !== 'pocket' || op.roughing === true || op.owner.isNone()) return []
  const { featureId, role } = op.owner.unwrap()
  return role === 'pocket' ? [ownedOperationId(featureId, 'roughing')] : []
}

interface Info {
  readonly op: PlanOperationDTO
  readonly rank: number
  readonly designIndex: number
  /** Plan operations that must come first (`on` surfaces and chamfer edges). */
  readonly deps: ReadonlySet<string>
  /** Of them, the plan operations cutting a chamfer's edge. */
  readonly edgeDeps: ReadonlySet<string>
  /**
   * The roughing plan operation a pattern's pocket follows (DF108): ordered first by the default
   * and repaired order, never an order finding (the pocket then clears every cell itself).
   */
  readonly rest: ReadonlySet<string>
  /**
   * The edge plan operation a chamfer shares its tool with (a stepped countersink's bore, F7):
   * the chamfer is kept right after it, so no other tool comes between them.
   */
  readonly follows: string | undefined
}

function infos(planOps: readonly PlanOperationDTO[], part: Part): Info[] {
  const index = new Map(part.operations.map((o, i) => [o.id, i]))
  const owner = new Map<string, string>()
  for (const p of planOps) for (const d of p.designOperationIds) owner.set(d, p.id)
  const toolOf = new Map(planOps.map((p) => [p.id, p.tool]))
  return planOps.map((p) => {
    const ops = p.designOperationIds.flatMap((d) => {
      const o = part.operations[index.get(d) ?? -1]
      return o === undefined ? [] : [o]
    })
    const deps = new Set<string>()
    const edgeDeps = new Set<string>()
    const rest = new Set<string>()
    for (const o of ops) {
      for (const d of onDependencies(o)) {
        const q = owner.get(d)
        if (q !== undefined && q !== p.id) deps.add(q)
      }
      // DF108: a pattern's pocket after its roughing (rest machining), not an order error
      for (const d of restDependencies(o)) {
        const q = owner.get(d)
        if (q !== undefined && q !== p.id) rest.add(q)
      }
      for (const d of edgeDependencies(o)) {
        const q = owner.get(d)
        if (q !== undefined && q !== p.id) edgeDeps.add(q)
      }
    }
    return {
      op: p,
      // alignment aids: holes with the drillings, marks after everything (alignment.md § Order)
      rank:
        p.aid !== undefined
          ? p.aid.kind === 'registrationHole'
            ? RANK.drilling
            : RANK.profile + 1
          : RANK[ops[0]?.kind ?? 'profile'],
      designIndex: Math.min(...p.designOperationIds.map((d) => index.get(d) ?? Infinity)),
      deps: new Set([...deps, ...edgeDeps, ...rest]),
      edgeDeps,
      rest,
      follows:
        p.tool === undefined ? undefined : [...edgeDeps].find((d) => toolOf.get(d) === p.tool),
    }
  })
}

/** The tool run of a plan operation: its tool copy; without a tool, a run of its own. */
const runKey = (p: PlanOperationDTO): string => p.tool ?? `none:${p.id}`

/** Order within a tool run: kind group, design order; an F7 follower right behind its edge. */
function runSortKey(byId: ReadonlyMap<string, Info>): (x: Info) => number[] {
  return (x) => {
    const l = x.follows === undefined ? x : (byId.get(x.follows) ?? x)
    return [l.rank, l.designIndex, l === x ? 0 : 1, x.designIndex]
  }
}

function lessKey(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!
  return false
}

/** Runs the search explores before it takes the first candidate (a deterministic bound). */
const SEARCH_BUDGET = 5000

/**
 * Default machining order (plan-v0.4.md § Machining order v2): the fewest tool runs the
 * dependencies allow (`on` surfaces, chamfer edges, and a through profile after the operations it
 * frees, `freeingDependencies`). A run takes every operation of its tool as soon as it is ready,
 * by kind group and design order (a chamfer sharing its edge operation's tool right behind it,
 * F7); the tool of each next run is searched for the fewest runs, candidates tried in the order of
 * their first ready operation, the first minimal order kept. `port`: the 2D port for general
 * shapes in the freeing test (without it they free nothing). `startTool` (DF65: the last tool of
 * the setup before): when a minimal order can start with a run of that tool, it does; never at
 * the cost of a run.
 */
export function defaultOrder(
  planOps: readonly PlanOperationDTO[],
  part: Part,
  port?: Region2dPort,
  startTool?: string,
): PlanOperationDTO[] {
  const all = infos(planOps, part)
  const freeing = freeingDependencies(planOps, part, port)
  const byId = new Map(all.map((x) => [x.op.id, x]))
  const at = new Map(all.map((x, i) => [x.op.id, i]))
  const deps = all.map((x) =>
    [...x.deps, ...(freeing.get(x.op.id) ?? [])].flatMap((d) => {
      const i = at.get(d)
      return i === undefined ? [] : [i]
    }),
  )
  const keys = all.map(runSortKey(byId))
  const tools = all.map((x) => runKey(x.op))
  const n = all.length
  const first = (ids: readonly number[]): number =>
    ids.reduce((b, i) => (b < 0 || lessKey(keys[i]!, keys[b]!) ? i : b), -1)
  // the operations that can come next (a dependency cycle cannot happen: references point to
  // earlier design operations; if one did, the first remaining operation is taken anyway)
  const nextOps = (done: readonly boolean[]): number[] => {
    const ready: number[] = []
    const rest: number[] = []
    for (let i = 0; i < n; i++) {
      if (done[i]) continue
      rest.push(i)
      if (deps[i]!.every((d) => done[d])) ready.push(i)
    }
    return ready.length > 0 || rest.length === 0 ? ready : [first(rest)]
  }
  /** One run of `tool` from `done`: its operations in run order and the done set after it. */
  const run = (done: readonly boolean[], tool: string): { seq: number[]; done: boolean[] } => {
    const d = [...done]
    const seq: number[] = []
    for (;;) {
      const next = first(nextOps(d).filter((i) => tools[i] === tool))
      if (next < 0) return { seq, done: d }
      d[next] = true
      seq.push(next)
    }
  }
  /** The candidate tools of the next run, by their first ready operation. */
  const candidates = (done: readonly boolean[]): string[] => {
    const ready = nextOps(done)
    const out: string[] = []
    for (const i of [...ready].sort((a, b) => (lessKey(keys[a]!, keys[b]!) ? -1 : 1)))
      if (!out.includes(tools[i]!)) out.push(tools[i]!)
    return out
  }
  const memo = new Map<string, { runs: number; tool: string | undefined }>()
  const keyOf = (done: readonly boolean[]) => done.map((b) => (b ? '1' : '0')).join('')
  let budget = SEARCH_BUDGET
  const fewest = (done: readonly boolean[]): number => {
    if (done.every(Boolean)) return 0
    const key = keyOf(done)
    const hit = memo.get(key)
    if (hit !== undefined) return hit.runs
    const cands = candidates(done)
    let runs = Infinity
    let tool: string | undefined
    for (const t of budget > 0 ? cands : cands.slice(0, 1)) {
      budget--
      const r = 1 + fewest(run(done, t).done)
      if (r < runs) {
        runs = r
        tool = t
      }
    }
    memo.set(key, { runs, tool })
    return runs
  }
  let done: boolean[] = all.map(() => false)
  const least = fewest(done)
  // DF65: the setup before's last tool first, when that costs no run (a tie-break only)
  let start: string | undefined
  if (startTool !== undefined && candidates(done).includes(startTool)) {
    const r = run(done, startTool)
    if (r.seq.length > 0 && 1 + fewest(r.done) <= least) start = startTool
  }
  const out: PlanOperationDTO[] = []
  while (!done.every(Boolean)) {
    const tool = start ?? memo.get(keyOf(done))?.tool ?? candidates(done)[0]!
    start = undefined
    const r = run(done, tool)
    for (const i of r.seq) out.push(all[i]!.op)
    done = r.done
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

/**
 * The list with each of `ids` that is a chamfer sharing its edge operation's tool moved up to
 * right after that operation (and after its other dependencies): rebuild placement for new or
 * re-resolved operations, once their tools are known (F7). Others keep their position; the list
 * must satisfy every dependency already (`repairOrder`), and moving up keeps that.
 */
export function keepWithEdge(
  planOps: readonly PlanOperationDTO[],
  part: Part,
  ids: ReadonlySet<string>,
): PlanOperationDTO[] {
  const out = [...planOps]
  for (const x of infos(planOps, part)) {
    if (!ids.has(x.op.id) || x.follows === undefined) continue
    const from = out.indexOf(x.op)
    const at = Math.max(...[...x.deps].map((d) => out.findIndex((q) => q.id === d) + 1))
    if (at <= 0 || at >= from) continue
    out.splice(from, 1)
    out.splice(at, 0, x.op)
  }
  return out
}

/**
 * Rebuild placement of new plan operations once their tools are known (plan-v0.4.md § Machining
 * order v2): each of `ids`, in list order, moves to the position of its valid range that adds the
 * fewest tool changes (next to the operations already placed), the nearest to where it stood on
 * ties. The range: after its dependencies
 * (a freeing profile also after the operations it frees), before the operations depending on it
 * and before a freeing profile enclosing it; the freeing bounds only when they leave room (a
 * user's order that already cut the profile stays). The list must satisfy every dependency
 * already (`repairOrder`); the placement keeps that.
 */
export function placeByTool(
  planOps: readonly PlanOperationDTO[],
  part: Part,
  ids: ReadonlySet<string>,
  port?: Region2dPort,
): PlanOperationDTO[] {
  const list = infos(planOps, part)
  const freeing = freeingDependencies(planOps, part, port)
  const out = [...planOps]
  const pending = new Set(planOps.filter((p) => ids.has(p.id)).map((p) => p.id))
  for (const x of list) {
    if (!ids.has(x.op.id)) continue
    const orig = out.indexOf(x.op)
    out.splice(orig, 1)
    const pos = (id: string) => out.findIndex((q) => q.id === id)
    const after = (ds: Iterable<string>) => Math.max(0, ...[...ds].map((d) => pos(d) + 1))
    let lo = after(x.deps)
    let hi = out.length
    for (const q of list)
      if (q.deps.has(x.op.id) && pos(q.op.id) >= 0) hi = Math.min(hi, pos(q.op.id))
    const softLo = Math.max(lo, after(freeing.get(x.op.id) ?? []))
    let softHi = hi
    for (const [profile, freed] of freeing) {
      const k = pos(profile)
      if (freed.has(x.op.id) && k >= softLo) softHi = Math.min(softHi, k)
    }
    if (softLo <= softHi) {
      lo = softLo
      hi = softHi
    }
    if (lo > hi) hi = lo
    pending.delete(x.op.id)
    const tool = runKey(x.op)
    // the neighbours it would cut between, not counting new operations still to be placed
    const neighbour = (k: number, step: 1 | -1): string | undefined => {
      for (let j = k; j >= 0 && j < out.length; j += step)
        if (!pending.has(out[j]!.id)) return runKey(out[j]!)
      return undefined
    }
    const cost = (k: number) => {
      const ta = neighbour(k - 1, -1)
      const tb = neighbour(k, 1)
      return (
        Number(ta !== undefined && ta !== tool) +
        Number(tb !== undefined && tb !== tool) -
        Number(ta !== undefined && tb !== undefined && ta !== tb)
      )
    }
    let best = Math.min(Math.max(orig, lo), hi)
    for (let k = lo; k <= hi; k++) {
      const c = cost(k)
      const b = cost(best)
      if (c < b || (c === b && Math.abs(k - orig) < Math.abs(best - orig))) best = k
    }
    out.splice(best, 0, x.op)
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

/** Where an operation lies: a hole's centre, a shape's bounding-box centre, a chamfer's edge's. */
function centerOf(op: Operation, part: Part, port: Region2dPort | undefined): Vec2 | undefined {
  if (op.kind === 'drilling') return [op.center[0].canonical, op.center[1].canonical]
  if (op.kind === 'chamfer') {
    const edge = part.operations.find((o) => o.id === op.edgeOf)
    return edge === undefined || edge.kind === 'chamfer' ? undefined : centerOf(edge, part, port)
  }
  if (op.kind !== 'pocket' && op.kind !== 'profile') return undefined
  const b = shapeBox(op.shape, part, port)
  return b === undefined ? undefined : [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
}

type Profile = Extract<Operation, { kind: 'profile' }>

/** A profile that cuts through the stock: any side without a depth (a step, DF53, is blind). */
export function isThroughProfile(op: Operation): op is Profile {
  return op.kind === 'profile' && op.depth.isNone()
}

const boxArea = (b: Box) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1])

/**
 * Whether a through profile frees `op` (plan-v0.4.md § Machining order v2): a facing always;
 * another profile when its centre lies inside and its bounding box is smaller; any other operation
 * when its centre lies inside (the loose-piece test). A release profile (`release`, DF57) frees
 * every operation of its face direction except the other release profiles. The face direction is
 * the caller's.
 */
function frees(
  profile: Profile,
  op: Operation,
  part: Part,
  port: Region2dPort | undefined,
  release: ReadonlySet<string> = new Set(),
): boolean {
  if (op.id === profile.id) return false
  // a chamfer on the profile's own edge bevels the rim round it, not material inside it (X2)
  if (op.kind === 'chamfer' && op.edgeOf === profile.id) return false
  if (op.kind === 'facing') return true
  // DF57: the cut that releases the part comes after everything else of its setup
  if (release.has(profile.id) && !release.has(op.id)) return true
  const c = centerOf(op, part, port)
  if (c === undefined || !inside(profile.shape, part, port, c)) return false
  if (op.kind !== 'profile') return true
  const own = shapeBox(op.shape, part, port)
  const outer = shapeBox(profile.shape, part, port)
  return own !== undefined && outer !== undefined && boxArea(own) < boxArea(outer)
}

/**
 * The release profiles of the plan operations (plan-v0.4.md § Machining order v2, DF57): the
 * through profiles that no other through profile of their face direction frees, i.e. the
 * outermost ones, which separate the part from the stock (an outline; not a cutout inside it).
 */
export function releaseProfiles(
  planOps: readonly PlanOperationDTO[],
  part: Part,
  port?: Region2dPort,
): Set<string> {
  const byId = new Map(part.operations.map((o) => [o.id, o]))
  const direction = operationDirections(planOps, part)
  const through = planOps.flatMap((p) =>
    throughProfiles(p, byId).map((profile) => ({ profile, direction: direction.get(p.id) })),
  )
  const out = new Set<string>()
  for (const t of through)
    if (
      !through.some((o) => o.direction === t.direction && frees(o.profile, t.profile, part, port))
    )
      out.add(t.profile.id)
  return out
}

/** The through profiles of a plan operation. */
function throughProfiles(p: PlanOperationDTO, byId: ReadonlyMap<string, Operation>): Profile[] {
  return p.designOperationIds
    .map((d) => byId.get(d))
    .filter((o): o is Profile => o !== undefined && isThroughProfile(o))
}

/**
 * The freeing dependencies of the default order: for each plan operation holding a through
 * profile, the plan operations of its face direction it frees (`frees`), which come first. One
 * that would close a cycle with the `on`/edge dependencies (or an earlier freeing one) is dropped.
 */
export function freeingDependencies(
  planOps: readonly PlanOperationDTO[],
  part: Part,
  port?: Region2dPort,
): Map<string, Set<string>> {
  const byId = new Map(part.operations.map((o) => [o.id, o]))
  const direction = operationDirections(planOps, part)
  const release = releaseProfiles(planOps, part, port)
  const graph = new Map(infos(planOps, part).map((x) => [x.op.id, new Set(x.deps)]))
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>()
    const stack = [from]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (id === to) return true
      if (seen.has(id)) continue
      seen.add(id)
      stack.push(...(graph.get(id) ?? []))
    }
    return false
  }
  const out = new Map<string, Set<string>>()
  for (const p of planOps) {
    const profiles = throughProfiles(p, byId)
    if (profiles.length === 0) continue
    const freed = new Set<string>()
    for (const q of planOps) {
      if (q.id === p.id || direction.get(q.id) !== direction.get(p.id)) continue
      const inside = q.designOperationIds.some((d) => {
        const o = byId.get(d)
        return o !== undefined && profiles.some((f) => frees(f, o, part, port, release))
      })
      if (!inside || reaches(q.id, p.id)) continue
      freed.add(q.id)
      graph.get(p.id)?.add(q.id)
    }
    if (freed.size > 0) out.set(p.id, freed)
  }
  return out
}

/**
 * Order findings over the machining order of every setup: `plan.order` (error) when an operation
 * precedes one whose surface it starts from; `plan.loosePiece` (warning) when a through profile
 * comes before an operation of the same face direction it frees (`frees`: inside its shape, a
 * smaller profile too; positions are face-frame; general shapes by their placed bounding box,
 * with the 2D port only).
 */
export function orderFindings(
  planOps: readonly PlanOperationDTO[],
  part: Part,
  port?: Region2dPort,
): PlanWarning[] {
  const out: PlanWarning[] = []
  const direction = operationDirections(planOps, part)
  const release = releaseProfiles(planOps, part, port)
  const position = new Map(planOps.map((p, i) => [p.id, i]))
  const byId = new Map(part.operations.map((o) => [o.id, o]))
  const list = infos(planOps, part)
  list.forEach((x, i) => {
    for (const d of x.deps)
      if (!x.rest.has(d) && (position.get(d) ?? -1) > i)
        out.push(
          x.edgeDeps.has(d)
            ? {
                code: 'plan.order',
                severity: 'error',
                message: `${x.op.id} chamfers the edge of ${d}, which comes later`,
                planOperationId: x.op.id,
                rule: 'edgeBefore',
                params: { dependsOn: d },
              }
            : {
                code: 'plan.order',
                severity: 'error',
                message: `${x.op.id} starts from a surface of ${d}, which comes later`,
                planOperationId: x.op.id,
                rule: 'onBefore',
                params: { dependsOn: d },
              },
        )
  })
  planOps.forEach((p, i) => {
    for (const profile of throughProfiles(p, byId))
      for (const later of planOps.slice(i + 1)) {
        if (direction.get(later.id) !== direction.get(p.id)) continue
        for (const d of later.designOperationIds) {
          const o = byId.get(d)
          if (o !== undefined && frees(profile, o, part, port, release)) {
            // inside it, or (DF57) anywhere after the cut that releases the part
            const within = frees(profile, o, part, port)
            out.push({
              code: 'plan.loosePiece',
              severity: 'warning',
              message: within
                ? `${profile.id} is cut before ${o.id} inside it: the piece may be loose`
                : `${profile.id} releases the part before ${o.id}: the part is held only by its tabs`,
              planOperationId: later.id,
              rule: within ? 'profileFirst' : 'releaseFirst',
              params: { profile: profile.id, operation: o.id },
            })
            break
          }
        }
      }
  })
  return out
}
