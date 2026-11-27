// The in-process stock (hardening DF135, cut-state slice C5): the material left after the plan's
// already-cut operations, drawn by the run layer in the part frame as a translucent neutral solid
// (`--vp-stock`) around the opaque part, so the part shows through and the material the next cut
// meets reads as a quiet haze; never picked, no depth write, offset towards the camera so its
// faces on the part's own surfaces do not fight them. Props only.
// Doc: docs/modes/cut-state.md#in-process-stock-display-c5, docs/conventions/ui.md#plan-mode-task-37
import { useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { BufferAttribute, BufferGeometry, Color, SRGBColorSpace } from 'three'
import type { InProcessStockMesh } from '../../../core/plan/in-process-stock'
import type { Palette } from './colours'

/** What the run layer draws for the in-process stock (`RunScene.inProcessStock`). */
export interface InProcessStockView {
  /** The solid in the part frame (mm). */
  readonly mesh: InProcessStockMesh
  /** How many already-cut operations it removes (the view summary). */
  readonly operations: number
}

/** The solid's opacity: a haze over the part, not a wall in front of it. */
export const IN_PROCESS_OPACITY = 0.4

const noRaycast = (): void => {}

export function InProcessStockLayer({
  stock,
  palette,
}: {
  stock: InProcessStockView
  palette: Palette
}): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  const geometry = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(stock.mesh.positions, 3))
    g.setIndex(new BufferAttribute(stock.mesh.indices, 1))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    return g
  }, [stock.mesh])
  useEffect(() => {
    invalidate()
    return () => geometry.dispose()
  }, [geometry, invalidate])
  const colour = useMemo(() => {
    const c = palette.stock
    return new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)
  }, [palette])
  return (
    <mesh geometry={geometry} raycast={noRaycast} renderOrder={1}>
      <meshStandardMaterial
        color={colour}
        roughness={0.9}
        metalness={0}
        transparent
        opacity={IN_PROCESS_OPACITY}
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-1}
        polygonOffsetUnits={-2}
      />
    </mesh>
  )
}
