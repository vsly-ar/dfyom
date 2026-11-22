// The operation inspector's shape model (task U2): picker values and choices, open named paths,
// corner points of a warning and the "Round corners to ≥ r" fixes.
// Doc: docs/conventions/ui.md#shape-in-the-operation-inspector
import { describe, expect, it } from 'vitest'
import type { OperationShapeDTO } from '../../../../core/design/part.dto'
import type { ShapeDTO, ShapeItemDTO } from '../../../../core/design/shape.dto'
import type { DfmWarning } from '../../../../core/geometry/model'
import { qty } from '../../../../core/library/library.fixture'
import {
  cornerPoints,
  isCornerWarning,
  isOpenNamed,
  pickerValue,
  roundCornerFixes,
  shapeChoiceArgs,
} from './operation-shape'

const len = (s: string) => qty('length', s)
const rect = {
  kind: 'rectangle',
  center: [len('30'), len('20')],
  length: len('40'),
  width: len('20'),
  rotation: qty('angle', '15'),
} as unknown as OperationShapeDTO
const named = {
  kind: 'named',
  shapeId: 'shape-1',
  center: [len('10'), len('10')],
  mirror: true,
} as unknown as OperationShapeDTO

const path = (closed: boolean): ShapeItemDTO => ({
  kind: 'path',
  op: 'add',
  start: [len('0'), len('0')],
  closed,
  segments: [
    { kind: 'line', to: [len('40'), len('0')] },
    { kind: 'line', to: [len('40'), len('20')] },
    { kind: 'line', to: [len('0'), len('20')] },
  ],
})
const shapeOf = (...items: ShapeItemDTO[]): ShapeDTO =>
  ({ id: 'shape-1', name: 'Shape 1', items }) as unknown as ShapeDTO

const warning = (params: Record<string, unknown>): DfmWarning =>
  ({
    code: 'dfm.cornerSharp',
    severity: 'warning',
    message: 'sharp',
    operationId: 'op-1',
    parameter: 'shape',
    params,
    suggestion: { relation: 'atLeast', value: 3 },
  }) as unknown as DfmWarning

describe('operation shape', () => {
  it('gives the picker value of inline kinds and named shapes', () => {
    expect(pickerValue(rect)).toBe('rectangle')
    expect(pickerValue(named)).toBe('named:shape-1')
  })

  it('keeps center, rotation and mirror across a choice', () => {
    expect(shapeChoiceArgs(rect, 'named:shape-2', undefined, 'mm')).toEqual({
      kind: 'named',
      shapeId: 'shape-2',
      center: ['30', '20'],
      rotation: '15',
    })
    expect(shapeChoiceArgs(named, 'named:shape-2', undefined, 'mm')).toMatchObject({
      mirror: true,
    })
    expect(shapeChoiceArgs(rect, 'circle', undefined, 'mm')).toEqual({
      kind: 'circle',
      center: ['30', '20'],
      diameter: '20',
    })
  })

  it('sizes an inline shape from the named shape it replaces', () => {
    const args = shapeChoiceArgs(named, 'rectangle', { min: [0, 0], max: [40, 25] }, 'mm')
    expect(args).toMatchObject({ kind: 'rectangle', center: ['10', '10'] })
    expect(String(args['length'])).toContain('40')
    expect(String(args['width'])).toContain('25')
  })

  it('knows a named shape made of one open path', () => {
    expect(isOpenNamed(shapeOf(path(false)))).toBe(true)
    expect(isOpenNamed(shapeOf(path(true)))).toBe(false)
    expect(isOpenNamed(undefined)).toBe(false)
  })

  it('reads corner markers from points, else at', () => {
    expect(cornerPoints(warning({ at: [1, 2] }))).toEqual([[1, 2]])
    expect(cornerPoints(warning({ at: [1, 2], points: [1, 2, 3, 4] }))).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(isCornerWarning(warning({}))).toBe(true)
  })

  it('rounds a closed path at the matching vertices with fillets', () => {
    const fixes = roundCornerFixes(
      shapeOf(path(true)),
      [
        [40, 0],
        [0, 0],
      ],
      3,
      'mm',
    )
    expect(fixes.limited).toBe(false)
    expect(fixes.range).toEqual([3, 3])
    expect(fixes.fixes).toEqual([
      {
        index: 0,
        fields: {
          fillets: [
            { vertex: 0, radius: '3 mm' },
            { vertex: 1, radius: '3 mm' },
          ],
        },
      },
    ])
  })

  it('leaves the ends of an open path and points off every item alone', () => {
    expect(roundCornerFixes(shapeOf(path(false)), [[0, 0]], 3, 'mm').fixes).toEqual([])
    expect(roundCornerFixes(shapeOf(path(true)), [[17, 9]], 3, 'mm').fixes).toEqual([])
  })

  it('rounds a rectangle item with its corner radius', () => {
    const r: ShapeItemDTO = {
      kind: 'rectangle',
      op: 'add',
      center: [len('0'), len('0')],
      length: len('40'),
      width: len('20'),
      cornerRadius: len('0'),
    }
    expect(roundCornerFixes(shapeOf(r), [[20, 10]], 2.5, 'inch').fixes).toEqual([
      { index: 0, fields: { cornerRadius: expect.stringContaining('"') } },
    ])
    // a 6 mm wide rectangle takes 3 mm at most: the fix writes that and says it is limited
    const narrow = { ...r, width: len('6') } as ShapeItemDTO
    expect(roundCornerFixes(shapeOf(narrow), [[20, 3]], 5, 'mm')).toEqual({
      fixes: [{ index: 0, fields: { cornerRadius: '3 mm' } }],
      limited: true,
      range: [3, 3],
    })
  })

  it('rounds a corner the tool radius does not fit to the largest radius it takes', () => {
    // a 2 mm step: vertex 1 of 0,0 → 40,0 → 40,2 → 0,2 takes 2 mm, vertex 2 then 0 mm more
    const step: ShapeItemDTO = {
      kind: 'path',
      op: 'add',
      start: [len('0'), len('0')],
      closed: true,
      segments: [
        { kind: 'line', to: [len('40'), len('0')] },
        { kind: 'line', to: [len('40'), len('2')] },
        { kind: 'line', to: [len('0'), len('2')] },
      ],
    }
    const one = roundCornerFixes(shapeOf(step), [[40, 0]], 3, 'mm')
    expect(one).toEqual({
      fixes: [{ index: 0, fields: { fillets: [{ vertex: 1, radius: '2 mm' }] } }],
      limited: true,
      range: [2, 2],
    })
    // both corners of the 2 mm side: the second gets what the first leaves (half each would fit
    // better, but the fix goes corner by corner and never refuses)
    const both = roundCornerFixes(
      shapeOf(step),
      [
        [40, 0],
        [40, 2],
      ],
      0.75,
      'mm',
    )
    expect(both.limited).toBe(false)
    expect(both.fixes).toEqual([
      {
        index: 0,
        fields: {
          fillets: [
            { vertex: 1, radius: '0.75 mm' },
            { vertex: 2, radius: '0.75 mm' },
          ],
        },
      },
    ])
    // a corner that already has its largest radius gets no fix, still limited
    const filleted = {
      ...step,
      fillets: [{ vertex: 1, radius: len('2') }],
    } as ShapeItemDTO
    expect(roundCornerFixes(shapeOf(filleted), [[40, 0]], 3, 'mm')).toMatchObject({
      fixes: [],
      limited: true,
    })
  })
})
