// The Design navigator's bulk actions (hardening DF135 multi-select) need no new command: what the
// UI sends is one undo step each – one `design.part.update` with several ids in `alreadyCut` /
// `disabled`, and several removals as one compound gesture (later items first); a refused step
// is cancelled with `history.undo { gesture }`, leaving nothing removed.
// Doc: docs/conventions/ui.md#multi-select-in-the-design-navigator-df135
import { describe, expect, it } from 'vitest'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { uiSource } from '../commands/testing'
import { designSetup } from './design.fixture'

const ui = uiSource()

async function threePockets() {
  const s = await designSetup()
  for (const [x, on] of [
    ['20', 'stock.top'],
    ['60', 'stock.top'],
    ['20', 'pocket1.floor'],
  ] as const)
    await s.run('design.pocket.add', {
      partId: s.partId,
      on,
      shape: { kind: 'rectangle', center: [x, '25'], length: '10', width: '8' },
      depth: '3',
    })
  return s
}

describe('bulk edits of several design items (DF135)', () => {
  it('marks and switches off several items in one undo step each', async () => {
    const s = await threePockets()
    const steps = s.d.history.undoable.length
    await s.run('design.part.update', { partId: s.partId, alreadyCut: ['pocket1', 'pocket2'] })
    await s.run('design.part.update', { partId: s.partId, disabled: ['pocket2', 'pocket3'] })
    expect(s.d.history.undoable).toHaveLength(steps + 2)
    expect(s.part().alreadyCut).toEqual(['pocket1', 'pocket2'])
    await s.undo()
    expect(s.part().disabled).toBeUndefined()
    await s.undo()
    expect(s.part().alreadyCut).toBeUndefined()
  })

  it('removes several items, later ones first, as one compound gesture: one undo restores all', async () => {
    const s = await threePockets()
    const before = s.part()
    const steps = s.d.history.undoable.length
    for (const id of ['pocket3', 'pocket2', 'pocket1'])
      expectOk(
        await s.d.dispatch('design.operation.remove', { partId: s.partId, operationId: id }, ui, {
          gesture: 'bulk-1',
        }),
      )
    expect(s.part().operations).toEqual([])
    expect(s.d.history.undoable).toHaveLength(steps + 1)
    await s.undo()
    expect(s.part()).toEqual(before)
  })

  it('a refused removal is cancelled with its gesture: nothing removed, no undo step', async () => {
    const s = await threePockets()
    const before = s.part()
    const steps = s.d.history.undoable.length
    const opts = { gesture: 'bulk-2' }
    expectOk(
      await s.d.dispatch(
        'design.operation.remove',
        { partId: s.partId, operationId: 'pocket2' },
        ui,
        opts,
      ),
    )
    // Pocket 3 (not selected) sits on Pocket 1's floor
    expectErrCode(
      await s.d.dispatch(
        'design.operation.remove',
        { partId: s.partId, operationId: 'pocket1' },
        ui,
        opts,
      ),
      'design.referenced',
    )
    expectOk(await s.d.dispatch('history.undo', { gesture: 'bulk-2' }, ui))
    expect(s.part()).toEqual(before)
    expect(s.d.history.undoable).toHaveLength(steps)
    expect(s.d.history.redoable).toEqual([])
  })
})
