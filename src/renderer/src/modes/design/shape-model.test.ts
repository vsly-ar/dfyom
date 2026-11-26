// The Shape Editor's pure model (task U1): field and drag updates as `design.shape.item.update`
// fields, drag values in the written unit, issue placement, new items.
// Doc: docs/conventions/ui.md#shape-editor
import { describe, expect, it } from 'vitest'
import type { ShapeItemDTO } from '../../../../core/design/shape.dto'
import { qty } from '../../../../core/library/library.fixture'
import {
  anyFormula,
  definitionNumbers,
  dragSource,
  dragUpdate,
  endVertex,
  fieldUpdate,
  issueField,
  issueItem,
  itemNumbers,
  newItemArgs,
  niceStep,
} from './shape-model'

const len = (s: string) => qty('length', s)
const rect: ShapeItemDTO = {
  kind: 'rectangle',
  op: 'add',
  center: [len('0'), len('0')],
  length: len('40'),
  width: len('20 mm'),
  cornerRadius: len('3'),
}
const path: ShapeItemDTO = {
  kind: 'path',
  op: 'add',
  start: [len('0'), len('0')],
  closed: true,
  segments: [
    { kind: 'line', to: [len('40'), len('0')] },
    { kind: 'arc', to: [len('40'), len('20')], radius: len('10'), cw: false },
    { kind: 'line', to: [len('0'), len('20')] },
  ],
  fillets: [{ vertex: 1, radius: len('2') }],
}

describe('shape model', () => {
  it('reads numbers (mm) from the stored item', () => {
    expect(itemNumbers(rect)).toMatchObject({ kind: 'rectangle', length: 40, width: 20 })
  })

  it('sends a point as its pair and a segment as the whole list', () => {
    expect(fieldUpdate(rect, ['length'], '60')).toEqual({ length: '60' })
    expect(fieldUpdate(rect, ['center', 1], '5')).toEqual({ center: ['0', '5'] })
    const u = fieldUpdate(path, ['segments', 1, 'radius'], '12')
    expect(u['segments']).toEqual([
      { kind: 'line', to: ['40', '0'] },
      { kind: 'arc', to: ['40', '20'], radius: '12', cw: false },
      { kind: 'line', to: ['0', '20'] },
    ])
  })

  it('writes a dragged value in the unit it was typed in, rounded to the step', () => {
    expect(dragSource(len('40'), 52.3456, 0.1)).toBe('52.3')
    expect(dragSource(len('20 mm'), 25.04, 0.5)).toBe('25 mm')
    expect(dragSource(len('1 in'), 50.8, 0.1)).toBe('2 in')
    expect(niceStep(0.13)).toBe(0.2)
    expect(niceStep(3)).toBe(5)
  })

  it('sends only the quantities a drag changed', () => {
    const before = itemNumbers(rect)!
    const after = { ...before, length: 51.27 } as typeof before
    expect(dragUpdate(rect, before, after, 0.1)).toEqual({ length: '51.3' })
    const p = itemNumbers(path)!
    if (p.kind !== 'path') throw new Error('path expected')
    const moved = {
      ...p,
      segments: p.segments.map((s, k) => (k === 0 ? { ...s, to: [45, 0] as [number, number] } : s)),
    }
    expect(Object.keys(dragUpdate(path, p, moved, 0.1))).toEqual(['segments'])
  })

  it('places an issue at its field of the item', () => {
    const issue = { path: ['items', 2, 'segments', 1, 'radius'] }
    expect(issueItem(issue)).toBe(2)
    expect(issueField(issue, 2)).toBe('segments.1.radius')
    expect(issueField(issue, 0)).toBeUndefined()
  })

  it('knows a formula and the vertex a segment ends at', () => {
    const f: ShapeItemDTO = { ...rect, length: { ...len('40'), source: '30 + 10' } } as ShapeItemDTO
    expect(anyFormula(f, [['length']])).toBe(true)
    expect(anyFormula(rect, [['length']])).toBe(false)
    const p = itemNumbers(path)!
    if (p.kind !== 'path') throw new Error('path expected')
    expect(endVertex(p, 0)).toBe(1)
    expect(endVertex(p, 2)).toBe(3) // closed: the closing line starts there
  })

  it('starts new items with sensible defaults in the project units', () => {
    expect(newItemArgs('rectangle', 'mm')).toMatchObject({ kind: 'rectangle', length: '40' })
    expect(newItemArgs('circle', 'mm')).toMatchObject({ kind: 'circle', diameter: '20' })
    expect(newItemArgs('path', 'mm')).toMatchObject({ kind: 'path', closed: true })
  })
})

describe('offset items (design-llm-first.md § Offset item)', () => {
  const offset: ShapeItemDTO = {
    kind: 'offset',
    op: 'add',
    shapeId: 'shape1',
    distance: len('2'),
    direction: 'inward',
  }
  const shapes = [
    { id: 'shape1', name: 'Outline', items: [rect] },
    { id: 'shape2', name: 'Inset', items: [offset] },
  ]
  it('definitionNumbers inlines the source from the part, a self-reference is a cycle', () => {
    const def = definitionNumbers([offset], shapes, 'shape2')!
    expect(def[0]).toMatchObject({ kind: 'offset', distance: 2, source: [{ kind: 'rectangle' }] })
    expect(definitionNumbers([offset], shapes, 'shape1')![0]).toMatchObject({
      source: 'shapeCycle',
    })
    expect(definitionNumbers([offset])![0]).not.toHaveProperty('source')
  })
})
