/**
 * Dependency graph of expression-sourced values: cycle detection, evaluation order, and what to
 * re-evaluate when inputs change. Doc: docs/architecture/quantities.md#dependency-graph
 *
 * Nodes are value ids (e.g. `wall_thickness`, `pocket1.floor.z`) mapped to the references their
 * expressions use (`referencesOf`). A reference belongs to the node with the longest id that is
 * the reference or a dotted prefix of it (`pocket1.floor.z.max` → `pocket1.floor.z`). A reference
 * owned by no node is an external input (tool, machine, …), only a starting point for
 * `affectedBy`. Iterative throughout: no recursion limit on long chains.
 */
import { fail, Ok, type AppResult } from '../../shared/result'

export class DependencyGraph {
  private constructor(
    /** Node → owning nodes of its references (external references kept as written). */
    private readonly deps: ReadonlyMap<string, readonly string[]>,
    private readonly ordered: readonly string[],
  ) {
    Object.freeze(this)
  }

  /** Fails with `expression.cycle` (rule `cycle`, params `{ cycle: [a, b, …, a] }`). */
  static create(raw: ReadonlyMap<string, readonly string[]>): AppResult<DependencyGraph> {
    const deps = new Map<string, readonly string[]>()
    for (const [id, refs] of raw) deps.set(id, [...new Set(refs.map((r) => ownerOf(r, raw)))])

    const order: string[] = []
    const state = new Map<string, 'visiting' | 'done'>()
    for (const root of deps.keys()) {
      if (state.has(root)) continue
      // Explicit DFS stack: node and index of the next dependency to visit.
      const stack: [string, number][] = [[root, 0]]
      state.set(root, 'visiting')
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!
        const [id, i] = frame
        const next = (deps.get(id) ?? [])[i]
        if (next === undefined) {
          stack.pop()
          state.set(id, 'done')
          order.push(id)
          continue
        }
        frame[1] = i + 1
        if (!deps.has(next) || state.get(next) === 'done') continue // external or finished
        if (state.get(next) === 'visiting') {
          const path = stack.map(([n]) => n)
          return cycleError([...path.slice(path.indexOf(next)), next])
        }
        state.set(next, 'visiting')
        stack.push([next, 0])
      }
    }
    return Ok(new DependencyGraph(deps, order))
  }

  /** Every node, each after the nodes it references (declaration order breaks ties). */
  order(): readonly string[] {
    return this.ordered
  }

  /**
   * Nodes to re-evaluate after `changed` (nodes or external inputs; a changed input also
   * covers its dotted sub-values, `tool` → `tool.diameter`) got new values: their transitive
   * dependents, in evaluation order. Everything else keeps its stored exact value.
   */
  affectedBy(changed: Iterable<string>): readonly string[] {
    const dirty = [...changed].map((c) => ownerOf(c, this.deps))
    const isDirty = (ref: string): boolean =>
      dirty.some((d) => ref === d || (!this.deps.has(ref) && ref.startsWith(`${d}.`)))
    const affected = new Set<string>()
    for (const id of this.ordered)
      if ((this.deps.get(id) ?? []).some((d) => isDirty(d) || affected.has(d))) affected.add(id)
    return this.ordered.filter((id) => affected.has(id))
  }
}

/** The node owning `ref`: longest node id equal to it or a dotted prefix; else `ref` itself. */
function ownerOf(ref: string, nodes: ReadonlyMap<string, unknown>): string {
  for (let id = ref; ;) {
    if (nodes.has(id)) return id
    const dot = id.lastIndexOf('.')
    if (dot < 0) return ref
    id = id.slice(0, dot)
  }
}

function cycleError(cycle: readonly string[]): AppResult<never> {
  const message = `formulas refer to each other: ${cycle.join(' → ')}`
  return fail('expression.cycle', message, {
    issues: [{ path: [], rule: 'cycle', message, params: { cycle } }],
    where: 'DependencyGraph.create',
  })
}
