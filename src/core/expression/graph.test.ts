// Spec: docs/architecture/quantities.md#dependency-graph (task 2.2)
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { DependencyGraph } from './graph'

const graph = (deps: Record<string, string[]>): DependencyGraph =>
  expectOk(DependencyGraph.create(new Map(Object.entries(deps))))

describe('DependencyGraph', () => {
  it('orders every value after the values it references', () => {
    expect(graph({ a: ['b'], b: ['c'], c: [] }).order()).toEqual(['c', 'b', 'a'])
  })

  it('orders deterministically (declaration order breaks ties)', () => {
    const g = graph({ top: ['left', 'right'], left: ['base'], right: ['base'], base: [] })
    expect(g.order()).toEqual(['base', 'left', 'right', 'top'])
  })

  it('treats references that are not values in the graph as external inputs', () => {
    expect(graph({ a: ['tool.diameter'], b: ['a', 'machine.travel.z'] }).order()).toEqual([
      'a',
      'b',
    ])
  })

  it('rejects a cycle and names it', () => {
    const e = expectErrCode(
      DependencyGraph.create(
        new Map([
          ['x', ['a']],
          ['a', ['b']],
          ['b', ['c']],
          ['c', ['a']],
        ]),
      ),
      'expression.cycle',
    )
    expect(e.issues[0]!.rule).toBe('cycle')
    expect(e.issues[0]!.params).toMatchObject({ cycle: ['a', 'b', 'c', 'a'] })
  })

  it('rejects a value that references itself', () => {
    const e = expectErrCode(DependencyGraph.create(new Map([['a', ['a']]])), 'expression.cycle')
    expect(e.issues[0]!.params).toMatchObject({ cycle: ['a', 'a'] })
  })

  it('lists what to re-evaluate when inputs change: transitive dependents, in order', () => {
    const g = graph({ a: ['b'], b: ['c'], c: [], d: ['tool.diameter'], e: [] })
    expect(g.affectedBy(['c'])).toEqual(['b', 'a'])
    expect(g.affectedBy(['tool.diameter'])).toEqual(['d'])
    expect(g.affectedBy(['c', 'b'])).toEqual(['b', 'a'])
    expect(g.affectedBy(['e'])).toEqual([])
  })
})
