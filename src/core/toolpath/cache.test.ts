// Spec: docs/architecture/workers.md#toolpath-cache
import { describe, expect, it } from 'vitest'
import { createToolpathCache, MOVE_BYTES, toolpathBytes } from './cache'
import type { Toolpath } from './model'

const tp = (id: string, moves: number): Toolpath => ({
  planOperationId: id,
  tool: 'snapshot-1',
  spindleSpeed: 10000,
  passes: [
    {
      kind: 'rough',
      moves: Array.from({ length: moves }, (_, i) => ({ kind: 'rapid', to: [i, 0, 10] })),
    },
  ],
  stats: { cutLength: 0, rapidLength: moves, estimatedSeconds: 0 },
})

describe('ToolpathCache', () => {
  it('keys toolpaths by input hash and remembers the last one per plan operation', () => {
    const c = createToolpathCache()
    expect(c.get('h1')).toBeUndefined()
    expect(c.last('plan-1', 'op-1')).toBeUndefined()
    const a = tp('op-1', 3)
    c.set('plan-1', 'op-1', 'h1', a)
    expect(c.get('h1')).toBe(a)
    expect(c.last('plan-1', 'op-1')).toEqual({ inputHash: 'h1', toolpath: a })
    // a duplicated plan with the same inputs hits the same entry
    c.remember('plan-2', 'op-1', 'h1')
    expect(c.last('plan-2', 'op-1')?.toolpath).toBe(a)
    // a newer toolpath of the operation replaces its "last" one; the old one stays cached
    const b = tp('op-1', 4)
    c.set('plan-1', 'op-1', 'h2', b)
    expect(c.last('plan-1', 'op-1')).toEqual({ inputHash: 'h2', toolpath: b })
    expect(c.get('h1')).toBe(a)
    expect(c.bytes).toBe(7 * MOVE_BYTES)
  })

  it('estimates size as moves × 64 B and replaces an entry under the same hash', () => {
    expect(toolpathBytes(tp('op', 10))).toBe(640)
    expect(toolpathBytes(tp('op', 0))).toBe(MOVE_BYTES)
    const c = createToolpathCache()
    c.set('p', 'op', 'h', tp('op', 10))
    c.set('p', 'op', 'h', tp('op', 2))
    expect(c.bytes).toBe(2 * MOVE_BYTES)
  })

  it('evicts least recently used entries beyond the size cap', () => {
    const c = createToolpathCache(10 * MOVE_BYTES)
    c.set('p', 'a', 'ha', tp('a', 4))
    c.set('p', 'b', 'hb', tp('b', 4))
    c.get('ha') // a is now more recent than b
    c.set('p', 'c', 'hc', tp('c', 4))
    expect(c.get('hb')).toBeUndefined()
    expect(c.get('ha')).toBeDefined()
    expect(c.get('hc')).toBeDefined()
    expect(c.bytes).toBe(8 * MOVE_BYTES)
    // an evicted toolpath is no longer the operation's "last" one
    expect(c.last('p', 'b')).toBeUndefined()
    // a single entry above the cap is kept (eviction only costs a regeneration)
    c.set('p', 'd', 'hd', tp('d', 20))
    expect(c.get('hd')).toBeDefined()
    expect(c.get('ha')).toBeUndefined()
  })

  it('clear drops everything', () => {
    const c = createToolpathCache()
    c.set('p', 'a', 'ha', tp('a', 1))
    c.clear()
    expect(c.get('ha')).toBeUndefined()
    expect(c.last('p', 'a')).toBeUndefined()
    expect(c.bytes).toBe(0)
  })
})
