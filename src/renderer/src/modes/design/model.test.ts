// Design mode's pure view of the document: update args of one field edit, new-operation
// defaults, surface choices and labels, the live outline and the error anchor.
// Doc: docs/modes/design.md#commands-and-queries-v01
import { describe, expect, it } from 'vitest'
import { designSetup } from '../../../../core/design/design.fixture'
import { designMessages } from '../../messages/design'
import {
  addArgs,
  axisNames,
  designPart,
  failingOperation,
  itemName,
  onChoices,
  referenceChoices,
  roundLength,
  shapeKindArgs,
  surfaceLabel,
  updateArgs,
} from './model'
import { anchorPoint, frameAxes, markerPoint, operationOutline, shapeLoop } from './outline'

async function bracket() {
  const s = await designSetup()
  await s.run('design.facing.add', { partId: s.partId })
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: {
      kind: 'rectangle',
      center: ['50', '30'],
      length: '40',
      width: '20',
      cornerRadius: '3',
    },
    depth: '8',
  })
  await s.run('design.drilling.add', { partId: s.partId, center: ['10', '10'], diameter: '6' })
  await s.run('design.profile.add', {
    partId: s.partId,
    shape: { kind: 'rectangle', center: ['50', '30'], length: '80', width: '44' },
  })
  return { s, part: designPart(s.d.doc)! }
}

describe('design model', () => {
  it('builds one update command per field edit (shape and center as a whole, tabs merged)', async () => {
    const { part } = await bracket()
    const [facing, pocket, drill, profile] = part.dto.operations
    expect(updateArgs(facing!, 'depth', '1')).toEqual({ depth: '1' })
    expect(updateArgs(pocket!, 'shape.cornerRadius', '4')).toEqual({
      shape: {
        kind: 'rectangle',
        center: ['50', '30'],
        length: '40',
        width: '20',
        cornerRadius: '4',
      },
    })
    expect(updateArgs(pocket!, 'shape.center.1', '25')).toMatchObject({
      shape: { center: ['50', '25'] },
    })
    expect(updateArgs(drill!, 'center.0', '12')).toEqual({ center: ['12', '10'] })
    expect(updateArgs(profile!, 'tabs.width', '8')).toEqual({ tabs: { width: '8' } })
  })

  it('every update it builds is accepted by the command', async () => {
    const { s, part } = await bracket()
    for (const [op, path, source] of [
      [part.dto.operations[1]!, 'shape.cornerRadius', '4'],
      [part.dto.operations[2]!, 'center.1', '12'],
      [part.dto.operations[3]!, 'tabs.count', '3'],
    ] as const)
      await s.run(`design.${op.kind}.update`, {
        partId: s.partId,
        operationId: op.id,
        ...updateArgs(op, path, source),
      })
  })

  it('new operations fit the stock and are accepted', async () => {
    const s = await designSetup()
    const stock = { length: 100, width: 60, thickness: 20 }
    for (const kind of ['facing', 'pocket', 'drilling', 'profile'] as const)
      await s.run(`design.${kind}.add`, { partId: s.partId, ...addArgs(kind, stock, 'mm') })
    expect(s.part().operations.map((o) => o.id)).toEqual([
      'facing1',
      'pocket1',
      'drill1',
      'profile1',
    ])
    expect(roundLength(25.4 * 0.6, 'inch')).toBe('0.5"')
  })

  it('offers the face targets of every direction, grouped Top, Bottom, Front, Right, Back, Left', async () => {
    const { part } = await bracket()
    const on = onChoices(part.dto, part.table!, 2, 'drilling')
    expect(on.map((c) => [c.group, c.id, c.label])).toEqual([
      ['Top', 'stock.top', 'Stock top'],
      ['Top', 'facing1.floor', 'Facing 1 floor'],
      ['Top', 'pocket1.floor', 'Pocket 1 floor'],
      ['Bottom', 'stock.bottom', 'Stock bottom'],
      ['Front side', 'stock.side[0]', 'Stock front side'],
      ['Right side', 'stock.side[1]', 'Stock right side'],
      ['Back side', 'stock.side[2]', 'Stock back side'],
      ['Left side', 'stock.side[3]', 'Stock left side'],
    ])
    // a facing or profile starts from a stock face only
    expect(onChoices(part.dto, part.table!, 3, 'profile').map((c) => c.id)).toEqual([
      'stock.top',
      'stock.bottom',
      'stock.side[0]',
      'stock.side[1]',
      'stock.side[2]',
      'stock.side[3]',
    ])
    // formulas reference each face's coordinate on its normal axis (design-v0.2.md#formula-names)
    expect(referenceChoices(part.dto, part.table!, 1).map((c) => c.id)).toEqual([
      'stock.top.z',
      'facing1.floor.z',
      'stock.bottom.z',
      'stock.side[0].y',
      'stock.side[1].x',
      'stock.side[2].y',
      'stock.side[3].x',
    ])
    // labels never carry an id (DF43); two operations with one name are told apart by position
    const twins = {
      ...part.dto,
      operations: part.dto.operations.map((o) =>
        o.id === 'pocket1' ? { ...o, name: 'Facing 1' } : o,
      ),
    }
    const labels = onChoices(twins, part.table!, 2, 'drilling').map((c) => c.label)
    expect(labels.slice(0, 3)).toEqual([
      'Stock top',
      'Facing 1 floor (operation 1)',
      'Facing 1 floor (operation 2)',
    ])
    expect(referenceChoices(twins, part.table!, 2).map((c) => c.label)).toContain(
      'Facing 1 floor (operation 2)',
    )
    for (const label of labels) expect(label).not.toMatch(/stock\.|facing1|pocket1/)
    expect(surfaceLabel(part.dto, 'gone1.floor')).toBe('Unknown operation floor')
    expect(itemName(part.dto, 'hole9')).toBe('Unknown operation')
    expect(axisNames('+z')).toEqual({ u: 'X', v: 'Y' })
    expect(axisNames('+x')).toEqual({ u: 'u', v: 'v' })
  })

  it('draws a side-face operation, its face frame and its anchor in the part frame', async () => {
    const s = await designSetup()
    // a pocket in the right side (+x): u = +Y, v = +Z, origin (L, 0, −T) = (100, 0, −20)
    await s.run('design.pocket.add', {
      partId: s.partId,
      on: 'stock.side[1]',
      shape: {
        kind: 'rectangle',
        center: ['10', '5'],
        length: '20',
        width: '6',
        cornerRadius: '0',
      },
      anchor: { u: 'min', v: 'min' },
      depth: '4',
    })
    const part = designPart(s.d.doc)!
    const op = part.loaded!.part.operations[0]!
    const [top, floor] = operationOutline(op, part.loaded!.stock, part.table!)
    expect(top!.every((p) => p[0] === 100)).toBe(true)
    expect(floor!.every((p) => p[0] === 96)).toBe(true)
    // min/min anchor at (u 10, v 5): the loop spans y 10..30, z −15..−9
    expect(Math.min(...top!.map((p) => p[1]))).toBeCloseTo(10)
    expect(Math.max(...top!.map((p) => p[1]))).toBeCloseTo(30)
    expect(Math.min(...top!.map((p) => p[2]))).toBeCloseTo(-15)
    expect(Math.max(...top!.map((p) => p[2]))).toBeCloseTo(-9)
    expect(frameAxes(op, part.loaded!.stock, part.table!)).toEqual({
      origin: [100, 0, -20],
      u: [0, 1, 0],
      v: [0, 0, 1],
      n: [1, 0, 0],
      length: 12,
    })
    expect(anchorPoint(op, part.loaded!.stock, part.table!)).toEqual({
      at: [100, 10, -15],
      u: [0, 1, 0],
      v: [0, 0, 1],
    })
    expect(markerPoint(op, part.loaded!.stock, part.table!)).toEqual([100, 20, -12])
  })

  it('names the anchor points as seen from outside the face', () => {
    const name = designMessages.anchorPoint
    expect(name('+z', { u: 'min', v: 'min' })).toBe('Front left')
    expect(name('+z', { u: 'centre', v: 'centre' })).toBe('Centre')
    expect(name('+z', { u: 'max', v: 'centre' })).toBe('Centre right')
    expect(name('+z', { u: 'centre', v: 'max' })).toBe('Back centre')
    expect(name('-z', { u: 'min', v: 'min' })).toBe('Back left') // rolled over X
    expect(name('+x', { u: 'max', v: 'max' })).toBe('Top right')
  })

  it('places a new pocket or profile by the default anchor, in the same place', async () => {
    const s = await designSetup()
    const stock = { length: 100, width: 60, thickness: 20 }
    const args = addArgs('pocket', stock, 'mm', { u: 'min', v: 'max' })
    // centre (50, 30), size 33 × 20: the back-left corner is at (33.5, 40)
    expect(args).toMatchObject({
      shape: { center: ['33.5 mm', '40 mm'], length: '33 mm', width: '20 mm' },
      anchor: { u: 'min', v: 'max' },
    })
    await s.run('design.pocket.add', { partId: s.partId, ...args })
    const centred = designPart(s.d.doc)!
    expect(centred.dto.operations[0]).toMatchObject({ shape: { anchor: { u: 'min', v: 'max' } } })
    const op = centred.loaded!.part.operations[0]!
    expect(markerPoint(op, centred.loaded!.stock, centred.table!)).toEqual([50, 30, 0])
    expect(
      addArgs('profile', stock, 'inch', { u: 'max', v: 'min' })['shape'] as { center: string[] },
    ).toMatchObject({ center: ['3.5"', '0.625"'] })
  })

  it('the rectangle-to-circle toggle keeps the anchor point (A2 known issue)', async () => {
    const s = await designSetup()
    await s.run('design.pocket.add', {
      partId: s.partId,
      shape: { kind: 'rectangle', center: ['20', '10'], length: '40', width: '16' },
      anchor: { u: 'min', v: 'min' },
      depth: '4',
    })
    const before = designPart(s.d.doc)!.dto.operations[0]!
    if (before.kind !== 'pocket' || before.shape.kind === 'named')
      throw new Error('pocket expected')
    await s.run('design.pocket.update', {
      partId: s.partId,
      operationId: before.id,
      shape: shapeKindArgs(before.shape, 'circle'),
    })
    const part = designPart(s.d.doc)!
    const after = part.dto.operations[0]!
    // the anchor stays and its point stays: the circle sits in the same front-left corner
    expect(after).toMatchObject({
      shape: {
        kind: 'circle',
        anchor: { u: 'min', v: 'min' },
        center: [{ source: '20' }, { source: '10' }],
        diameter: { source: '16' },
      },
    })
    const op = part.loaded!.part.operations[0]!
    expect(anchorPoint(op, part.loaded!.stock, part.table!)!.at).toEqual([20, 10, 0])
    const [loop] = operationOutline(op, part.loaded!.stock, part.table!)
    expect(Math.min(...loop!.map((p) => p[0]))).toBeCloseTo(20)
    expect(Math.min(...loop!.map((p) => p[1]))).toBeCloseTo(10)
  })

  it('draws the live outline at the operation top and floor, and anchors the error marker', async () => {
    const { part } = await bracket()
    const ops = part.loaded!.part.operations
    const [top, floor] = operationOutline(ops[1]!, part.loaded!.stock, part.table!)
    expect(top!.every((p) => p[2] === -0.5)).toBe(true) // on facing1.floor
    expect(floor!.every((p) => p[2] === -8.5))
    expect(Math.min(...top!.map((p) => p[0]))).toBeCloseTo(30)
    expect(markerPoint(ops[2]!, part.loaded!.stock, part.table!)).toEqual([10, 10, -0.5])
    const drill = ops[2]!
    if (drill.kind !== 'drilling') throw new Error('drill1 expected')
    const anchor = { u: 'min', v: 'min' } as const
    const circle = shapeLoop(
      { kind: 'circle', center: drill.center, anchor, diameter: drill.diameter },
      0,
    )
    expect(circle).toHaveLength(48)
    // `center` is the anchor point: a min/min circle lies up and right of it
    expect(Math.min(...circle.map((p) => p[0]))).toBeCloseTo(drill.center[0].canonical)
    expect(Math.min(...circle.map((p) => p[1]))).toBeCloseTo(drill.center[1].canonical)
    expect(
      failingOperation({ issues: [], frames: [{ data: { operation: 'pocket1' } }] }, [
        'facing1',
        'pocket1',
      ]),
    ).toBe('pocket1')
  })
})
