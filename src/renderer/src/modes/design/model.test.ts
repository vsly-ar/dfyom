// Design mode's pure view of the document: update args of one field edit, new-operation
// defaults, surface choices and labels, the live outline and the error anchor.
// Doc: docs/modes/design.md#commands-and-queries-v01
import { describe, expect, it } from 'vitest'
import { designSetup } from '../../../../core/design/design.fixture'
import {
  addArgs,
  designPart,
  failingOperation,
  roundLength,
  surfaceChoices,
  updateArgs,
} from './model'
import { operationAnchor, operationOutline, shapeLoop } from './outline'

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

  it('offers the surfaces of the stock and earlier operations, by name', async () => {
    const { part } = await bracket()
    expect(surfaceChoices(part.dto, part.table!, 2, true)).toEqual([
      { id: 'stock.top', label: 'Stock top' },
      { id: 'facing1.floor', label: 'Facing 1 floor' },
      { id: 'pocket1.floor', label: 'Pocket 1 floor' },
    ])
    expect(surfaceChoices(part.dto, part.table!, 1, false).map((c) => c.id)).toEqual([
      'stock.top',
      'stock.bottom',
      'facing1.floor',
    ])
  })

  it('draws the live outline at the operation top and floor, and anchors the error marker', async () => {
    const { part } = await bracket()
    const ops = part.loaded!.part.operations
    const [top, floor] = operationOutline(ops[1]!, part.loaded!.stock, part.table!)
    expect(top!.every((p) => p[2] === -0.5)).toBe(true) // on facing1.floor
    expect(floor!.every((p) => p[2] === -8.5))
    expect(Math.min(...top!.map((p) => p[0]))).toBeCloseTo(30)
    expect(operationAnchor(ops[2]!, part.loaded!.stock, part.table!)).toEqual([10, 10, -0.5])
    const drill = ops[2]!
    if (drill.kind !== 'drilling') throw new Error('drill1 expected')
    const circle = shapeLoop({ kind: 'circle', center: drill.center, diameter: drill.diameter }, 0)
    expect(circle).toHaveLength(48)
    expect(
      failingOperation({ issues: [], frames: [{ data: { operation: 'pocket1' } }] }, [
        'facing1',
        'pocket1',
      ]),
    ).toBe('pocket1')
  })
})
