// The side arrow of a selected one-sided chamfer (DF147 SL4 follow-up): from the wall the geometry
// input builds, each side's arrow points out of its wall into its side, the strips lie beside the
// groove on their side; a closed loop's left (inside) points into the loop; none for a chamfer
// that is no wall. Doc: docs/conventions/ui.md#chamfer-inspector
import { describe, expect, it } from 'vitest'
import { designSetup } from '../../../../core/design/design.fixture'
import { nodeRegion2d } from '../../../../core/geometry/2d/testing/node-wasm'
import { edgeSideGeometry } from './edge-side'
import { designPart } from './model'

const region2d = nodeRegion2d()
const setup = () => designSetup({ services: { region2d } })

describe('edgeSideGeometry', () => {
  it('a Line along +X with a depth: left arrow and strip on +Y beyond the wall, right on −Y', async () => {
    const s = await setup()
    await s.run('design.line.add', {
      partId: s.partId,
      paths: [{ segment: { start: ['10', '20'], end: ['50', '20'] } }],
      depth: '3',
    })
    await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'line1', edgeSide: 'right' })
    const part = designPart(s.d.doc)!
    const g = edgeSideGeometry(part, 'chamfer1', region2d)!
    expect(g.kept).toBe('right')
    expect(g.closed).toBe(false)
    // the arrow at the middle (x 30), from the wall out
    const { left, right } = g.arrows
    expect(left.from[0]).toBeCloseTo(30, 6)
    expect(left.from[1]).toBeGreaterThan(20)
    expect(left.to[1]).toBeGreaterThan(left.from[1])
    expect(right.from[1]).toBeLessThan(20)
    expect(right.to[1]).toBeLessThan(right.from[1])
    // on the face (the stock top, part frame z = thickness), the head behind the tip
    expect(left.to[2]).toBeCloseTo(right.to[2], 9)
    for (const h of left.head) expect(h[1]).toBeLessThan(left.to[1])
    // the strips: every corner on its side, past the wall
    const ys = (side: 'left' | 'right') => g.strips[side].flatMap((q) => q.map((p) => p[1]))
    expect(Math.min(...ys('left'))).toBeCloseTo(left.from[1], 6)
    expect(Math.max(...ys('right'))).toBeCloseTo(right.from[1], 6)
    expect(g.strips.left.length).toBeGreaterThan(10)
  })

  it('a profile on a rectangle: inside (left) points into the loop, outside away', async () => {
    const s = await setup()
    await s.run('design.profile.add', {
      partId: s.partId,
      shape: { kind: 'rectangle', center: ['40', '30'], length: '40', width: '30' },
      side: 'on',
      depth: '2',
      tabs: { count: '0' },
    })
    await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'profile1', edgeSide: 'left' })
    const g = edgeSideGeometry(designPart(s.d.doc)!, 'chamfer1', region2d)!
    expect(g.closed).toBe(true)
    const d = (p: readonly number[]) => Math.hypot(p[0]! - 40, p[1]! - 30)
    expect(d(g.arrows.left.to)).toBeLessThan(d(g.arrows.left.from))
    expect(d(g.arrows.right.to)).toBeGreaterThan(d(g.arrows.right.from))
  })

  it('none for a chamfer round a hole (no wall)', async () => {
    const s = await setup()
    await s.run('design.drilling.add', { partId: s.partId, center: ['30', '30'], diameter: '6' })
    await s.run('design.chamfer.add', { partId: s.partId, edgeOf: 'drill1' })
    expect(edgeSideGeometry(designPart(s.d.doc)!, 'chamfer1', region2d)).toBeUndefined()
  })
})
