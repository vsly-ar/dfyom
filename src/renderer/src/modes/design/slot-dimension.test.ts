// The selected slotted Bolt hole's centre line and travel dimension (DF119 H3 follow-up): on the
// hole's face, along the slot's rotation, the dimension beside the widest outline; none for a
// round hole. Doc: docs/modes/hole-slots-and-round-corners.md#viewport-slot-dimension
import { describe, expect, it } from 'vitest'
import { designSetup } from '../../../../core/design/design.fixture'
import { nodeRegion2d } from '../../../../core/geometry/2d/testing/node-wasm'
import { designPart } from './model'
import {
  CENTRE_OVERSHOOT_MM,
  DIMENSION_GAP_MM,
  EXTENSION_OVERSHOOT_MM,
  slotDimension,
} from './slot-dimension'

const region2d = nodeRegion2d()

async function hole(args: object) {
  const s = await designSetup({ services: { region2d } })
  await s.run('design.hole.add', { partId: s.partId, center: ['30', '30'], ...args })
  const part = designPart(s.d.doc)!
  const on = String((part.dto.features![0] as Record<string, unknown>)['on'] ?? 'stock.top')
  return slotDimension('hole1', on, part.loaded!.part.operations, part.loaded!.stock, part.table!)
}

const close = (p: readonly number[], q: readonly number[]) =>
  p.forEach((x, i) => expect(x).toBeCloseTo(q[i]!, 9))

describe('slotDimension', () => {
  it('a simple slot along X: centre line past both ends, the dimension on +Y at the face', async () => {
    const d = (await hole({ fastener: 'M5', slotLength: '10' }))!
    expect(d.travel).toBeCloseTo(10, 9)
    const past = 5.5 / 2 + CENTRE_OVERSHOOT_MM
    close(d.centreLine[0], [25 - past, 30, 0])
    close(d.centreLine[1], [35 + past, 30, 0])
    const off = 5.5 / 2 + DIMENSION_GAP_MM
    close(d.dimension[0], [25, 30 + off, 0])
    close(d.dimension[1], [35, 30 + off, 0])
    close(d.extensions[1]![1], [35, 30 + off + EXTENSION_OVERSHOOT_MM, 0])
  })

  it('a recessed slot: on the stock face, beside the recess; a rotation turns it', async () => {
    const d = (await hole({
      type: 'recessedCountersink',
      fastener: 'M5',
      slotLength: '19.5',
      rotation: '90°',
    }))!
    expect(d.travel).toBeCloseTo(19.5, 9)
    // along +Y now; the dimension on the −X side (+v turned by 90°), past the recess
    close(d.dimension[0], [d.dimension[0][0], 30 - 9.75, 0])
    close(d.dimension[1], [d.dimension[0][0], 30 + 9.75, 0])
    expect(30 - d.dimension[0][0]).toBeGreaterThan(5.5 / 2 + DIMENSION_GAP_MM)
    expect(d.centreLine.every((p) => p[2] === 0)).toBe(true)
  })

  it('none for a round hole', async () => {
    expect(await hole({ fastener: 'M5' })).toBeNull()
  })
})
