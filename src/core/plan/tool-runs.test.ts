// Tool runs and tool changes per setup (hardening DF66).
// Spec: docs/modes/plan-v0.4.md#tool-changes-per-setup-hardening-df66
import { describe, expect, it } from 'vitest'
import { carriedTool, setupToolChanges, toolRuns } from './tool-runs'

const op = (id: string, tool?: string) => ({ id, ...(tool === undefined ? {} : { tool }) })
const ids = (runs: ReturnType<typeof toolRuns<ReturnType<typeof op>>>) =>
  runs.map((r) => [r.tool, r.operations.map((o) => o.id), r.start])

describe('toolRuns', () => {
  it('splits where the tool changes', () => {
    const ops = [op('a', 't1'), op('b', 't1'), op('c', 't2'), op('d', 't1')]
    expect(ids(toolRuns(ops))).toEqual([
      ['t1', ['a', 'b'], 0],
      ['t2', ['c'], 2],
      ['t1', ['d'], 3],
    ])
  })

  it('makes each operation without a tool a run of its own', () => {
    expect(ids(toolRuns([op('a'), op('b'), op('c', 't1')]))).toEqual([
      [undefined, ['a'], 0],
      [undefined, ['b'], 1],
      ['t1', ['c'], 2],
    ])
    expect(toolRuns([])).toEqual([])
  })
})

describe('tool changes per setup', () => {
  const setups = [
    { operations: [op('a', 't1'), op('b', 't2')] },
    { operations: [op('c', 't2'), op('d', 't3')] },
    { operations: [op('e', 't1')] },
  ]

  it('counts the change at the setup start', () => {
    expect(setupToolChanges(setups, 0)).toBe(2)
    expect(setupToolChanges(setups, 2)).toBe(1)
    expect(carriedTool(setups, 0)).toBeUndefined()
  })

  it('does not count it when the tool stays in the spindle from the setup before', () => {
    expect(carriedTool(setups, 1)).toBe('t2')
    expect(setupToolChanges(setups, 1)).toBe(1)
  })

  it('never carries "no tool"', () => {
    const none = [{ operations: [op('a')] }, { operations: [op('b')] }]
    expect(carriedTool(none, 1)).toBeUndefined()
    expect(setupToolChanges(none, 1)).toBe(1)
  })
})
