// The counterbore of a hole takes the hole's end mill when it fits (X1 follow-up "plan order
// v2"): auto choice (change reason `followsHole`) and a tool set on the drill role; a drill bit on
// the drill role leaves the counterbore its own end mill.
// Spec: docs/modes/design-v0.4.md#counterbore-tool
import { describe, expect, it } from 'vitest'
import type { ToolChange } from '../commands/apply'
import { designSetup, type DesignSetup } from './design.fixture'

const tool = (values: object) => ({
  fluteLength: '20',
  overallLength: '60',
  fluteCount: '2',
  ...values,
})

async function library(s: DesignSetup) {
  const add = async (values: object) =>
    ((await s.run('library.tool.add', { values: tool(values) })) as { id: string }).id
  return {
    flat4: await add({ name: 'Flat 4', type: 'flatEndMill', diameter: '4' }),
    flat6: await add({ name: 'Flat 6', type: 'flatEndMill', diameter: '6' }),
  }
}

const itemOf = (s: DesignSetup, id: string) => {
  const t = s.op(id).tool
  return t?.kind === 'specific' ? s.d.doc.snapshots[t.snapshotId]!.libraryItemId : t
}

describe('counterbore tool', () => {
  it("the counterbore takes the hole's end mill instead of the largest that fits", async () => {
    const s = await designSetup()
    const { flat4 } = await library(s)
    // M5: Ø 5.5 hole (the 4 mm end mill bores it, the 6 mm does not), Ø ≈ 10 counterbore
    await s.run('design.hole.add', {
      partId: s.partId,
      center: ['30', '30'],
      fastener: 'M5',
      type: 'counterbore',
    })
    const applied = (await s.run('project.apply', {})) as { toolChanges?: ToolChange[] }
    expect(itemOf(s, 'hole1_drill')).toBe(flat4)
    expect(itemOf(s, 'hole1_counterbore')).toBe(flat4)
    expect(s.op('hole1_counterbore')).not.toHaveProperty('toolLocked')
    // chosen leader first: the drill role, then the counterbore before it in design order
    expect(applied.toolChanges?.map((c) => [c.operationId, c.reason])).toEqual([
      ['hole1_drill', 'unset'],
      ['hole1_counterbore', 'unset'],
    ])
  })

  it('reason followsHole when an existing counterbore tool is replaced', async () => {
    const s = await designSetup()
    const { flat4, flat6 } = await library(s)
    await s.run('design.hole.add', {
      partId: s.partId,
      center: ['30', '30'],
      fastener: 'M5',
      type: 'counterbore',
    })
    // the counterbore unlocked on Flat 6, the hole changed: the next Apply moves it to Flat 4
    await s.run('project.apply', {})
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'hole1_counterbore',
      tool: { kind: 'specific', toolLibraryItemId: flat6 },
    })
    await s.run('design.operation.tool.unlock', {
      partId: s.partId,
      operationId: 'hole1_counterbore',
    })
    const out = (await s.run('project.apply', {})) as { toolChanges?: ToolChange[] }
    expect(itemOf(s, 'hole1_counterbore')).toBe(flat4)
    expect(out.toolChanges?.find((c) => c.operationId === 'hole1_counterbore')?.reason).toBe(
      'followsHole',
    )
  })

  it('a tool set on the drill role moves the unlocked counterbore along; a drill does not', async () => {
    const s = await designSetup()
    await library(s)
    await s.run('design.hole.add', {
      partId: s.partId,
      center: ['30', '30'],
      fastener: 'M5',
      type: 'counterbore',
    })
    await s.run('project.apply', {})
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'hole1_drill',
      tool: { kind: 'generalized', type: 'flatEndMill', diameter: '3' },
    })
    expect(s.op('hole1_counterbore')).toMatchObject({
      tool: { kind: 'generalized', type: 'flatEndMill', diameter: { source: '3' } },
    })
    expect(s.op('hole1_counterbore')).not.toHaveProperty('toolLocked')
    // a drill bit cannot cut the counterbore: it keeps its end mill
    await s.run('design.operation.tool.set', {
      partId: s.partId,
      operationId: 'hole1_drill',
      tool: { kind: 'generalized', type: 'drill', diameter: '5.5' },
    })
    expect(s.op('hole1_counterbore')).toMatchObject({ tool: { type: 'flatEndMill' } })
  })
})
