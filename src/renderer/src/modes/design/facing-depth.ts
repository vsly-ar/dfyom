// The facing depth down to the reference model (DF4), pure: each reference's box in the part frame
// (the ghost's triangles when the window has them, else the placed box) and core's suggestion for a
// facing's face. Doc: docs/modes/reference-model.md#facing-depth-from-the-reference-df4
import { meshBounds } from '../../../../core/design/mesh-section'
import {
  placedBox,
  suggestFacingDepth,
  type FacingDepthSuggestion,
  type ReferenceBox,
} from '../../../../core/design/reference'
import type { Box } from '../../../../core/design/stl'
import { DIRECTIONS, STOCK_FACE, type Direction } from '../../../../core/geometry/face'
import type { DesignPart } from './model'
import { ghostMatrix, referencePlacement } from './reference-view'
import type { DesignReference } from './useDesign'

/** Mesh boxes by positions array and matrix: a 1 M triangle mesh is read once per placement. */
const cache = new WeakMap<Float32Array, { key: string; box: Box | undefined }>()

function cachedMeshBounds(positions: Float32Array, matrix: readonly number[]): Box | undefined {
  const key = matrix.join(',')
  const hit = cache.get(positions)
  if (hit !== undefined && hit.key === key) return hit.box
  const box = meshBounds(positions, matrix)
  cache.set(positions, { key, box })
  return box
}

/** A reference's box in the part frame (mm); undefined if a stored placement value does not load. */
export function referenceBox(r: DesignReference): ReferenceBox | undefined {
  const p = referencePlacement(r.ref)
  if (p === undefined) return undefined
  const bounds = r.ref.asset.bounds
  if (r.mesh?.status === 'done') {
    const box = cachedMeshBounds(r.mesh.positions, ghostMatrix(bounds, p))
    if (box !== undefined) return { referenceId: r.ref.id, box }
  }
  return { referenceId: r.ref.id, box: placedBox(bounds, p) }
}

/** The direction of a stock face id (`stock.top` → `+z`); undefined for other surfaces. */
export function stockFaceDirection(on: string): Direction | undefined {
  return DIRECTIONS.find((d) => STOCK_FACE[d] === on)
}

/**
 * The depth a facing on the stock face `on` takes to face down to the part's references, as
 * core suggests it (project units, rounded down); undefined without a stock, a reference or a
 * sensible value.
 */
export function facingDepthSuggestion(
  part: DesignPart,
  references: readonly DesignReference[],
  on: string = STOCK_FACE['+z'],
): FacingDepthSuggestion | undefined {
  const stock = part.loaded?.stock
  const direction = stockFaceDirection(on)
  if (stock === undefined || direction === undefined || references.length === 0) return undefined
  const boxes = references.map(referenceBox).filter((b) => b !== undefined)
  return suggestFacingDepth(
    direction,
    {
      length: stock.length.canonical,
      width: stock.width.canonical,
      thickness: stock.thickness.canonical,
    },
    boxes,
    part.units,
  )
}
