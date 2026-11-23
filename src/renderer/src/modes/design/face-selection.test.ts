// Face selection (DF22): which clicks select a face, and where Add puts an operation on it.
// Doc: docs/conventions/ui.md#selection-and-picking
import { describe, expect, it } from 'vitest'
import { designSetup } from '../../../../core/design/design.fixture'
import {
  addTarget,
  clickedFace,
  faceAxesText,
  faceSelectionId,
  faceSurfaceOf,
  selectedFace,
} from './face-selection'
import { designPart } from './model'

async function part() {
  const s = await designSetup()
  await s.run('design.facing.add', { partId: s.partId, depth: '1' })
  await s.run('design.pocket.add', {
    partId: s.partId,
    shape: { kind: 'rectangle', center: ['50', '30'], length: '40', width: '20' },
    depth: '8',
  })
  return designPart(s.d.doc)!
}

describe('face selection', () => {
  it('keeps the face in the design selection as face:<surface>', () => {
    expect(faceSelectionId('stock.top')).toBe('face:stock.top')
    expect(faceSurfaceOf('face:pocket1.floor')).toBe('pocket1.floor')
    expect(faceSurfaceOf('pocket1')).toBeUndefined()
    expect(faceSurfaceOf(null)).toBeUndefined()
  })

  it('a click on a stock face selects it; Alt+click selects a floor; walls never', async () => {
    const p = await part()
    expect(clickedFace(p, 'stock.side[1]', false)).toMatchObject({
      id: 'stock.side[1]',
      label: 'Stock right side',
      direction: '+x',
      stockFace: true,
    })
    expect(clickedFace(p, 'pocket1.floor', false)).toBeUndefined()
    expect(clickedFace(p, 'pocket1.floor', true)).toMatchObject({
      id: 'pocket1.floor',
      label: 'Pocket 1 floor',
      direction: '+z',
      faceZ: -9,
      stockFace: false,
    })
    expect(clickedFace(p, 'pocket1.wall[0]', true)).toBeUndefined()
    expect(selectedFace(p, 'face:stock.bottom')?.label).toBe('Stock bottom')
    expect(selectedFace(p, 'face:gone.floor')).toBeUndefined()
    expect(selectedFace(p, 'pocket1')).toBeUndefined()
  })

  it('Add on a face: pockets and drillings on it, facings and profiles on its stock face', async () => {
    const p = await part()
    const stock = { length: 100, width: 60, thickness: 20 }
    const floor = selectedFace(p, 'face:pocket1.floor')!
    expect(addTarget(floor, 'pocket', stock)).toEqual({
      on: 'pocket1.floor',
      room: { length: 100, width: 60, thickness: 11 },
    })
    expect(addTarget(floor, 'facing', stock).on).toBe('stock.top')
    const right = selectedFace(p, 'face:stock.side[1]')!
    // the right side: u along Y (width), v along Z (thickness), the length below it
    expect(addTarget(right, 'drilling', stock)).toEqual({
      on: 'stock.side[1]',
      room: { length: 60, width: 20, thickness: 100 },
    })
    expect(addTarget(right, 'profile', stock).on).toBe('stock.side[1]')
  })

  it('names the face frame axes in part-frame terms', () => {
    expect(faceAxesText('+z')).toEqual({ u: '+X', v: '+Y' })
    expect(faceAxesText('-z')).toEqual({ u: '+X', v: '−Y' })
    expect(faceAxesText('-x')).toEqual({ u: '−Y', v: '+Z' })
  })
})
