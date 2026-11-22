// maxCornerRadius: the largest corner radius an item takes (the "Round corners" fix rounds a
// corner as far as it fits, X2 finding). Doc: docs/modes/design-v0.3.md#dfm-checks-for-shapes
import { describe, expect, it } from 'vitest'
import { itemChain, maxCornerRadius } from './shape-items'
import type { ShapeItem } from './shape.dto'

type Item = ShapeItem<number>
type PathItem = Extract<Item, { kind: 'path' }>
const L = (x: number, y: number) => ({ kind: 'line' as const, to: [x, y] as [number, number] })
const path = (
  start: [number, number],
  segments: PathItem['segments'],
  extra: Partial<PathItem> = {},
): PathItem => ({ kind: 'path', op: 'add', start, segments, closed: true, ...extra })

const resolves = (item: Item) => {
  const issues: unknown[] = []
  return itemChain(item, 0, issues as never) !== undefined && issues.length === 0
}

describe('maxCornerRadius', () => {
  it('a rectangle takes half its narrowest size', () => {
    const rect: Item = {
      kind: 'rectangle',
      op: 'add',
      center: [0, 0],
      length: 30,
      width: 8,
      cornerRadius: 0,
    }
    expect(maxCornerRadius(rect)).toBe(4)
  })

  it('a square corner between short and long sides fits up to the short side', () => {
    // vertex 1 of a 2 × 20 strip: the 2 mm side limits it (one fillet: up to the whole side)
    const strip = path([0, 0], [L(2, 0), L(2, 20), L(0, 20)])
    const r = maxCornerRadius(strip, 1)!
    expect(r).toBeCloseTo(2, 4)
    expect(r).toBeLessThanOrEqual(2 + 1e-4) // the resolver keeps remainders within ε
    expect(resolves({ ...strip, fillets: [{ vertex: 1, radius: r }] })).toBe(true)
    expect(resolves({ ...strip, fillets: [{ vertex: 1, radius: r + 0.01 }] })).toBe(false)
  })

  it("counts the item's other fillets on the shared side", () => {
    // vertex 0 rounded by 1.5 mm uses 1.5 mm of the shared 2 mm side: 0.5 mm left for vertex 1
    const strip = path([0, 0], [L(2, 0), L(2, 20), L(0, 20)])
    const withOther = { ...strip, fillets: [{ vertex: 0, radius: 1.5 }] }
    const r = maxCornerRadius(withOther, 1)!
    expect(r).toBeCloseTo(0.5, 4)
    expect(
      resolves({
        ...strip,
        fillets: [
          { vertex: 0, radius: 1.5 },
          { vertex: 1, radius: r },
        ],
      }),
    ).toBe(true)
    // the vertex's own fillet is replaced, not counted
    expect(maxCornerRadius({ ...strip, fillets: [{ vertex: 1, radius: 0.1 }] }, 1)).toBeCloseTo(
      2,
      4,
    )
  })

  it('a corner next to an arc fits as far as the resolver allows', () => {
    const d = path([0, 0], [L(20, 0), { kind: 'arc', to: [0, 0], radius: 10, cw: false }])
    const r = maxCornerRadius(d, 1)!
    expect(r).toBeGreaterThan(0.5)
    expect(resolves({ ...d, fillets: [{ vertex: 1, radius: r }] })).toBe(true)
    expect(resolves({ ...d, fillets: [{ vertex: 1, radius: r * 1.01 + 0.001 }] })).toBe(false)
  })

  it("a regular polygon's corners take up to its inscribed radius", () => {
    const hex: Item = { kind: 'polygon', op: 'add', center: [0, 0], sides: 6, diameter: 20 }
    const r = maxCornerRadius(hex)!
    expect(r).toBeCloseTo(10 * Math.cos(Math.PI / 6), 3)
    expect(resolves({ ...hex, cornerRadius: r })).toBe(true)
  })

  it('no radius for ends of open paths, tangent joins or items without corners', () => {
    const open = path([0, 0], [L(10, 0), L(10, 10)], { closed: false })
    expect(maxCornerRadius(open, 0)).toBeUndefined()
    expect(maxCornerRadius(open, 2)).toBeUndefined()
    expect(maxCornerRadius(open, 1)).toBeCloseTo(10, 4)
    const straight = path([0, 0], [L(10, 0), L(20, 0)], { closed: false })
    expect(maxCornerRadius(straight, 1)).toBeUndefined()
    expect(
      maxCornerRadius({ kind: 'circle', op: 'add', center: [0, 0], diameter: 10 }),
    ).toBeUndefined()
    expect(maxCornerRadius(path([0, 0], [L(10, 0), L(10, 10)]))).toBeUndefined()
  })
})
