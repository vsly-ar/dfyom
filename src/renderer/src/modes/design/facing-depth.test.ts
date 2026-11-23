// The facing depth down to the reference (DF4) as the window computes it: the ghost's triangles
// when loaded (exact for free angles), else the placed box; only stock faces.
// Spec: docs/modes/reference-model.md#facing-depth-from-the-reference-df4
import { describe, expect, it } from 'vitest'
import { fieldContext, type FieldKind } from '../../../../core/design/operation'
import type { ReferenceDTO } from '../../../../core/design/reference.dto'
import { Quantity } from '../../../../core/quantity/quantity'
import type { ReferenceMeshEntry } from '../../state/reference-meshes'
import { facingDepthSuggestion, referenceBox, stockFaceDirection } from './facing-depth'
import type { DesignPart } from './model'
import type { DesignReference } from './useDesign'

const q = (source: string, kind: FieldKind) =>
  Quantity.parse(source, fieldContext(kind, 'mm')).unwrap().toDTO()
const mm = (v: number) => Quantity.parse(`${v} mm`, fieldContext('length', 'mm')).unwrap()

/** A 20 × 20 base, apex 10 above its middle: its box is smaller than the placed box when tilted. */
const PYRAMID = Float32Array.from(
  [
    [0, 0, 0, 20, 20, 0, 20, 0, 0],
    [0, 0, 0, 0, 20, 0, 20, 20, 0],
    [0, 0, 0, 20, 0, 0, 10, 10, 10],
    [20, 0, 0, 20, 20, 0, 10, 10, 10],
    [20, 20, 0, 0, 20, 0, 10, 10, 10],
    [0, 20, 0, 0, 0, 0, 10, 10, 10],
  ].flat(),
)

function reference(rotationX: string, positionZ: string): ReferenceDTO {
  return {
    id: 'reference1',
    partId: 'part1',
    name: 'pyramid',
    asset: {
      path: `assets/${'a'.repeat(64)}.stl`,
      sha256: 'a'.repeat(64),
      format: 'stl',
      triangles: 6,
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
    },
    sourceUnit: 'mm',
    scale: q('1', 'scalar'),
    rotation: { x: q(rotationX, 'angle'), y: q('0°', 'angle'), z: q('0°', 'angle') },
    position: { x: q('40 mm', 'length'), y: q('20 mm', 'length'), z: q(positionZ, 'length') },
  } as ReferenceDTO
}

const part = {
  units: 'mm',
  loaded: { stock: { length: mm(100), width: mm(60), thickness: mm(20) } },
} as unknown as DesignPart

const view = (ref: ReferenceDTO, mesh: ReferenceMeshEntry | undefined): DesignReference => ({
  ref,
  visible: true,
  mesh,
})
const done: ReferenceMeshEntry = { status: 'done', positions: PYRAMID, edges: new Float32Array(0) }

describe('facingDepthSuggestion', () => {
  it('measures to the placed box until the mesh is read, then to the triangles', () => {
    // tilted 45° about X: the placed box is 21.213 tall, the pyramid itself 14.142; the placed
    // box's top sits 0.5 under the stock top
    const ref = reference('45°', '-21.71321 mm')
    expect(facingDepthSuggestion(part, [view(ref, { status: 'loading' })])?.source).toBe('0.5 mm')
    expect(facingDepthSuggestion(part, [view(ref, done)])?.source).toBe('7.571 mm')
    // quarter turns: the box is exact, so both agree
    const flat = reference('0°', '-10.5 mm')
    expect(facingDepthSuggestion(part, [view(flat, undefined)])?.source).toBe('0.5 mm')
    expect(facingDepthSuggestion(part, [view(flat, done)])?.source).toBe('0.5 mm')
    expect(referenceBox(view(flat, done))?.box.max.z).toBeCloseTo(-0.5, 9)
  })

  it('follows the facing face and gives nothing without a stock face, stock or reference', () => {
    const flat = reference('0°', '-10.5 mm')
    // from the bottom (z = −20) up to the pyramid's base at −10.5
    expect(facingDepthSuggestion(part, [view(flat, done)], 'stock.bottom')?.source).toBe('9.5 mm')
    expect(facingDepthSuggestion(part, [view(flat, done)], 'facing1.floor')).toBeUndefined()
    expect(facingDepthSuggestion(part, [])).toBeUndefined()
    const noStock = { units: 'mm', loaded: undefined } as unknown as DesignPart
    expect(facingDepthSuggestion(noStock, [view(flat, done)])).toBeUndefined()
    expect(stockFaceDirection('stock.side[1]')).toBe('+x')
  })
})
