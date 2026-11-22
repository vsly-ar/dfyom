// A reference model's ghost (task R3): the STL's triangles drawn translucent and neutral after the
// part (`--vp-stock` at low opacity, `--vp-edge` feature edges found by the worker, U3), placed by
// a matrix the caller computes (R2's placed-box convention), never pickable: clicks pass through
// to the part (the measure tool raycasts it on purpose, `userData.measure`). One geometry per
// mesh: placement edits only change the matrix. Fades in when it appears.
// Doc: docs/conventions/ui.md#reference-ghost-v02, docs/modes/reference-model.md#display
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix4,
  SRGBColorSpace,
  type LineBasicMaterial,
  type MeshStandardMaterial,
} from 'three'
import type { Rgb } from './colours'

/** A reference as the viewport draws it. */
export interface ReferenceGhostView {
  readonly id: string
  /** 9 float32 per triangle, source units (the STL as read). */
  readonly positions: Float32Array
  /** Feature edges (6 float32 per segment, source units), found by the worker (U3). */
  readonly edges: Float32Array
  /** Column-major 4 × 4 model matrix: source units → part frame (mm). */
  readonly matrix: readonly number[]
}

/** Opacity of the ghost's faces and edges (translucent: the part and stock stay readable). */
export const GHOST_OPACITY = { faces: 0.2, edges: 0.45 } as const
/** `--motion-slow` (tokens.css): the ghost fades in. */
const FADE_MS = 320

const noRaycast = (): void => {}

const colour = (c: Rgb) => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)

export function ReferenceGhost({
  ghost,
  faceColour,
  edgeColour,
  reducedMotion,
}: {
  ghost: ReferenceGhostView
  faceColour: Rgb
  edgeColour: Rgb
  reducedMotion: boolean
}): React.JSX.Element {
  const invalidate = useThree((s) => s.invalidate)
  const { positions, edges: edgePositions } = ghost
  const geometry = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(positions, 3))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    return g
  }, [positions])
  useEffect(() => () => geometry.dispose(), [geometry])
  const edges = useMemo(() => {
    if (edgePositions.length === 0) return null
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(edgePositions, 3))
    return g
  }, [edgePositions])
  useEffect(() => () => edges?.dispose(), [edges])

  const matrix = useMemo(() => new Matrix4().fromArray([...ghost.matrix]), [ghost.matrix])
  useEffect(() => invalidate(), [matrix, invalidate])

  const faces = useRef<MeshStandardMaterial>(null)
  const lines = useRef<LineBasicMaterial>(null)
  const start = useRef<number | null>(null)
  useFrame(({ clock }) => {
    const now = clock.getElapsedTime() * 1000
    start.current ??= now
    const t = reducedMotion ? 1 : Math.min(1, (now - start.current) / FADE_MS)
    const k = 1 - (1 - t) ** 3 // ease out
    if (faces.current) faces.current.opacity = GHOST_OPACITY.faces * k
    if (lines.current) lines.current.opacity = GHOST_OPACITY.edges * k
    if (t < 1) invalidate()
  })

  const face = useMemo(() => colour(faceColour), [faceColour])
  const edge = useMemo(() => colour(edgeColour), [edgeColour])

  return (
    <group matrixAutoUpdate={false} matrix={matrix}>
      <mesh
        geometry={geometry}
        raycast={noRaycast}
        renderOrder={4}
        userData={{ measure: 'reference' }}
      >
        <meshStandardMaterial
          ref={faces}
          color={face}
          transparent
          opacity={reducedMotion ? GHOST_OPACITY.faces : 0}
          depthWrite={false}
          roughness={0.9}
          metalness={0}
        />
      </mesh>
      {edges ? (
        <lineSegments geometry={edges} raycast={noRaycast} renderOrder={5}>
          <lineBasicMaterial
            ref={lines}
            color={edge}
            transparent
            opacity={reducedMotion ? GHOST_OPACITY.edges : 0}
            depthWrite={false}
          />
        </lineSegments>
      ) : null}
    </group>
  )
}
