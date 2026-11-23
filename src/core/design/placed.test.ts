// `placed` in operation add/update results (hardening A3): outline bounds in the face frame, the
// removed box in the part frame. Doc: docs/architecture/llm-api.md#a3-frames-in-the-primer-placed-bounds
import { describe, expect, it } from 'vitest'
import { designSetup } from './design.fixture'

const rect = (length: string, width: string) => ({
  kind: 'rectangle',
  center: ['50', '30'],
  length,
  width,
  cornerRadius: '1',
})

describe('placed', () => {
  it('a pocket on a floor: its outline and the box down to its depth', async () => {
    const s = await designSetup()
    const partId = s.partId
    const facing = await s.run('design.facing.add', { partId, depth: '0.5' })
    expect(facing).toMatchObject({
      placed: { face: 'stock.top', min: [0, 0], max: [100, 60] },
    })
    const r = await s.run('design.pocket.add', { partId, shape: rect('40', '25'), depth: '8' })
    expect(r).toMatchObject({
      placed: {
        face: 'facing1.floor',
        min: [30, 17.5],
        max: [70, 42.5],
        box: { min: [30, 17.5, -8.5], max: [70, 42.5, -0.5] },
      },
    })
    const u = await s.run('design.pocket.update', { partId, operationId: 'pocket1', depth: '3' })
    expect(u).toMatchObject({ placed: { box: { min: [30, 17.5, -3.5] } } })
  })

  it('a drilling on the bottom: the face frame turns into the part frame', async () => {
    const s = await designSetup()
    const r = await s.run('design.drilling.add', {
      partId: s.partId,
      on: 'stock.bottom',
      center: ['10', '20'],
      diameter: '6',
      bottom: 'flat',
      depth: '5',
    })
    // bottom face frame: origin (0, W, −T), u = +X, v = −Y
    expect(r).toMatchObject({
      placed: {
        face: 'stock.bottom',
        min: [7, 17],
        max: [13, 23],
        box: { min: [7, 37, -20], max: [13, 43, -15] },
      },
    })
  })

  it('an outside profile: the box grows by the slot and goes through', async () => {
    const s = await designSetup()
    const r = await s.run('design.profile.add', {
      partId: s.partId,
      shape: rect('84', '44'),
      slotWidth: '6',
    })
    expect(r).toMatchObject({
      placed: { min: [8, 8], max: [92, 52], box: { min: [2, 2, -20], max: [98, 58, 0] } },
    })
  })
})
