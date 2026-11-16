/**
 * Dependency graph of expression-sourced values: cycle detection, evaluation order, and what to
 * re-evaluate when inputs change. Doc: docs/architecture/quantities.md#dependency-graph
 *
 * Nodes are value ids (e.g. `wall_thickness`, `pocket1.depth`) mapped to the references their
 * expressions use (`referencesOf`). A reference that is not a node is an external input (tool,
 * machine, a literal value) and only matters as a starting point for `affectedBy`.
 */
import { fail, Ok, type AppResult } from '../../shared/result'

export class DependencyGraph {
  private constructor(
    private readonly deps: ReadonlyMap<string, readonly string[]>,
    private readonly ordered: readonly string[],
  ) {
    Object.freeze(this)
  }

  /** Fails with `expression.cycle` (rule `cycle`, params `{ cycle: [a, b, …, a] }`). */
  static create(deps: ReadonlyMap<string, readonly string[]>): AppResult<DependencyGraph> {
    const order: string[] = []
    const state = new Map<string, 'visiting' | 'done'>()
    const path: string[] = []

    const visit = (id: string): AppResult<void> => {
      const s = state.get(id)
      if (s === 'done') return Ok(undefined)
      if (s === 'visiting') {
        const cycle = [...path.slice(path.indexOf(id)), id]
        const message = `formulas refer to each other: ${cycle.join(' → ')}`
        return fail('expression.cycle', message, {
          issues: [{ path: [], rule: 'cycle', message, params: { cycle } }],
          where: 'DependencyGraph.create',
        })
      }
      state.set(id, 'visiting')
      path.push(id)
      for (const dep of deps.get(id) ?? []) {
        if (!deps.has(dep)) continue // external input
        const r = visit(dep)
        if (r.isErr()) return r
      }
      path.pop()
      state.set(id, 'done')
      order.push(id)
      return Ok(undefined)
    }

    for (const id of deps.keys()) {
      const r = visit(id)
      if (r.isErr()) return r
    }
    return Ok(new DependencyGraph(deps, order))
  }

  /** Every node, each after the nodes it references (declaration order breaks ties). */
  order(): readonly string[] {
    return this.ordered
  }

  /**
   * Nodes to re-evaluate after `changed` (nodes or external inputs) got new values: their
   * transitive dependents, in evaluation order. Everything else keeps its stored exact value.
   */
  affectedBy(changed: Iterable<string>): readonly string[] {
    const dirty = new Set(changed)
    const affected = new Set<string>()
    for (const id of this.ordered) {
      if ((this.deps.get(id) ?? []).some((d) => dirty.has(d) || affected.has(d))) affected.add(id)
    }
    return this.ordered.filter((id) => affected.has(id))
  }
}
